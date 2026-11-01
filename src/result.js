/**
 * 结果体的统一构造（协议 §1 `/node/pc/result`）。
 * ok/exitCode/stdout/stderr/truncated/bytes/durationMs/error/errorCode 一个都不能少。
 */
import { PolicyError } from './policy.js';

/** 允许的 errorCode（协议 §1）。 */
export const ERROR_CODES = Object.freeze([
  'not_allowlisted',
  'path_denied',
  'timeout',
  'spawn_failed',
  'too_large',
  'internal',
]);

export function successResult({ startedAt, stdout = '', stderr = '', truncated = false, bytes = 0, exitCode = null }) {
  return {
    ok: true,
    exitCode,
    stdout,
    stderr,
    truncated,
    bytes,
    durationMs: Math.max(0, Date.now() - startedAt),
    error: null,
    errorCode: null,
  };
}

export function failureResult(error, startedAt) {
  const errorCode = error instanceof PolicyError ? error.errorCode : 'internal';
  return {
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    truncated: false,
    bytes: 0,
    durationMs: Math.max(0, Date.now() - startedAt),
    error: error?.message ?? String(error),
    errorCode: ERROR_CODES.includes(errorCode) ? errorCode : 'internal',
  };
}

/** 把 fs 的错误翻成给人看的中文一句，别把 EACCES 原样甩给用户。 */
export function describeFsError(error, verb) {
  const code = error?.code;
  if (code === 'ENOENT') return `${verb}失败：文件不存在`;
  if (code === 'EACCES' || code === 'EPERM') return `${verb}失败：没有权限`;
  if (code === 'EBUSY') return `${verb}失败：文件被占用`;
  if (code === 'ENOSPC') return `${verb}失败：磁盘满了`;
  return `${verb}失败：${error?.message ?? String(error)}`;
}
