/**
 * 配置、自述、以及 PcAgent 主循环的用例。
 * 心跳/长轮询都用假 client，绝不发真请求。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { PcAgent, ConfigError, describeSelf, loadConfig, main } from '../src/index.js';
import { createLogger } from '../src/log.js';
import { VERSION } from '../src/policy.js';
import { makeTempDir, removeTempDir } from './helpers/tmp.js';

const created = [];
function tempDir() {
  const dir = makeTempDir('agent');
  created.push(dir);
  return dir;
}
after(() => {
  for (const dir of created) removeTempDir(dir);
});

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

async function waitFor(predicate, { timeoutMs = 5_000, label = '条件' } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时：${label}`);
}

function writeConfig(dir, body) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(body, null, 2), 'utf8');
  return configPath;
}

describe('config · loadConfig', () => {
  it('从文件读出 roots / defaultCwd / token / baseUrl', () => {
    const dir = tempDir();
    const configPath = writeConfig(dir, {
      token: 'file-token',
      roots: [dir],
      defaultCwd: dir,
      baseUrl: 'http://127.0.0.1:9999',
      tunnel: { enabled: false },
      heartbeatMs: 999_999,
      pollWaitSeconds: 500,
    });
    const config = loadConfig({ argv: ['--config', configPath], env: {} });
    assert.equal(config.token, 'file-token');
    assert.deepEqual(config.roots, [dir]);
    assert.equal(config.defaultCwd, dir);
    assert.equal(config.baseUrl, 'http://127.0.0.1:9999');
    assert.equal(config.tunnel.enabled, false);
    // 越界值被夹回合法区间，而不是原样接受
    assert.equal(config.heartbeatMs, 120_000);
    assert.equal(config.pollWaitSeconds, 30);
    assert.equal(config.version, VERSION);
    assert.ok(config.execAllow.includes('dir'));
    assert.ok(config.execAllow.includes('get-childitem'));
  });

  it('环境变量优先于文件', () => {
    const dir = tempDir();
    const configPath = writeConfig(dir, { token: 'file-token', roots: [dir], defaultCwd: dir });
    const config = loadConfig({
      argv: ['--config', configPath],
      env: { PC_TOKEN: 'env-token', PC_AGENT_ID: 'pc-env', PC_BASE_URL: 'http://10.0.0.1:1' },
    });
    assert.equal(config.token, 'env-token');
    assert.equal(config.agentId, 'pc-env');
    assert.equal(config.baseUrl, 'http://10.0.0.1:1');
  });

  it('--no-tunnel 关掉隧道，baseUrl 退回远端端口', () => {
    const dir = tempDir();
    const configPath = writeConfig(dir, { token: 't', roots: [dir], defaultCwd: dir });
    const config = loadConfig({ argv: ['--config', configPath, '--no-tunnel'], env: {} });
    assert.equal(config.tunnel.enabled, false);
    assert.match(config.baseUrl, /:8787$/);
  });

  it('token 为空直接拒', () => {
    const dir = tempDir();
    const configPath = writeConfig(dir, { roots: [dir], defaultCwd: dir });
    assert.throws(() => loadConfig({ argv: ['--config', configPath], env: {} }), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /token 是空的/);
      return true;
    });
  });

  it('--print-policy 允许没有 token', () => {
    const dir = tempDir();
    const configPath = writeConfig(dir, { roots: [dir], defaultCwd: dir });
    const config = loadConfig({ argv: ['--config', configPath, '--print-policy'], env: {} });
    assert.equal(config.args.printPolicy, true);
  });

  it('roots 落在硬拒目录就拒（配置层也不放行）', () => {
    const dir = tempDir();
    const configPath = writeConfig(dir, {
      token: 't',
      roots: [path.join(dir, '.ssh')],
      defaultCwd: dir,
    });
    assert.throws(() => loadConfig({ argv: ['--config', configPath], env: {} }), /roots 里不许出现 \.ssh|defaultCwd 不可用/);
  });

  it('defaultCwd 在 roots 之外就拒', () => {
    const dir = tempDir();
    const config = writeConfig(dir, {
      token: 't',
      roots: [dir],
      defaultCwd: 'C:\\Windows',
    });
    assert.throws(() => loadConfig({ argv: ['--config', config], env: {} }), /defaultCwd 不可用/);
  });

  it('显式指定但文件不存在 → ConfigError，而不是静默用默认值', () => {
    assert.throws(() => loadConfig({ argv: ['--config', 'C:\\nope\\nope.json'], env: {} }), /配置文件不存在/);
  });

  it('不认识的参数抛 ConfigError', () => {
    assert.throws(() => loadConfig({ argv: ['--wat'], env: {} }), /不认识的参数/);
    assert.throws(() => loadConfig({ argv: ['--config'], env: {} }), /--config 后面要跟/);
  });

  it('配置文件不是对象就拒', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '[1,2,3]', 'utf8');
    assert.throws(() => loadConfig({ argv: ['--config', configPath], env: {} }), /顶层必须是一个对象/);
  });
});

describe('config · describeSelf', () => {
  it('形状符合协议 §1：capabilities + policy，不含 token', () => {
    const self = describeSelf({
      agentId: 'pc-host',
      hostname: 'host',
      platform: 'win32',
      version: VERSION,
      roots: ['C:\\Users\\x\\Documents'],
      execAllow: ['dir', 'git'],
      token: 'do-not-leak',
      baseUrl: 'http://127.0.0.1:18787',
    });
    assert.deepEqual(Object.keys(self).sort(), [
      'agentId',
      'capabilities',
      'hostname',
      'platform',
      'policy',
      'version',
    ]);
    assert.deepEqual(self.capabilities, { exec: true, read: true, write: true });
    assert.deepEqual(self.policy, { roots: ['C:\\Users\\x\\Documents'], execAllow: ['dir', 'git'] });
    assert.equal(JSON.stringify(self).includes('do-not-leak'), false);
  });
});

describe('log · 打码', () => {
  it('token 与 Authorization 都进不了日志', () => {
    const lines = [];
    const log = createLogger({ secrets: ['secret-token-value'], write: (line) => lines.push(line) });
    log.info('heartbeat', { authorization: 'Bearer secret-token-value', token: 'secret-token-value' });
    const text = lines.join('\n');
    assert.equal(text.includes('secret-token-value'), false);
    assert.match(text, /\*\*\*/);
    assert.equal(JSON.parse(lines[0]).level, 'info');
  });
});

describe('agent · 主循环', () => {
  function makeAgent(dir, commandProvider, extra = {}) {
    const delivered = [];
    const heartbeats = [];
    const client = {
      async heartbeat(body) {
        heartbeats.push(body);
        return { ok: true, now: Date.now(), serverVersion: '0.1.0' };
      },
      async poll() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true, command: commandProvider() };
      },
      async deliverResult(body) {
        delivered.push(body);
        return { ok: true, accepted: true };
      },
    };
    const config = {
      agentId: 'pc-test',
      hostname: 'host',
      platform: 'win32',
      version: VERSION,
      baseUrl: 'http://127.0.0.1:1',
      token: 'token',
      roots: [dir],
      defaultCwd: dir,
      execAllow: ['dir', 'type'],
      tunnel: { enabled: false },
      heartbeatMs: 60_000,
      pollWaitSeconds: 1,
      inflightMax: 4,
      ...extra,
    };
    return { agent: new PcAgent({ config, log: silentLog, client }), delivered, heartbeats };
  }

  it('心跳体就是 describeSelf，exec 命令跑完把结果投递回去', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'visible.txt'), 'x', 'utf8');
    let sent = false;
    const { agent, delivered, heartbeats } = makeAgent(dir, () => {
      if (sent) return null;
      sent = true;
      return { id: 'c1', kind: 'exec', deadlineAt: Date.now() + 30_000, payload: { command: 'dir /b', cwd: dir } };
    });
    agent.start();
    await waitFor(() => delivered.length === 1, { label: '结果投递' });
    await agent.stop();

    assert.equal(heartbeats.length >= 1, true);
    assert.equal(heartbeats[0].agentId, 'pc-test');
    assert.deepEqual(heartbeats[0].policy.roots, [dir]);
    assert.deepEqual(heartbeats[0].capabilities, { exec: true, read: true, write: true });

    const result = delivered[0];
    assert.equal(result.id, 'c1');
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /visible\.txt/);
    assert.equal(result.stderr, '');
    assert.equal(result.truncated, false);
    assert.equal(result.errorCode, null);
    assert.equal(typeof result.durationMs, 'number');
    // 结果体字段必须和协议 §1 的列表一致
    assert.deepEqual(
      Object.keys(result).sort(),
      ['bytes', 'durationMs', 'error', 'errorCode', 'exitCode', 'id', 'ok', 'stderr', 'stdout', 'truncated'].sort(),
    );
  });

  it('同一个 id 再来一次会被去重，不会重复执行', async () => {
    const dir = tempDir();
    const command = { id: 'dup-1', kind: 'exec', payload: { command: 'dir /b', cwd: dir } };
    const { agent, delivered } = makeAgent(dir, () => command);
    agent.start();
    await waitFor(() => delivered.length >= 1, { label: '第一次投递' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await agent.stop();
    assert.equal(delivered.length, 1);
    assert.equal(agent.stats.duplicate >= 1, true);
  });

  it('read / write 走同一条通道，未知 kind 报 internal', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'note.txt');
    const commands = [
      { id: 'w1', kind: 'write', payload: { path: target, content: '你好' } },
      { id: 'r1', kind: 'read', payload: { path: target } },
      { id: 'x1', kind: 'bogus', payload: {} },
    ];
    const { agent, delivered } = makeAgent(dir, () => commands.shift() ?? null);
    agent.start();
    await waitFor(() => delivered.length === 3, { label: '三条结果' });
    await agent.stop();

    const byId = Object.fromEntries(delivered.map((item) => [item.id, item]));
    assert.equal(byId.w1.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), '你好');
    assert.equal(byId.r1.ok, true);
    assert.equal(byId.r1.stdout, '你好');
    assert.equal(byId.x1.ok, false);
    assert.equal(byId.x1.errorCode, 'internal');
  });

  it('白名单外的命令不会执行，结果带 not_allowlisted', async () => {
    const dir = tempDir();
    const { agent, delivered } = makeAgent(dir, () => ({
      id: 'bad-1',
      kind: 'exec',
      payload: { command: 'curl http://example.com', cwd: dir },
    }));
    agent.start();
    await waitFor(() => delivered.length === 1, { label: '拒绝结果' });
    await agent.stop();
    assert.equal(delivered[0].ok, false);
    assert.equal(delivered[0].errorCode, 'not_allowlisted');
  });

  it('投递失败不会把循环带崩，下一轮继续', async () => {
    const dir = tempDir();
    let attempts = 0;
    const client = {
      async heartbeat() {
        return { ok: true };
      },
      async poll() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return attempts === 0 ? { ok: true, command: { id: 'f1', kind: 'exec', payload: { command: 'dir /b', cwd: dir } } } : { ok: true, command: null };
      },
      async deliverResult() {
        attempts += 1;
        throw new Error('ECONNREFUSED');
      },
    };
    const config = {
      agentId: 'pc-test',
      hostname: 'host',
      platform: 'win32',
      version: VERSION,
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
      roots: [dir],
      defaultCwd: dir,
      execAllow: ['dir'],
      tunnel: { enabled: false },
      heartbeatMs: 60_000,
      pollWaitSeconds: 1,
      inflightMax: 4,
    };
    const agent = new PcAgent({ config, log: silentLog, client });
    agent.start();
    await waitFor(() => attempts === 1, { label: '投递尝试' });
    await agent.stop();
    assert.equal(agent.stats.done, 0);
  });
});

describe('main · 命令行', () => {
  it('--help 打印用法并返回 0', async () => {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      assert.equal(await main({ argv: ['--help'], env: {} }), 0);
    } finally {
      process.stdout.write = original;
    }
    assert.match(chunks.join(''), /pc-agent — QQ 机器人/);
    assert.match(chunks.join(''), /--print-policy/);
  });

  it('--print-policy 打印生效策略（不含 token）', async () => {
    const dir = tempDir();
    const configPath = writeConfig(dir, { token: 'secret-token', roots: [dir], defaultCwd: dir });
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      assert.equal(await main({ argv: ['--config', configPath, '--print-policy'], env: {} }), 0);
    } finally {
      process.stdout.write = original;
    }
    const printed = JSON.parse(chunks.join(''));
    assert.deepEqual(printed.policy.roots, [dir]);
    assert.deepEqual(printed.capabilities, { exec: true, read: true, write: true });
    assert.equal(typeof printed.baseUrl, 'string');
    assert.equal(JSON.stringify(printed).includes('secret-token'), false);
  });
});
