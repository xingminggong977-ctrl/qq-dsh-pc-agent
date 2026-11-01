/**
 * 路径判定（协议 §3）：先解开符号链接，再判 roots，再判硬拒规则，三者任一不过都拒。
 *
 * 关键点：`..` 不按字面折叠。手工逐段走，每段若真实存在就立刻 realpath，
 * 于是 `root\link\..` 里 link 若是指向外面的 junction，`..` 弹的是它真正的父目录
 * （fail-closed 方向），而不是字面上的 root。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ROOTS,
  HARD_DENY_SEGMENTS,
  PolicyError,
  WRITE_DENY_EXTENSIONS,
  WRITE_DENY_SEGMENTS,
} from './policy.js';

/** 比较用的规范形：分隔符归一、去尾分隔符、小写。 */
export function canonicalPath(input) {
  let value = String(input).trim().replace(/\//g, '\\');
  if (!value.startsWith('\\\\')) value = value.replace(/\\{2,}/g, '\\');
  if (value.length > 3 && value.endsWith('\\')) value = value.slice(0, -1);
  return value.toLowerCase();
}

/** 逐段 realpath；不存在的尾巴保持字面（write 要新建文件时走这条）。 */
export function resolveRealSync(target, { fsImpl = fs } = {}) {
  const realpath = (candidate) =>
    typeof fsImpl.realpathSync.native === 'function'
      ? fsImpl.realpathSync.native(candidate)
      : fsImpl.realpathSync(candidate);

  const parts = String(target).split(/[\\/]+/);
  let cursor = `${parts[0]}\\`;
  for (const part of parts.slice(1)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      cursor = path.dirname(cursor);
      continue;
    }
    const next = path.join(cursor, part);
    try {
      cursor = realpath(next);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      cursor = next;
    }
  }
  return cursor;
}

/** real 是否落在某个 root 内（大小写不敏感、root 自身也算）。 */
export function withinRoots(real, roots = DEFAULT_ROOTS) {
  const candidate = canonicalPath(real);
  return roots.some((root) => {
    const base = canonicalPath(root);
    return candidate === base || candidate.startsWith(`${base}\\`);
  });
}

/** 返回命中的硬拒目录名（小写），没命中返回 null。 */
export function findDeniedSegment(real, names = HARD_DENY_SEGMENTS) {
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  for (const segment of String(real).split(/[\\/]+/)) {
    if (blocked.has(segment.toLowerCase())) return segment;
  }
  return null;
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 判定一个路径能不能用。通过则返回解开符号链接后的真实路径。
 * mode: 'read' | 'write' | 'cwd'
 */
export function checkPath(target, { roots = DEFAULT_ROOTS, mode = 'read', fsImpl = fs } = {}) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new PolicyError('path_denied', '路径不能为空');
  }
  const raw = target.trim();
  if (raw.startsWith('\\\\')) {
    throw new PolicyError('path_denied', `不支持 UNC / 网络路径：${raw}`);
  }
  if (!path.isAbsolute(raw)) {
    throw new PolicyError('path_denied', `路径必须是绝对路径：${raw}`);
  }

  const real = resolveRealSync(raw, { fsImpl });

  if (!withinRoots(real, roots)) {
    throw new PolicyError('path_denied', `路径不在允许的根目录内：${real}`);
  }
  const denied = findDeniedSegment(real);
  if (denied !== null) {
    throw new PolicyError('path_denied', `这个目录不许碰：${denied}`);
  }

  if (mode === 'write') {
    const extension = path.extname(real).toLowerCase();
    if (WRITE_DENY_EXTENSIONS.includes(extension)) {
      throw new PolicyError('path_denied', `不许写 ${extension} 文件`);
    }
    const gitDir = findDeniedSegment(real, WRITE_DENY_SEGMENTS);
    if (gitDir !== null) {
      throw new PolicyError('path_denied', `.git 目录里的东西不许写：${gitDir}`);
    }
  }

  if (mode === 'cwd' && !isDirectory(real)) {
    throw new PolicyError('path_denied', `工作目录不存在或不是目录：${real}`);
  }

  return real;
}
