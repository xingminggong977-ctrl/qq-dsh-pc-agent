/**
 * SSH 隧道看守的用例（协议 §0）：参数形状与指数退避重连。
 * 全程用假 spawn + 假定时器，绝不真连服务器。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { buildSshArgs, createTunnel, expandEnvPath } from '../src/tunnel.js';

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    pending() {
      return scheduled.filter((item) => !item.cleared && item.fired !== true);
    },
    setTimeout(fn, ms) {
      const item = { fn, ms, cleared: false, fired: false };
      scheduled.push(item);
      return item;
    },
    clearTimeout(item) {
      if (item) item.cleared = true;
    },
  };
}

function harness(config = {}, env = { USERPROFILE: 'C:\\Users\\lenovo' }) {
  const timers = fakeTimers();
  const spawns = [];
  const children = [];
  const logs = [];
  const tunnel = createTunnel({
    config: { minDelayMs: 1_000, maxDelayMs: 60_000, factor: 2, stableAfterMs: 30_000, ...config },
    timers,
    env,
    log: {
      info: (msg, fields) => logs.push({ level: 'info', msg, fields }),
      warn: (msg, fields) => logs.push({ level: 'warn', msg, fields }),
      error: (msg, fields) => logs.push({ level: 'error', msg, fields }),
      debug: () => {},
    },
    spawnImpl: (file, argv, options) => {
      spawns.push({ file, argv, options });
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  return { tunnel, timers, spawns, children, logs };
}

describe('tunnel · ssh 参数', () => {
  it('拼出 -N -L 18787:127.0.0.1:8787 root@…，私钥路径展开成真实路径', () => {
    const args = buildSshArgs({}, { env: { USERPROFILE: 'C:\\Users\\lenovo' } });
    assert.equal(args[0], '-N');
    const tunnelArg = args.findIndex((arg) => arg === '-L');
    assert.ok(tunnelArg > 0);
    assert.equal(args[tunnelArg + 1], '18787:127.0.0.1:8787');
    assert.equal(args[args.length - 1], 'root@203.0.113.11');
    const keyAt = args.findIndex((arg) => arg === '-i');
    assert.equal(args[keyAt + 1], 'C:\\Users\\lenovo\\.ssh\\qq_bridge_ed25519');
    assert.ok(args.includes('ExitOnForwardFailure=yes'));
    assert.ok(args.includes('ServerAliveInterval=15'));
  });

  it('配置能覆盖端口与主机', () => {
    const args = buildSshArgs({ localPort: 20000, remotePort: 9000, host: 'u@h' }, { env: {} });
    assert.ok(args.includes('20000:127.0.0.1:9000'));
    assert.equal(args[args.length - 1], 'u@h');
  });

  it('expandEnvPath 认 %VAR% 与 ~', () => {
    const env = { USERPROFILE: 'C:\\Users\\lenovo', HOME: 'C:\\Users\\lenovo' };
    assert.equal(expandEnvPath('%USERPROFILE%\\.ssh\\k', env), 'C:\\Users\\lenovo\\.ssh\\k');
    assert.equal(expandEnvPath('~', env), 'C:\\Users\\lenovo');
    assert.equal(expandEnvPath('~\\.ssh\\k', env), 'C:\\Users\\lenovo\\.ssh\\k');
    assert.equal(expandEnvPath('%NOPE%\\k', env), '%NOPE%\\k');
  });
});

describe('tunnel · 退避重连', () => {
  it('第一次起 ssh 就走 spawn(argv)，永不 shell:true', () => {
    const h = harness();
    h.tunnel.start();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].file, 'ssh');
    assert.equal(h.spawns[0].options.shell, false);
    assert.equal(h.tunnel.up, true);
    assert.equal(h.tunnel.restarts, 0);
  });

  it('断线后 1s→2s→…→60s 封顶地重连', () => {
    const h = harness();
    h.tunnel.start();
    const delays = [];
    for (let round = 0; round < 8; round += 1) {
      const child = h.children[h.children.length - 1];
      child.emit('exit', 1, null);
      const [next] = h.timers.pending();
      assert.ok(next, `第 ${round + 1} 次断线后应该排了一次重连`);
      delays.push(next.ms);
      next.fired = true;
      next.fn();
    }
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    assert.equal(h.spawns.length, 9);
    assert.equal(h.tunnel.restarts, 8);
  });

  it('一次只排一个重连，不会并发堆叠', () => {
    const h = harness();
    h.tunnel.start();
    h.children[0].emit('exit', 1, null);
    h.children[0].emit('exit', 1, null);
    assert.equal(h.timers.pending().length, 1);
  });

  it('隧道活过 stableAfterMs 后退避归零', () => {
    const h = harness({ stableAfterMs: 0 });
    h.tunnel.start();
    const delays = [];
    for (let round = 0; round < 3; round += 1) {
      h.children[h.children.length - 1].emit('exit', 1, null);
      const [next] = h.timers.pending();
      delays.push(next.ms);
      next.fired = true;
      next.fn();
    }
    assert.deepEqual(delays, [1_000, 1_000, 1_000]);
  });

  it('spawn 抛异常也走退避，不把进程带崩', () => {
    const timers = fakeTimers();
    const tunnel = createTunnel({
      timers,
      env: {},
      log: {},
      spawnImpl: () => {
        throw new Error('ENOENT ssh');
      },
    });
    tunnel.start();
    assert.equal(tunnel.up, false);
    const [next] = timers.pending();
    assert.equal(next.ms, 1_000);
    next.fired = true;
    next.fn();
  });

  it('子进程 error 事件（比如 ssh 不存在）也重连', () => {
    const h = harness();
    h.tunnel.start();
    h.children[0].emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }));
    assert.equal(h.tunnel.up, false);
    assert.equal(h.timers.pending().length, 1);
  });

  it('stop 会清掉待重连的定时器并杀掉子进程', () => {
    const h = harness();
    h.tunnel.start();
    h.children[0].emit('exit', 1, null);
    const [pending] = h.timers.pending();
    h.tunnel.stop();
    assert.equal(pending.cleared, true);
    assert.equal(h.children[0].killed, false);
    assert.equal(h.tunnel.running, false);

    const h2 = harness();
    h2.tunnel.start();
    h2.tunnel.stop();
    assert.equal(h2.children[0].killed, true);
    h2.children[0].emit('exit', 1, null);
    assert.equal(h2.timers.pending().length, 0);
    assert.equal(h2.spawns.length, 1);
  });
});
