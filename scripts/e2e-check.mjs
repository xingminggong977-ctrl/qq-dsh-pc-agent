// 手动端到端自检：走隧道 → 云端 bridge → 本机 pc-agent，验证 pc 通道打通。
// 用法: node scripts/e2e-check.mjs
// 依赖 ~/.dsh-qq-pc/config.json 里的 token / baseUrl。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configPath = path.join(os.homedir(), '.dsh-qq-pc', 'config.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const base = cfg.baseUrl;
const headers = { authorization: `Bearer ${cfg.token}` };

async function call(pathname, init = {}) {
  const response = await fetch(base + pathname, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const status = await call('/node/pc/status', { headers });
console.log('状态:', status.state, '| agent:', status.agentId, '| 主机:', status.hostname);
console.log('心跳:', status.lastHeartbeatSeconds + 's 前', '| 轮询:', status.lastPollSeconds + 's 前');
console.log('在途/排队:', status.inflight + '/' + status.queued);

const started = Date.now();
const reply = await call('/node/pc/enqueue', {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    kind: 'exec',
    payload: { command: 'dir', cwd: path.join(os.homedir(), 'Documents') },
    timeoutMs: 15000,
  }),
});

const result = reply.result ?? {};
console.log('\n命令:', reply.state, '| ok:', result.ok, '| exit:', result.exitCode, '| 用时:', result.durationMs + 'ms', '| 往返:', (Date.now() - started) + 'ms');

// 只打印带非 ASCII 的行：编码若有问题，这里会立刻看出来。
const nonAscii = (result.stdout ?? '')
  .split(/\r?\n/)
  .filter((line) => /[^\x00-\x7F]/.test(line));
console.log('\n含中文的目录行（编码检查）:');
console.log(nonAscii.length === 0 ? '  （没有中文名，换一个有中文的目录再测）' : nonAscii.join('\n'));
