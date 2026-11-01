// 策略边界自检：确认「越界一律在本地被拒」，而且拒绝理由是人话。
// 用法: node scripts/policy-check.mjs
// 只读，不改任何文件；每条都走完整链路（隧道 → 云端 bridge → 本机 pc-agent）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-qq-pc', 'config.json'), 'utf8'));
const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' };

const cases = [
  {
    name: '读 roots 之外的文件',
    kind: 'read',
    payload: { path: 'C:\\Windows\\win.ini' },
    expectOk: false,
  },
  {
    name: '读 roots 之内的文件',
    kind: 'read',
    payload: { path: path.join(os.homedir(), 'Documents', 'message_feed_cache.json') },
    expectOk: true,
  },
  {
    name: 'shell 垫片不在白名单',
    kind: 'exec',
    payload: { command: 'cmd /c dir' },
    expectOk: false,
  },
  {
    name: 'git 想把仓库指到 roots 之外',
    kind: 'exec',
    payload: { command: 'git --git-dir=C:\\Windows log' },
    expectOk: false,
  },
  {
    name: '写 roots 之外的文件',
    kind: 'write',
    payload: { path: 'C:\\Windows\\dsh-should-not-exist.txt', content: 'x' },
    expectOk: false,
  },
];

let failures = 0;
for (const testCase of cases) {
  const response = await fetch(cfg.baseUrl + '/node/pc/enqueue', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: testCase.kind, payload: testCase.payload, timeoutMs: 15000 }),
  });
  const body = await response.json().catch(() => ({}));
  const result = body.result ?? {};
  const ok = result.ok === true;
  const passed = ok === testCase.expectOk;
  if (!passed) failures += 1;
  const label = passed ? '通过' : '不符预期';
  const detail = ok ? `exit=${result.exitCode}` : `${result.errorCode ?? body.error?.code ?? '?'}: ${String(result.error ?? body.error?.message ?? '').slice(0, 70)}`;
  console.log(`${label} | ${testCase.name} | 期望 ok=${testCase.expectOk} 实际 ok=${ok} | ${detail}`);
}

console.log(failures === 0 ? '\n全部符合预期' : `\n${failures} 条不符合预期`);
process.exitCode = failures === 0 ? 0 : 1;
