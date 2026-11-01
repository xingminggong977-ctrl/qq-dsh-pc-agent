/**
 * SSH 隧道看守（协议 §0）：`ssh -N -L 18787:127.0.0.1:8787 root@203.0.113.11`。
 * 云端只监听 127.0.0.1，本地这条反向端口转发就是唯一通道；断了指数退避重连。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export const DEFAULT_TUNNEL = Object.freeze({
  enabled: true,
  sshPath: 'ssh',
  host: 'root@203.0.113.11',
  keyPath: '%USERPROFILE%\\.ssh\\qq_bridge_ed25519',
  localPort: 18787,
  remoteHost: '127.0.0.1',
  remotePort: 8787,
  serverAliveInterval: 15,
  serverAliveCountMax: 3,
  minDelayMs: 1_000,
  maxDelayMs: 60_000,
  factor: 2,
  /** 隧道连续活了这么久，就认为抖动已经过去，退避归零。 */
  stableAfterMs: 30_000,
});

/** %USERPROFILE% / %SystemRoot% / 开头的 ~ 都展开成真实路径。 */
export function expandEnvPath(value, env = process.env) {
  let out = String(value ?? '');
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => {
    const found = env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()];
    return typeof found === 'string' ? found : match;
  });
  if (out === '~') out = env.USERPROFILE ?? env.HOME ?? out;
  else if (out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(env.USERPROFILE ?? env.HOME ?? '', out.slice(2));
  }
  return out;
}

/** 组装 ssh 参数。写成纯函数是为了能单测，不用真连服务器。 */
export function buildSshArgs(config = {}, { env = process.env } = {}) {
  const merged = { ...DEFAULT_TUNNEL, ...config };
  const args = [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    `ServerAliveInterval=${merged.serverAliveInterval}`,
    '-o',
    `ServerAliveCountMax=${merged.serverAliveCountMax}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
  ];
  const keyPath = expandEnvPath(merged.keyPath, env);
  if (keyPath !== '') args.push('-i', keyPath);
  args.push('-L', `${merged.localPort}:${merged.remoteHost}:${merged.remotePort}`, merged.host);
  return args;
}

/**
 * 看守一个 ssh 子进程：退出就按指数退避重启（1s→2s→…→60s 封顶）。
 * timers / spawnImpl 都可注入，测试用假定时器和假 spawn 就能验证退避序列。
 */
export function createTunnel({ config = {}, log = {}, spawnImpl = spawn, timers = null, env = process.env } = {}) {
  const merged = { ...DEFAULT_TUNNEL, ...config };
  const setTimer = timers?.setTimeout ?? setTimeout;
  const clearTimer = timers?.clearTimeout ?? clearTimeout;
  const minDelay = merged.minDelayMs;
  const maxDelay = merged.maxDelayMs;

  let child = null;
  let handle = null;
  let delay = minDelay;
  let stopped = true;
  let startedAt = 0;
  let restarts = 0;
  let upSince = 0;

  const info = typeof log.info === 'function' ? log.info : () => {};
  const warn = typeof log.warn === 'function' ? log.warn : () => {};
  const error = typeof log.error === 'function' ? log.error : () => {};

  function schedule(reason, detail) {
    if (stopped || handle !== null) return;
    restarts += 1;
    const wait = delay;
    warn('tunnel down, reconnect scheduled', { reason, ...detail, delayMs: wait, attempt: restarts });
    handle = setTimer(() => {
      handle = null;
      if (!stopped) spawnOnce();
    }, wait);
    delay = Math.min(Math.round(delay * merged.factor), maxDelay);
  }

  function spawnOnce() {
    const args = buildSshArgs(merged, { env });
    info('tunnel starting', { ssh: merged.sshPath, localPort: merged.localPort, host: merged.host });
    let proc;
    try {
      proc = spawnImpl(merged.sshPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (spawnError) {
      schedule('spawn_threw', { error: spawnError?.message ?? String(spawnError) });
      return;
    }

    child = proc;
    startedAt = Date.now();
    upSince = startedAt;
    let finished = false;

    const finish = (reason, detail) => {
      if (finished) return;
      finished = true;
      if (child === proc) child = null;
      const aliveMs = Date.now() - startedAt;
      if (aliveMs >= merged.stableAfterMs) delay = minDelay;
      schedule(reason, { ...detail, aliveMs });
    };

    proc.stderr?.on('data', (chunk) => {
      warn('ssh stderr', { line: String(chunk).trim().slice(0, 200) });
    });
    proc.on('error', (spawnError) => {
      finish('spawn_error', { error: spawnError?.message ?? String(spawnError) });
    });
    proc.on('exit', (code, signal) => {
      finish('exit', { code: code ?? null, signal: signal ?? null });
    });
  }

  return {
    get running() {
      return !stopped;
    },
    get up() {
      return child !== null;
    },
    get restarts() {
      return restarts;
    },
    get nextDelayMs() {
      return delay;
    },
    get upSinceMs() {
      return upSince;
    },
    start() {
      if (!stopped) return this;
      stopped = false;
      delay = minDelay;
      restarts = 0;
      spawnOnce();
      return this;
    },
    stop() {
      stopped = true;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      const proc = child;
      child = null;
      if (proc !== null) {
        try {
          proc.kill();
        } catch (killError) {
          error('tunnel kill failed', { error: killError?.message ?? String(killError) });
        }
      }
      return this;
    },
  };
}
