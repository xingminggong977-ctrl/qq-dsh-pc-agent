/**
 * read / write 两个 kind 的用例：路径策略在文件层同样生效，写文件额外挡可执行文件与 .git。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { readFileBody, writeFileBody } from '../src/files.js';
import { makeTempDir, removeTempDir } from './helpers/tmp.js';

const created = [];

function tempDir(label) {
  const dir = makeTempDir(label);
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) removeTempDir(dir);
});

describe('files · read', () => {
  it('读普通文本', () => {
    const dir = tempDir('read');
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello 世界');
    const result = readFileBody({ path: file }, { roots: [dir] });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'hello 世界');
    assert.equal(result.truncated, false);
    assert.equal(result.bytes, Buffer.byteLength('hello 世界'));
  });

  it('maxBytes 截断并置 truncated', () => {
    const dir = tempDir('readtrim');
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x'.repeat(500));
    const result = readFileBody({ path: file, maxBytes: 100 }, { roots: [dir] });
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.stdout.length, 100);
  });

  it('maxBytes 被夹在 1..64KB', () => {
    const dir = tempDir('readclamp');
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'y'.repeat(200 * 1024));
    const result = readFileBody({ path: file, maxBytes: 10 * 1024 * 1024 }, { roots: [dir] });
    assert.equal(result.bytes, 64 * 1024);
    assert.equal(result.truncated, true);
  });

  it('文件不存在判 internal，别把 ENOENT 原样甩出去', () => {
    const dir = tempDir('readgone');
    const result = readFileBody({ path: path.join(dir, 'nope.txt') }, { roots: [dir] });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'internal');
    assert.match(result.error, /文件不存在/);
  });

  it('目录读不了', () => {
    const dir = tempDir('readdir');
    const result = readFileBody({ path: dir }, { roots: [dir] });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'internal');
  });

  it('root 外与硬拒目录都判 path_denied', () => {
    const dir = tempDir('readdeny');
    fs.mkdirSync(path.join(dir, '.ssh'));
    fs.writeFileSync(path.join(dir, '.ssh', 'id_rsa'), 'PRIVATE');
    assert.equal(readFileBody({ path: 'C:\\Windows\\win.ini' }, { roots: [dir] }).errorCode, 'path_denied');
    assert.equal(readFileBody({ path: path.join(dir, '.ssh', 'id_rsa') }, { roots: [dir] }).errorCode, 'path_denied');
  });
});

describe('files · write', () => {
  it('新建文件', () => {
    const dir = tempDir('write');
    const file = path.join(dir, 'note.md');
    const result = writeFileBody({ path: file, content: '# 标题' }, { roots: [dir] });
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.readFileSync(file, 'utf8'), '# 标题');
    assert.equal(result.bytes, Buffer.byteLength('# 标题'));
  });

  it('append 为真时追加', () => {
    const dir = tempDir('append');
    const file = path.join(dir, 'log.txt');
    writeFileBody({ path: file, content: 'one\n' }, { roots: [dir] });
    writeFileBody({ path: file, content: 'two\n', append: true }, { roots: [dir] });
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\n');
  });

  it('默认覆盖而不是追加', () => {
    const dir = tempDir('overwrite');
    const file = path.join(dir, 'log.txt');
    writeFileBody({ path: file, content: 'one' }, { roots: [dir] });
    writeFileBody({ path: file, content: 'two' }, { roots: [dir] });
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  });

  it('超过 1MB 判 too_large 且不落盘', () => {
    const dir = tempDir('toolarge');
    const file = path.join(dir, 'big.txt');
    const result = writeFileBody({ path: file, content: 'x'.repeat(1024 * 1024 + 1) }, { roots: [dir] });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'too_large');
    assert.equal(fs.existsSync(file), false);
  });

  it('可执行文件与 .git 都拒', () => {
    const dir = tempDir('writedeny');
    for (const name of ['a.exe', 'a.dll', 'a.bat', 'a.ps1', 'a.cmd', 'a.msi', '.git\\config']) {
      const result = writeFileBody({ path: path.join(dir, name), content: 'x' }, { roots: [dir] });
      assert.equal(result.ok, false, name);
      assert.equal(result.errorCode, 'path_denied', name);
    }
  });

  it('root 外拒', () => {
    const dir = tempDir('writeout');
    const result = writeFileBody({ path: 'C:\\Windows\\Temp\\x.txt', content: 'x' }, { roots: [dir] });
    assert.equal(result.errorCode, 'path_denied');
  });

  it('上级目录不存在就报错，不替调用方造目录', () => {
    const dir = tempDir('writenoparent');
    const result = writeFileBody({ path: path.join(dir, 'deep', 'a.txt'), content: 'x' }, { roots: [dir] });
    assert.equal(result.ok, false);
    assert.match(result.error, /上级目录不存在/);
    assert.equal(fs.existsSync(path.join(dir, 'deep')), false);
  });

  it('content 不是字符串判 internal', () => {
    const dir = tempDir('writebad');
    const result = writeFileBody({ path: path.join(dir, 'a.txt'), content: 42 }, { roots: [dir] });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'internal');
  });

  it('目标是目录时报错', () => {
    const dir = tempDir('writedir');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    const result = writeFileBody({ path: sub, content: 'x' }, { roots: [dir] });
    assert.equal(result.ok, false);
    assert.match(result.error, /这是个目录/);
  });
});
