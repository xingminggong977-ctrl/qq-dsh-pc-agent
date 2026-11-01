/**
 * 命令执行层的用例：白名单、编排字符、高危参数、参数里的路径、超时杀树、输出截断。
 * 凡是「不该执行」的用例都断言 spawn 次数为 0——光看错误码不够，得证明进程压根没起来。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  assertArgPolicy,
  assertExecTokenPolicy,
  buildCommand,
  createCollector,
  createStreamCollector,
  detectPowershell,
  normalizeExe,
  resolveNpmCli,
  runCommand,
  tokenize,
} from '../src/exec.js';
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

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

/** 记录每次 spawn 的入参，命令什么时候「跑完」由用例自己决定。 */
function recordingSpawn(child = fakeChild()) {
  const calls = [];
  return {
    calls,
    child,
    impl(file, argv, options) {
      calls.push({ file, argv, options });
      return child;
    },
  };
}

/** 拒绝类用例共用：证明一次 spawn 都没发生。 */
async function expectRejected(command, { code = 'not_allowlisted', cwd, roots, extra = {} } = {}) {
  let spawned = 0;
  const dir = cwd ?? tempDir('reject');
  const result = await runCommand(
    { command, cwd: dir },
    {
      roots: roots ?? [dir],
      spawnImpl: () => {
        spawned += 1;
        return fakeChild();
      },
      ...extra,
    },
  );
  assert.equal(spawned, 0, `不该 spawn：${command}`);
  assert.equal(result.errorCode, code, `期望 ${code}，实际 ${result.errorCode}（${result.error}）：${command}`);
  assert.equal(result.ok, false);
  return result;
}

describe('exec · 白名单外命令', () => {
  for (const command of [
    'calc',
    'notepad',
    'curl http://example.com',
    'del a.txt',
    'rmdir /s /q .',
    'powershell -Command Get-Date',
    'cmd /c calc',
    'bash -c ls',
  ]) {
    it(`拒 ${command}`, async () => {
      await expectRejected(command);
    });
  }

  it('白名单比对不区分大小写，.exe 后缀也认', () => {
    assert.equal(normalizeExe('DIR.EXE'), 'dir');
    assert.equal(normalizeExe(' Where '), 'where');
  });
});

describe('exec · 编排字符与控制字符', () => {
  const cases = [
    ['dir & calc', '&'],
    ['dir | findstr a', '|'],
    ['dir > out.txt', '>'],
    ['type a.txt < b.txt', '<'],
    ['type a.txt; calc', ';'],
    ['dir ^& dir', '^'],
    ['dir `whoami`', '`'],
    ['dir $(whoami)', '$('],
    ['dir %~dp0', '%~'],
    ['dir\necho hi', '换行'],
  ];
  for (const [command, label] of cases) {
    it(`拒 ${label}：${JSON.stringify(command)}`, async () => {
      await expectRejected(command);
    });
  }

  it('引号不配对拒', async () => {
    await expectRejected('dir "unclosed');
    assert.throws(() => tokenize(`type "a.txt`), /引号没配对/);
  });

  it('正常引号里的空格不算编排', () => {
    assert.deepEqual(tokenize('type "my file.txt"'), ['type', 'my file.txt']);
  });
});

describe('exec · 高危参数', () => {
  for (const command of [
    'node -e "1"',
    'node --eval=1',
    'node -p 1',
    'node --print 1',
    'python -c "print(1)"',
    'python -cprint(1)',
    'python -m http.server',
    'python --eval 1',
    'py -c "1"',
    'git -c user.name=x status',
    'git --exec-path=C:\\x status',
    'git --upload-pack=x fetch',
    'git !rebase',
    'npm install',
    'npm run build',
    'npm i lodash',
  ]) {
    it(`拒 ${command}`, async () => {
      await expectRejected(command);
    });
  }

  it('npm 的 ls / view / --version 放行', () => {
    assert.doesNotThrow(() => assertArgPolicy('npm', ['ls']));
    assert.doesNotThrow(() => assertArgPolicy('npm', ['view', 'react']));
    assert.doesNotThrow(() => assertArgPolicy('npm', ['--version']));
    assert.throws(() => assertArgPolicy('npm', []), /npm 只允许/);
  });

  it('git 正常子命令放行', () => {
    assert.doesNotThrow(() => assertArgPolicy('git', ['status', '--short']));
  });
});

describe('exec · 参数里的路径与 glob', () => {
  it('类型命令的绝对路径出 root 就拒（type C:\\Windows\\win.ini）', async () => {
    const dir = tempDir('argpath');
    await expectRejected('type C:\\Windows\\win.ini', { code: 'path_denied', cwd: dir });
  });

  it('相对路径 .. 逃到 root 外也拒', async () => {
    const dir = tempDir('argpath2');
    await expectRejected('type ..\\..\\..\\Windows\\win.ini', { code: 'path_denied', cwd: dir });
  });

  it('内容类命令不许 glob（type .s*\\id_rsa 能绕开硬拒目录）', async () => {
    await expectRejected('type *.txt');
    await expectRejected('findstr /i x *.log');
  });

  it('dir 可以 glob，`dir` 指向硬拒目录仍然拒', async () => {
    const dir = tempDir('glob');
    fs.mkdirSync(path.join(dir, '.ssh'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    assert.doesNotThrow(() =>
      assertExecTokenPolicy({ exe: 'dir', kind: 'cmd', tokens: ['dir', '*.txt'], cwd: dir, roots: [dir] }),
    );
    assert.throws(
      () => assertExecTokenPolicy({ exe: 'dir', kind: 'cmd', tokens: ['dir', '.ssh'], cwd: dir, roots: [dir] }),
      /path_denied|不许碰/,
    );
  });

  it('解释器里不许变量展开', async () => {
    await expectRejected('type %USERPROFILE%\\a.txt');
    await expectRejected('Get-Content $env:USERPROFILE\\a.txt');
  });

  it('原生 exe 的路径参数同样过策略', async () => {
    const dir = tempDir('argpath3');
    await expectRejected('git -C C:\\Windows status', { code: 'path_denied', cwd: dir });
  });
});

describe('exec · git 的仓库指针参数', () => {
  // --git-dir / --work-tree 能把仓库与工作区指到 roots 之外，
  // 等于绕过「write 不许碰 .git」：hooks/ 与 config 一旦可写，下一次 git 调用就能跑出边界。
  for (const command of [
    'git --git-dir=C:\\x\\.git status',
    'git --git-dir C:\\x\\.git status',
    'git --GIT-DIR=C:\\x\\.git status',
    'git --work-tree=C:\\x status',
    'git --work-tree C:\\x status',
  ]) {
    it(`拒 ${command}`, async () => {
      const result = await expectRejected(command);
      assert.match(result.error, /git-dir|work-tree|not_allowlisted|不许用/);
    });
  }

  it('--git-dir 落在 roots 内也拒（拦的是参数本身，不是路径）', async () => {
    const dir = tempDir('gitdir');
    fs.mkdirSync(path.join(dir, '.git'));
    await expectRejected('git --git-dir=.git status', { cwd: dir, roots: [dir] });
  });

  it('git -C <roots 外> 显式用例：path_denied', async () => {
    const dir = tempDir('gitC');
    const result = await expectRejected('git -C C:\\Windows status', { code: 'path_denied', cwd: dir });
    assert.equal(result.ok, false);
  });

  it('git -C <roots 内> 没被一刀切，仍然放行', () => {
    const dir = tempDir('gitC2');
    assert.doesNotThrow(() =>
      assertExecTokenPolicy({
        exe: 'git',
        kind: 'native',
        tokens: ['git', '-C', dir, 'status'],
        cwd: dir,
        roots: [dir],
      }),
    );
  });
});

describe('exec · 组装 spawn 计划', () => {
  it('真 exe 直接 spawn，永不 shell:true', async () => {
    const dir = tempDir('plan');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const rec = recordingSpawn();
    const promise = runCommand({ command: 'where node', cwd: dir }, { roots: [dir], spawnImpl: rec.impl });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rec.calls.length, 1);
    const call = rec.calls[0];
    assert.equal(call.file, 'where');
    assert.deepEqual(call.argv, ['node']);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd.toLowerCase(), fs.realpathSync.native(dir).toLowerCase());
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    rec.child.stdout.emit('data', Buffer.from('C:\\Program Files\\nodejs\\node.exe\r\n'));
    rec.child.emit('close', 0);
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /node\.exe/);
    assert.equal(result.errorCode, null);
  });

  it('cmd 内建走 cmd.exe /d /s /c，命令行由我们自己重建', async () => {
    const dir = tempDir('plancmd');
    fs.mkdirSync(path.join(dir, 'sub'));
    const rec = recordingSpawn();
    const promise = runCommand({ command: 'dir /b sub', cwd: dir }, { roots: [dir], spawnImpl: rec.impl });
    await new Promise((resolve) => setImmediate(resolve));
    const call = rec.calls[0];
    assert.match(call.file, /cmd\.exe$/i);
    assert.deepEqual(call.argv.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(call.argv[3], 'dir /b sub');
    assert.equal(call.options.shell, false);
    rec.child.emit('close', 0);
    await promise;
  });

  it('带空格的文件名重新加引号', () => {
    const plan = buildCommand({
      exe: 'type',
      tokens: ['type', 'my file.txt'],
      args: ['my file.txt'],
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    });
    assert.equal(plan.argv[3], 'type "my file.txt"');
  });

  it('cmdlet 走 -NoProfile -NonInteractive -Command', () => {
    const plan = buildCommand({
      exe: 'get-date',
      tokens: ['get-date'],
      args: [],
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    });
    assert.deepEqual(plan.argv, ['-NoProfile', '-NonInteractive', '-Command', 'get-date']);
  });

  it('npm 转成 node + npm-cli.js（Windows 上只有 .cmd 垫片）', () => {
    const plan = buildCommand({
      exe: 'npm',
      tokens: ['npm', '--version'],
      args: ['--version'],
      env: { PATH: 'C:\\Program Files\\nodejs' },
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      fsImpl: { existsSync: (p) => p.toLowerCase() === 'c:\\program files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' },
    });
    assert.equal(plan.file, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(plan.argv, ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', '--version']);
  });

  it('找不到 npm-cli.js 时判 spawn_failed 而不是硬起 npm.cmd', () => {
    assert.throws(
      () =>
        buildCommand({
          exe: 'npm',
          tokens: ['npm', 'ls'],
          args: ['ls'],
          env: { PATH: 'C:\\nope' },
          execPath: 'C:\\nope\\node.exe',
          fsImpl: { existsSync: () => false },
        }),
      /npm/,
    );
  });

  it('resolveNpmCli 按 execPath 目录优先', () => {
    const cli = resolveNpmCli({
      env: { PATH: 'C:\\other' },
      execPath: 'C:\\nodejs\\node.exe',
      fsImpl: { existsSync: (p) => p === 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' },
    });
    assert.equal(cli, 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
    assert.equal(resolveNpmCli({ env: {}, execPath: 'C:\\x\\node.exe', fsImpl: { existsSync: () => false } }), null);
  });

  it('detectPowershell 优先 pwsh，退回系统 5.1', () => {
    assert.equal(
      detectPowershell({
        env: { PATH: 'C:\\pwsh;D:\\bin', SystemRoot: 'C:\\Windows' },
        fsImpl: { existsSync: (p) => p === path.join('C:\\pwsh', 'pwsh.exe') },
      }),
      path.join('C:\\pwsh', 'pwsh.exe'),
    );
    const fallback = path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.equal(
      detectPowershell({
        env: { PATH: 'D:\\bin', SystemRoot: 'C:\\Windows' },
        fsImpl: { existsSync: (p) => p === fallback },
      }),
      fallback,
    );
    assert.equal(
      detectPowershell({ env: { PATH: '', SystemRoot: 'C:\\Windows' }, fsImpl: { existsSync: () => false } }),
      'powershell.exe',
    );
  });
});

describe('exec · cwd', () => {
  it('cwd 不在 roots 内判 path_denied，且不 spawn', async () => {
    const dir = tempDir('cwdbad');
    await expectRejected('dir', { code: 'path_denied', cwd: 'C:\\Windows', roots: [dir] });
  });

  it('cwd 不存在判 path_denied', async () => {
    const dir = tempDir('cwdgone');
    await expectRejected('dir', { code: 'path_denied', cwd: path.join(dir, 'nope') });
  });
});

describe('exec · 真跑', () => {
  it('where node 真的跑通', async () => {
    const dir = tempDir('realwhere');
    const result = await runCommand({ command: 'where node', cwd: dir, timeoutMs: 20_000 }, { roots: [dir] });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.toLowerCase(), /node\.exe/);
  });

  it('dir /b 看得到本目录的文件', async () => {
    const dir = tempDir('realdir');
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'x');
    const result = await runCommand({ command: 'dir /b', cwd: dir, timeoutMs: 20_000 }, { roots: [dir] });
    assert.equal(result.ok, true, result.error);
    assert.match(result.stdout, /hello\.txt/);
  });

  it('退出码非 0 时 ok 为 false，但照样带回输出', async () => {
    const dir = tempDir('realexit');
    const result = await runCommand({ command: 'type missing-file.txt', cwd: dir, timeoutMs: 20_000 }, { roots: [dir] });
    assert.equal(result.ok, false);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.errorCode, null);
  });
});

describe('exec · 输出截断', () => {
  it('收集器只留最后 cap 字节，totalBytes 记真实总量', () => {
    const collector = createStreamCollector(100);
    collector.push(Buffer.alloc(600, 0x61));
    collector.push(Buffer.alloc(600, 0x62));
    const text = collector.text();
    assert.equal(Buffer.byteLength(text), 100);
    assert.equal(text, 'b'.repeat(100));
    assert.equal(collector.truncated, true);
    assert.equal(collector.totalBytes, 1200);
  });

  it('不超过 cap 时不置 truncated', () => {
    const collector = createStreamCollector(100);
    collector.push(Buffer.from('短文本'));
    assert.equal(collector.text(), '短文本');
    assert.equal(collector.truncated, false);
    assert.equal(collector.totalBytes, Buffer.byteLength('短文本'));
  });

  it('截断落在多字节字符中间时去掉续字节，不去出乱码', () => {
    const collector = createStreamCollector(4);
    collector.push(Buffer.from('中文'));
    const text = collector.text();
    assert.equal(collector.truncated, true);
    assert.ok(!text.startsWith('\ufffd'));
    assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text);
  });

  it('stdout 与 stderr 分开收，不串台', () => {
    const collector = createCollector(64);
    collector.pushStdout(Buffer.from('out'));
    collector.pushStderr(Buffer.from('err'));
    assert.deepEqual(collector.text(), { stdout: 'out', stderr: 'err' });
    assert.equal(collector.truncated, false);
  });

  it('真跑一条输出超过 32KB 的命令，结果被截断且留的是尾巴', async () => {
    const dir = tempDir('realbig');
    const line = '0123456789abcdef'.repeat(4);
    const body = `${line}\n`.repeat(4000); // ≈ 272KB
    fs.writeFileSync(path.join(dir, 'big.txt'), `${body}TAIL-MARKER\n`);
    const result = await runCommand({ command: 'type big.txt', cwd: dir, timeoutMs: 30_000 }, { roots: [dir] });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 32 * 1024);
    assert.ok(Buffer.byteLength(result.stdout) > 32 * 1024 - 64);
    assert.match(result.stdout, /TAIL-MARKER/);
    assert.ok(result.bytes > 200 * 1024, `bytes 应是真实产出量，实际 ${result.bytes}`);
  });
});

describe('exec · 超时杀进程树', () => {
  it('定时器到点杀树，errorCode 是 timeout', async () => {
    const dir = tempDir('timeoutstub');
    const rec = recordingSpawn(fakeChild({ pid: 999_999 }));
    const killed = [];
    const promise = runCommand(
      { command: 'dir', cwd: dir, timeoutMs: 100 },
      {
        roots: [dir],
        spawnImpl: rec.impl,
        limits: { minTimeoutMs: 10, forceKillWaitMs: 30 },
        killTreeImpl: (pid) => {
          killed.push(pid);
          return true;
        },
      },
    );
    const result = await promise;
    assert.deepEqual(killed, [999_999]);
    assert.equal(result.errorCode, 'timeout');
    assert.equal(result.ok, false);
    assert.match(result.error, /超时/);
  });

  it('真进程超时：父进程和它拉起的孙进程一起被杀掉', async () => {
    const dir = tempDir('realtimeout');
    const marker = path.join(dir, 'grandchild-alive.txt');
    fs.writeFileSync(
      path.join(dir, 'slow.cjs'),
      [
        "const { spawn } = require('node:child_process');",
        'const marker = process.argv[2];',
        `const code = "setTimeout(() => require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'alive'), 2500);";`,
        "spawn(process.execPath, ['-e', code], { stdio: 'ignore' });",
        'setTimeout(() => {}, 60000);',
      ].join('\n'),
    );

    const result = await runCommand(
      { command: `node slow.cjs "${marker}"`, cwd: dir, timeoutMs: 100 },
      { roots: [dir], limits: { minTimeoutMs: 100, forceKillWaitMs: 4000 } },
    );
    assert.equal(result.errorCode, 'timeout', result.error);
    assert.equal(result.ok, false);

    // 孙进程本该在 2.5s 后写标记；树被杀干净的话它永远写不出来
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(fs.existsSync(marker), false, '孙进程还活着，树没杀干净');
  });

  it('killProcessTree 起的是 taskkill /T /F /PID', () => {
    const calls = [];
    const ok = (async () => {
      const { killProcessTree } = await import('../src/exec.js');
      return killProcessTree(1234, {
        spawnImpl: (file, argv, options) => {
          calls.push({ file, argv, options });
          const child = new EventEmitter();
          child.on = child.on.bind(child);
          return child;
        },
      });
    })();
    return ok.then((result) => {
      if (process.platform === 'win32') {
        assert.equal(result, true);
        assert.equal(calls[0].file, 'taskkill');
        assert.deepEqual(calls[0].argv, ['/T', '/F', '/PID', '1234']);
        assert.equal(calls[0].options.shell, false);
      }
    });
  });
});
