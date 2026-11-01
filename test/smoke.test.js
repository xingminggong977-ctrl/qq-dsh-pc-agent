/**
 * 本地假桥烟测：真起一个 http server 模拟云端四个端点，真跑 PcBridgeClient + PcAgent，
 * 真执行无害命令，把一整条 心跳 → 取命令 → 执行 → 投递结果 的往返跑通。
 * 绝不连线上服务器（协议 §0：云端不连进来，这里全是出站请求）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { PcBridgeClient } from '../src/client.js';
import { PcAgent } from '../src/index.js';
import { VERSION } from '../src/policy.js';
import { makeTempDir, removeTempDir } from './helpers/tmp.js';

const TOKEN = 'smoke-token-abcdefghijklmnop';
const created = [];
after(() => {
  for (const dir of created) removeTempDir(dir);
});

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

async function waitFor(predicate, { timeoutMs = 20_000, label = '条件' } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

/** 只实现协议 §1 里 agent 会用到的那三个端点，外加一个 status。 */
async function startFakeBridge({ token, commands }) {
  const seen = { heartbeat: [], poll: [], result: [], status: [], authFailures: 0, paths: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      seen.paths.push(`${req.method} ${url.pathname}`);
      const reply = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      };
      if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
        seen.authFailures += 1;
        reply(401, { ok: false, error: 'unauthorized' });
        return;
      }
      const body = raw === '' ? null : JSON.parse(raw);
      if (url.pathname === '/node/pc/heartbeat') {
        seen.heartbeat.push(body);
        reply(200, { ok: true, now: Date.now(), serverVersion: 'fake-bridge-0.1.0' });
        return;
      }
      if (url.pathname === '/node/pc/poll') {
        seen.poll.push(body);
        const command = commands.shift() ?? null;
        // 没有命令时故意磨一下，别让客户端把 CPU 打满
        setTimeout(() => reply(200, { ok: true, command }), command === null ? 20 : 0);
        return;
      }
      if (url.pathname === '/node/pc/result') {
        const duplicate = seen.result.some((item) => item.id === body?.id);
        seen.result.push(body);
        reply(200, { ok: true, accepted: !duplicate });
        return;
      }
      if (url.pathname === '/node/pc/status') {
        seen.status.push(body);
        reply(200, { ok: true, state: 'online' });
        return;
      }
      reply(404, { ok: false, error: 'not_found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, port, baseUrl: `http://127.0.0.1:${port}`, seen };
}

describe('smoke · 本地假桥', () => {
  it('心跳 → poll → 真执行 → 投递结果，一条完整往返', async () => {
    const dir = makeTempDir('smoke');
    created.push(dir);
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi from pc-agent\n', 'utf8');
    const notePath = path.join(dir, 'note.txt');

    const commands = [
      { id: 'cmd-1', kind: 'exec', deadlineAt: Date.now() + 30_000, payload: { command: 'dir /b', cwd: dir } },
      { id: 'cmd-2', kind: 'write', deadlineAt: Date.now() + 30_000, payload: { path: notePath, content: '写进来的一行' } },
      { id: 'cmd-3', kind: 'read', deadlineAt: Date.now() + 30_000, payload: { path: notePath } },
      { id: 'cmd-4', kind: 'exec', deadlineAt: Date.now() + 30_000, payload: { command: 'where node', cwd: dir } },
      { id: 'cmd-5', kind: 'exec', deadlineAt: Date.now() + 30_000, payload: { command: 'curl http://example.com', cwd: dir } },
    ];
    const bridge = await startFakeBridge({ token: TOKEN, commands });
    // commands 会被 shift 吃掉，先把条数抄下来再比
    const totalCommands = commands.length;

    const config = {
      agentId: 'pc-smoke',
      hostname: 'smoke-host',
      platform: process.platform,
      version: VERSION,
      baseUrl: bridge.baseUrl,
      token: TOKEN,
      roots: [dir],
      defaultCwd: dir,
      execAllow: ['dir', 'where'],
      tunnel: { enabled: false },
      heartbeatMs: 60_000,
      pollWaitSeconds: 1,
      inflightMax: 4,
      logLevel: 'silent',
    };
    const client = new PcBridgeClient({ baseUrl: config.baseUrl, token: TOKEN });
    const agent = new PcAgent({ config, log: silentLog, client });

    try {
      agent.start();
      await waitFor(() => bridge.seen.result.length === totalCommands, { label: '五条结果都投递回来' });
      await waitFor(() => bridge.seen.heartbeat.length >= 1, { label: '心跳' });
    } finally {
      await agent.stop();
      await new Promise((resolve) => bridge.server.close(resolve));
    }

    // —— 服务端看到的东西（也就是烟测证据）——
    const byId = Object.fromEntries(bridge.seen.result.map((item) => [item.id, item]));
    assert.equal(bridge.seen.authFailures, 0);
    assert.ok(bridge.seen.paths.includes('POST /node/pc/heartbeat'));
    assert.ok(bridge.seen.paths.includes('POST /node/pc/poll'));
    assert.ok(bridge.seen.paths.includes('POST /node/pc/result'));

    assert.deepEqual(bridge.seen.heartbeat[0].policy.roots, [dir]);
    assert.deepEqual(bridge.seen.heartbeat[0].capabilities, { exec: true, read: true, write: true });
    assert.deepEqual(bridge.seen.poll[0], { agentId: 'pc-smoke', waitSeconds: 1 });

    assert.equal(byId['cmd-1'].ok, true);
    assert.match(byId['cmd-1'].stdout, /hello\.txt/);
    assert.equal(byId['cmd-2'].ok, true);
    assert.equal(fs.readFileSync(notePath, 'utf8'), '写进来的一行');
    assert.equal(byId['cmd-3'].stdout, '写进来的一行');
    assert.equal(byId['cmd-4'].ok, true);
    assert.match(byId['cmd-4'].stdout, /node\.exe/i);
    assert.equal(byId['cmd-5'].ok, false);
    assert.equal(byId['cmd-5'].errorCode, 'not_allowlisted');

    const transcript = [
      '',
      '===== 本地假桥烟测记录 =====',
      `假桥地址        ${bridge.baseUrl}`,
      `服务端收到的路径 ${[...new Set(bridge.seen.paths)].join(' , ')}`,
      `鉴权失败次数     ${bridge.seen.authFailures}`,
      `心跳 #1         agentId=${bridge.seen.heartbeat[0].agentId} roots=${JSON.stringify(bridge.seen.heartbeat[0].policy.roots)} execAllow=${JSON.stringify(bridge.seen.heartbeat[0].policy.execAllow)}`,
      `poll #1 请求体   ${JSON.stringify(bridge.seen.poll[0])}`,
      `结果 #1 (exec)   ok=${byId['cmd-1'].ok} exitCode=${byId['cmd-1'].exitCode} bytes=${byId['cmd-1'].bytes} stdout=${JSON.stringify(byId['cmd-1'].stdout.replace(/\r?\n/g, ' | ').slice(0, 120))}`,
      `结果 #2 (write)  ok=${byId['cmd-2'].ok} bytes=${byId['cmd-2'].bytes}`,
      `结果 #3 (read)   ok=${byId['cmd-3'].ok} stdout=${JSON.stringify(byId['cmd-3'].stdout)}`,
      `结果 #4 (exec)   ok=${byId['cmd-4'].ok} stdout=${JSON.stringify(byId['cmd-4'].stdout.trim())}`,
      `结果 #5 (拦截)   ok=${byId['cmd-5'].ok} errorCode=${byId['cmd-5'].errorCode} error=${JSON.stringify(byId['cmd-5'].error)}`,
      `结果体字段       ${Object.keys(byId['cmd-1']).sort().join(',')}`,
      '===== 烟测结束 =====',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'smoke-transcript.txt'), transcript, 'utf8');
    process.stdout.write(transcript);
  });
});
