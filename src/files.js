/**
 * read / write 两个 kind（协议 §1）。路径全部先过 paths.checkPath。
 * 这里刻意不替调用方建目录：凭空造出目录树比报错更难善后。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ROOTS,
  PolicyError,
  READ_MAX_BYTES,
  WRITE_MAX_BYTES,
} from './policy.js';
import { checkPath } from './paths.js';
import { describeFsError, failureResult, successResult } from './result.js';

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

/** 读文件：只读前 maxBytes，超出置 truncated。 */
export function readFileBody(payload = {}, options = {}) {
  const { roots = DEFAULT_ROOTS, fsImpl = fs, limits = {} } = options;
  const startedAt = Date.now();
  const maxCap = limits.readMaxBytes ?? READ_MAX_BYTES;

  try {
    const target = checkPath(payload.path, { roots, mode: 'read', fsImpl });
    const stat = fsImpl.statSync(target);
    if (stat.isDirectory()) throw new PolicyError('internal', `这是个目录，读不了：${target}`);
    const maxBytes = clampInt(payload.maxBytes, 1, maxCap, maxCap);

    const fd = fsImpl.openSync(target, 'r');
    let buffer;
    try {
      const scratch = Buffer.alloc(maxBytes + 1);
      const read = fsImpl.readSync(fd, scratch, 0, maxBytes + 1, 0);
      buffer = scratch.subarray(0, read);
    } finally {
      fsImpl.closeSync(fd);
    }

    const truncated = buffer.length > maxBytes;
    const kept = truncated ? buffer.subarray(0, maxBytes) : buffer;
    return successResult({
      startedAt,
      stdout: kept.toString('utf8'),
      truncated,
      bytes: kept.length,
    });
  } catch (error) {
    if (error instanceof PolicyError) return failureResult(error, startedAt);
    return failureResult(new PolicyError('internal', describeFsError(error, '读')), startedAt);
  }
}

/** 写文件：content 超过 1MB 判 too_large；append 为真时追加。 */
export function writeFileBody(payload = {}, options = {}) {
  const { roots = DEFAULT_ROOTS, fsImpl = fs, limits = {} } = options;
  const startedAt = Date.now();
  const maxBytes = limits.writeMaxBytes ?? WRITE_MAX_BYTES;

  try {
    if (typeof payload.content !== 'string') {
      throw new PolicyError('internal', 'content 必须是字符串');
    }
    const target = checkPath(payload.path, { roots, mode: 'write', fsImpl });
    const buffer = Buffer.from(payload.content, 'utf8');
    if (buffer.length > maxBytes) {
      throw new PolicyError('too_large', `要写 ${buffer.length} 字节，超过 ${maxBytes} 字节的上限`);
    }
    const parent = path.dirname(target);
    if (!fsImpl.existsSync(parent)) {
      throw new PolicyError('internal', `上级目录不存在：${parent}`);
    }
    try {
      if (fsImpl.statSync(target).isDirectory()) {
        throw new PolicyError('internal', `这是个目录，写不了：${target}`);
      }
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }

    const append = payload.append === true;
    const fd = fsImpl.openSync(target, append ? 'a' : 'w');
    try {
      fsImpl.writeSync(fd, buffer, 0, buffer.length, null);
    } finally {
      fsImpl.closeSync(fd);
    }

    return successResult({ startedAt, stdout: '', bytes: buffer.length });
  } catch (error) {
    if (error instanceof PolicyError) return failureResult(error, startedAt);
    return failureResult(new PolicyError('internal', describeFsError(error, '写')), startedAt);
  }
}
