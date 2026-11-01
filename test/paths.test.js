/**
 * 路径判定的用例：`..` 逃逸、符号链接逃逸、硬拒目录、write 的扩展名与 .git。
 * 每一条都是「不做就等于把钥匙交出去」的点。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { canonicalPath, checkPath, findDeniedSegment, withinRoots } from '../src/paths.js';
import { makeJunction, makeTempDir, removeTempDir, writeFile } from './helpers/tmp.js';

const created = [];

function tempDir(label) {
  const dir = makeTempDir(label);
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) removeTempDir(dir);
});

function expectDenied(fn, code = 'path_denied') {
  assert.throws(fn, (error) => {
    assert.equal(error.errorCode, code, `期望 ${code}，实际 ${error.errorCode}：${error.message}`);
    return true;
  });
}

describe('paths · roots 边界', () => {
  it('root 内的文件通过，返回解链后的真实路径', () => {
    const root = tempDir('inside');
    const file = writeFile(path.join(root, 'sub', 'a.txt'), 'hi');
    const real = checkPath(file, { roots: [root] });
    assert.equal(real.toLowerCase(), fs.realpathSync.native(file).toLowerCase());
  });

  it('.. 逃逸被拒', () => {
    const root = tempDir('dotdot');
    const escape = path.join(root, '..', '..', 'Windows', 'win.ini');
    expectDenied(() => checkPath(escape, { roots: [root] }));
  });

  it('root 内写 .. 反向逃逸也被拒', () => {
    const root = tempDir('dotdot2');
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    // 拼字符串而不是 path.join：join 会把 .. 折叠掉，测不到解析器
    expectDenied(() => checkPath(`${sub}\\..\\..`, { roots: [sub], mode: 'cwd' }));
  });

  it('符号链接逃逸被拒（junction 指向 root 外）', () => {
    const base = tempDir('link');
    const inside = path.join(base, 'inside');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(inside);
    writeFile(path.join(outside, 'secret.txt'), 'top');
    makeJunction(path.join(inside, 'escape'), outside);

    expectDenied(() => checkPath(path.join(inside, 'escape', 'secret.txt'), { roots: [inside] }));
  });

  it('`link\\..` 弹的是链接的真实父目录，不是字面父目录', () => {
    const base = tempDir('linkdotdot');
    const inside = path.join(base, 'inside');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(inside);
    fs.mkdirSync(outside);
    writeFile(path.join(base, 'secret.txt'), 'top');
    makeJunction(path.join(inside, 'link'), outside);

    // 字面看是 inside\secret.txt，真实解析后是 base\secret.txt（join 会折叠 ..，所以手拼）
    expectDenied(() => checkPath(`${inside}\\link\\..\\secret.txt`, { roots: [inside] }));
  });

  it('大小写不敏感', () => {
    const root = tempDir('case');
    const file = writeFile(path.join(root, 'MiXeD', 'File.TXT'), 'x');
    assert.ok(checkPath(file.toUpperCase(), { roots: [root] }));
    assert.ok(checkPath(file.toLowerCase(), { roots: [root] }));
  });

  it('正斜杠与重复分隔符都归一', () => {
    const root = tempDir('slash');
    const file = writeFile(path.join(root, 'a', 'b.txt'), 'x');
    assert.ok(checkPath(file.replace(/\\/g, '/'), { roots: [root] }));
    assert.ok(checkPath(file.replace(/\\/g, '\\\\'), { roots: [root] }));
  });

  it('兄弟目录前缀不算在 root 内（C:\\x\\a 不在 C:\\x\\ab 里）', () => {
    const base = tempDir('prefix');
    const root = path.join(base, 'ab');
    assert.equal(withinRoots(base, [root]), false);
    assert.equal(withinRoots(root, [root]), true);
  });
});

describe('paths · 硬拒目录', () => {
  for (const name of ['.ssh', '.dsh', '.gnupg', '.aws', '.azure', '.git-credentials', '.npmrc', '.netrc', 'AppData', '.config']) {
    it(`root 内的 ${name} 也拒`, () => {
      const root = tempDir('deny');
      const file = writeFile(path.join(root, name, 'a.txt'), 'x');
      expectDenied(() => checkPath(file, { roots: [root] }));
    });
  }

  it('经符号链接进到 .ssh 仍然命中（realpath 先于判定）', () => {
    const base = tempDir('denylink');
    const inside = path.join(base, 'inside');
    fs.mkdirSync(inside);
    const keys = writeFile(path.join(base, 'real', '.ssh', 'id_rsa'), 'PRIVATE');
    makeJunction(path.join(inside, 'alias'), path.join(base, 'real', '.ssh'));

    expectDenied(() => checkPath(path.join(inside, 'alias', 'id_rsa'), { roots: [base] }));
    assert.equal(findDeniedSegment(fs.realpathSync.native(path.dirname(keys))), '.ssh');
  });

  it('大小写不同的 APPData 也拒', () => {
    const root = tempDir('denycase');
    const file = writeFile(path.join(root, 'APPDATA', 'a.txt'), 'x');
    expectDenied(() => checkPath(file, { roots: [root] }));
  });
});

describe('paths · write 额外规则', () => {
  for (const ext of ['.exe', '.dll', '.bat', '.ps1', '.cmd', '.msi']) {
    it(`write 拒 ${ext}`, () => {
      const root = tempDir('writeext');
      expectDenied(() => checkPath(path.join(root, `x${ext}`), { roots: [root], mode: 'write' }));
    });
  }

  it('write 拒 .EXE（大小写不敏感）', () => {
    const root = tempDir('writeext2');
    expectDenied(() => checkPath(path.join(root, 'x.EXE'), { roots: [root], mode: 'write' }));
  });

  it('write 拒 .git 目录内的文件，读却允许', () => {
    const root = tempDir('gitdir');
    const file = writeFile(path.join(root, '.git', 'config'), 'x');
    expectDenied(() => checkPath(file, { roots: [root], mode: 'write' }));
    assert.ok(checkPath(file, { roots: [root], mode: 'read' }));
  });

  it('write 允许普通文本，连不存在的尾巴一起通过', () => {
    const root = tempDir('writenew');
    const target = path.join(root, 'new', 'note.md');
    const real = checkPath(target, { roots: [root], mode: 'write' });
    assert.ok(real.toLowerCase().endsWith(path.join('new', 'note.md').toLowerCase()));
  });
});

describe('paths · 畸形输入', () => {
  it('UNC 与网络路径直接拒', () => {
    expectDenied(() => checkPath('\\\\server\\share\\a.txt', { roots: ['C:\\'] }));
    expectDenied(() => checkPath('\\\\.\\pipe\\x', { roots: ['C:\\'] }));
  });

  it('相对路径、空路径、非字符串都拒', () => {
    const root = tempDir('bad');
    expectDenied(() => checkPath('docs\\a.txt', { roots: [root] }));
    expectDenied(() => checkPath('', { roots: [root] }));
    expectDenied(() => checkPath(null, { roots: [root] }));
  });

  it('cwd 必须是存在的目录', () => {
    const root = tempDir('cwd');
    const file = writeFile(path.join(root, 'f.txt'), 'x');
    expectDenied(() => checkPath(file, { roots: [root], mode: 'cwd' }));
    expectDenied(() => checkPath(path.join(root, 'nope'), { roots: [root], mode: 'cwd' }));
    assert.ok(checkPath(root, { roots: [root], mode: 'cwd' }));
  });
});

describe('paths · canonicalPath', () => {
  it('去尾分隔符、分隔符归一、小写', () => {
    assert.equal(canonicalPath('C:\\Users\\X\\'), 'c:\\users\\x');
    assert.equal(canonicalPath('C:/Users//X'), 'c:\\users\\x');
    assert.equal(canonicalPath('C:\\'), 'c:\\');
  });
});
