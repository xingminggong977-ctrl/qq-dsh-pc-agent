/**
 * 测试用的临时目录：一律开在 pc-agent/.tmp 下。
 * 刻意不用 os.tmpdir()——那是 AppData\Local\Temp，正好命中策略里的硬拒目录 AppData，
 * 所有路径用例都会被拒，测不出东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PC_AGENT_DIR = path.resolve(HERE, '..', '..');
export const TMP_ROOT = path.join(PC_AGENT_DIR, '.tmp');

let counter = 0;

export function makeTempDir(label = 'case') {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  counter += 1;
  const dir = path.join(TMP_ROOT, `${label}-${process.pid}-${counter}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 建一个目录联接（Windows 上普通用户也能建，符号链接则要管理员或开发者模式）。 */
export function makeJunction(linkPath, targetPath) {
  fs.symlinkSync(targetPath, linkPath, 'junction');
  return linkPath;
}

export function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}
