/**
 * pc-agent 入口：配置 → 隧道 → 心跳(10s) + 长轮询 → 执行 → 回报 → 优雅退出。
 * 云端永远不连进来，这里只有出站请求（协议 §0）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PcBridgeClient, clampWaitSeconds } from './client.js';
import { detectPowershell, runCommand } from './exec.js';
import { readFileBody, writeFileBody } from './files.js';
import { createLogger } from './log.js';
import { checkPath, findDeniedSegment } from './paths.js';
import {
  CAPABILITIES,
  DEFAULT_CWD,
  DEFAULT_EXEC_ALLOW,
  DEFAULT_ROOTS,
  HEARTBEAT_INTERVAL_MS,
  INFLIGHT_MAX,
  POLL_WAIT_SECONDS,
  PolicyError,
  VERSION,
} from './policy.js';
import { failureResult } from './result.js';
import { createTunnel, DEFAULT_TUNNEL, expandEnvPath } from './tunnel.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const HEARTBEAT_MIN_MS = 2_000;
const HEARTBEAT_MAX_MS = 120_000;
const POLL_ERROR_BACKOFF_MAX_MS = 30_000;
const SEEN_ID_LIMIT = 512;

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

/** 配置文件里留空字符串等于「没配」，别让它把默认值顶掉。 */
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const text = String(candidate).trim();
    if (text !== '') return text;
  }
  return '';
}

export function defaultConfigPath(env = process.env) {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  return path.join(home, '.dsh-qq-pc', 'config.json');
}

/** 只认几个开关，别把它做成命令行解释器。 */
export function parseArgs(argv = []) {
  const args = { config: undefined, noTunnel: false, printPolicy: false, verbose: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new ConfigError('--config 后面要跟配置文件路径');
      args.config = value;
      index += 1;
    } else if (token === '--no-tunnel') args.noTunnel = true;
    else if (token === '--print-policy') args.printPolicy = true;
    else if (token === '--verbose') args.verbose = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--version') args.printPolicy = true;
    else throw new ConfigError(`不认识的参数：${token}`);
  }
  return args;
}

export function loadConfig({ argv = [], env = process.env, fsImpl = fs } = {}) {
  const args = parseArgs(argv);
  const configPath = args.config ?? env.PC_CONFIG ?? defaultConfigPath(env);

  let raw = {};
  if (fsImpl.existsSync(configPath)) {
    try {
      raw = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new ConfigError(`配置文件读不了：${configPath}（${error?.message ?? error}）`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigError(`配置文件顶层必须是一个对象：${configPath}`);
    }
  } else if (args.config !== undefined || env.PC_CONFIG !== undefined) {
    throw new ConfigError(`配置文件不存在：${configPath}`);
  }

  const tunnel = { ...DEFAULT_TUNNEL, ...(raw.tunnel ?? {}) };
  if (args.noTunnel) tunnel.enabled = false;

  const roots = (Array.isArray(raw.roots) && raw.roots.length > 0 ? raw.roots : DEFAULT_ROOTS).map((root) =>
    String(root),
  );
  for (const root of roots) {
    if (!path.isAbsolute(root)) throw new ConfigError(`roots 必须是绝对路径：${root}`);
    const denied = findDeniedSegment(root);
    if (denied !== null) throw new ConfigError(`roots 里不许出现 ${denied}：${root}`);
  }

  const defaultCwd = expandEnvPath(String(raw.defaultCwd ?? DEFAULT_CWD), env);
  try {
    checkPath(defaultCwd, { roots, mode: 'cwd', fsImpl });
  } catch (error) {
    throw new ConfigError(`defaultCwd 不可用（${defaultCwd}）：${error?.message ?? error}`);
  }

  const token = String(env.PC_TOKEN ?? raw.token ?? '').trim();
  const hostname = os.hostname();
  const agentId = firstNonEmpty(env.PC_AGENT_ID, raw.agentId) || `pc-${hostname.toLowerCase()}`;
  const baseUrl =
    firstNonEmpty(env.PC_BASE_URL, raw.baseUrl) ||
    (tunnel.enabled ? `http://127.0.0.1:${tunnel.localPort}` : `http://127.0.0.1:${tunnel.remotePort}`);

  const config = {
    configPath,
    agentId,
    hostname,
    platform: process.platform,
    version: VERSION,
    baseUrl,
    token,
    roots,
    defaultCwd,
    execAllow: [...DEFAULT_EXEC_ALLOW],
    powershellPath:
      typeof raw.powershellPath === 'string' && raw.powershellPath !== ''
        ? expandEnvPath(raw.powershellPath, env)
        : detectPowershell({ env, fsImpl }),
    heartbeatMs: clampInt(raw.heartbeatMs ?? env.PC_HEARTBEAT_MS, HEARTBEAT_MIN_MS, HEARTBEAT_MAX_MS, HEARTBEAT_INTERVAL_MS),
    pollWaitSeconds: clampWaitSeconds(raw.pollWaitSeconds ?? env.PC_POLL_WAIT_SECONDS, POLL_WAIT_SECONDS),
    inflightMax: clampInt(raw.inflightMax, 1, 8, INFLIGHT_MAX),
    tunnel,
    logLevel: String(args.verbose ? 'debug' : raw.logLevel ?? env.PC_LOG_LEVEL ?? 'info'),
    args,
  };

  if (!config.args.printPolicy && config.token === '') {
    throw new ConfigError(
      `token 是空的：在 ${configPath} 里填上 bridge 的 NODE_TOKEN，或设环境变量 PC_TOKEN`,
    );
  }
  if (!/^https?:\/\/\S+$/i.test(config.baseUrl)) {
    throw new ConfigError(`baseUrl 必须是 http(s) URL：${config.baseUrl}`);
  }
  return config;
}

/** 心跳与 --print-policy 共用的那一份自述（协议 §1）。 */
export function describeSelf(config) {
  return {
    agentId: config.agentId,
    hostname: config.hostname,
    platform: config.platform,
    version: config.version,
    capabilities: { ...CAPABILITIES },
    policy: { roots: [...config.roots], execAllow: [...config.execAllow] },
  };
}

/** 定时器都 unref：后台常驻靠 socket 撑着，测试进程不该被一个 10s 的睡眠挂住。 */
function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

export class PcAgent {
  #config;
  #log;
  #client;
  #tunnel;
  #now;
  #running = false;
  #abort = new AbortController();
  #heartbeatTimer = null;
  #inflight = new Set();
  #seen = new Set();
  #stats = { lastHeartbeatAt: 0, lastPollAt: 0, done: 0, failed: 0, duplicate: 0 };

  constructor({ config, log, client = null, tunnel = null, now = () => Date.now() }) {
    this.#config = config;
    this.#log = log;
    this.#client = client ?? new PcBridgeClient({ baseUrl: config.baseUrl, token: config.token, log });
    this.#tunnel = tunnel;
    this.#now = now;
  }

  /** 可被 stop() 打断的等待。 */
  #wait(ms) {
    return new Promise((resolve) => {
      const timer = unrefTimer(setTimeout(resolve, ms));
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.#abort.signal.aborted) {
        onAbort();
        return;
      }
      this.#abort.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  get stats() {
    return { ...this.#stats, inflight: this.#inflight.size, running: this.#running };
  }

  start() {
    if (this.#running) return this;
    this.#running = true;
    if (this.#tunnel !== null && this.#config.tunnel?.enabled !== false) this.#tunnel.start();
    void this.#heartbeatTick();
    void this.#pollLoop();
    return this;
  }

  async stop({ drainMs = 3000 } = {}) {
    if (!this.#running) {
      this.#tunnel?.stop();
      return;
    }
    this.#running = false;
    if (this.#heartbeatTimer !== null) {
      clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#abort.abort();
    const pending = [...this.#inflight];
    if (pending.length > 0) {
      const drain = new Promise((resolve) => unrefTimer(setTimeout(resolve, drainMs)));
      await Promise.race([Promise.allSettled(pending), drain]);
    }
    this.#tunnel?.stop();
    this.#log.info('agent stopped', { ...this.stats });
  }

  #scheduleHeartbeat() {
    this.#heartbeatTimer = unrefTimer(setTimeout(() => void this.#heartbeatTick(), this.#config.heartbeatMs));
  }

  async #heartbeatTick() {
    if (!this.#running) return;
    try {
      await this.#client.heartbeat(describeSelf(this.#config), { signal: this.#abort.signal });
      this.#stats.lastHeartbeatAt = this.#now();
      this.#log.debug('heartbeat ok', { at: this.#stats.lastHeartbeatAt });
    } catch (error) {
      if (!this.#running) return;
      this.#log.warn('heartbeat failed', { error: error?.message ?? String(error) });
    }
    if (this.#running) this.#scheduleHeartbeat();
  }

  async #pollLoop() {
    let backoff = 1_000;
    while (this.#running) {
      try {
        const reply = await this.#client.poll({
          agentId: this.#config.agentId,
          waitSeconds: this.#config.pollWaitSeconds,
          signal: this.#abort.signal,
        });
        this.#stats.lastPollAt = this.#now();
        backoff = 1_000;
        const command = reply?.command ?? null;
        if (command !== null) this.#dispatch(command);
      } catch (error) {
        if (!this.#running) return;
        this.#log.warn('poll failed', {
          error: error?.message ?? String(error),
          retryInMs: backoff,
          hint: '隧道可能还没起来',
        });
        await this.#wait(backoff);
        backoff = Math.min(backoff * 2, POLL_ERROR_BACKOFF_MAX_MS);
      }
    }
  }

  #dispatch(command) {
    const id = typeof command?.id === 'string' ? command.id : '';
    if (id === '') {
      this.#log.warn('command without id, dropped', { kind: command?.kind });
      return;
    }
    if (this.#seen.has(id)) {
      this.#stats.duplicate += 1;
      this.#log.warn('duplicate command id, ignored', { id });
      return;
    }
    this.#seen.add(id);
    if (this.#seen.size > SEEN_ID_LIMIT) {
      const oldest = this.#seen.values().next().value;
      this.#seen.delete(oldest);
    }
    if (this.#inflight.size >= this.#config.inflightMax) {
      this.#log.warn('inflight above local cap, still running', {
        id,
        inflight: this.#inflight.size,
        cap: this.#config.inflightMax,
      });
    }
    const task = this.#handle(command).catch((error) => {
      this.#log.error('command handling crashed', { id, error: error?.message ?? String(error) });
    });
    this.#inflight.add(task);
    void task.finally(() => this.#inflight.delete(task));
  }

  /** 执行一条命令并把结果投递回去；投递失败会重试，不丢结果。 */
  async #handle(command) {
    const body = await this.#execute(command);
    try {
      await this.#client.deliverResult(body);
      if (body.ok) this.#stats.done += 1;
      else this.#stats.failed += 1;
      this.#log.info('result delivered', {
        id: body.id,
        ok: body.ok,
        errorCode: body.errorCode,
        bytes: body.bytes,
        durationMs: body.durationMs,
      });
    } catch (error) {
      this.#log.error('result delivery gave up', {
        id: body.id,
        error: error?.message ?? String(error),
        errorCode: body.errorCode,
      });
    }
  }

  async #execute(command) {
    const startedAt = this.#now();
    const kind = command?.kind;
    const payload = command?.payload ?? {};
    const options = {
      roots: this.#config.roots,
      defaultCwd: this.#config.defaultCwd,
      powershellPath: this.#config.powershellPath,
    };
    try {
      if (kind === 'exec') {
        return { id: command.id, ...(await runCommand(payload, options)) };
      }
      if (kind === 'read') {
        return { id: command.id, ...readFileBody(payload, options) };
      }
      if (kind === 'write') {
        return { id: command.id, ...writeFileBody(payload, options) };
      }
      throw new PolicyError('internal', `不认识的 kind：${String(kind)}`);
    } catch (error) {
      return { id: command.id, ...failureResult(error, startedAt) };
    }
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      [
        'pc-agent — QQ 机器人 PC 工具通道的本机代理',
        '',
        '用法：node src/index.js [--config <config.json>] [--no-tunnel] [--print-policy] [--verbose]',
        '',
        '  --config <path>   配置文件（默认 %USERPROFILE%\\.dsh-qq-pc\\config.json）',
        '  --no-tunnel       不拉起 ssh 隧道，直接连 baseUrl',
        '  --print-policy    只打印当前生效的策略，然后退出',
        '',
      ].join('\n'),
    );
    return 0;
  }

  const config = loadConfig({ argv, env });
  const log = createLogger({ secrets: [config.token], level: config.logLevel });

  if (args.printPolicy) {
    process.stdout.write(`${JSON.stringify({ ...describeSelf(config), baseUrl: config.baseUrl, tunnel: { enabled: config.tunnel.enabled, localPort: config.tunnel.localPort } }, null, 2)}\n`);
    return 0;
  }

  const tunnel = config.tunnel.enabled ? createTunnel({ config: config.tunnel, log, env }) : null;
  const agent = new PcAgent({ config, log, tunnel });

  const shutdown = async (signal) => {
    log.info('shutdown requested', { signal });
    await agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => {
    log.error('unhandled rejection', { error: error?.message ?? String(error) });
  });

  log.info('pc-agent starting', {
    ...describeSelf(config),
    baseUrl: config.baseUrl,
    configPath: config.configPath,
    tunnel: config.tunnel.enabled ? config.tunnel.host : 'off',
    heartbeatMs: config.heartbeatMs,
    pollWaitSeconds: config.pollWaitSeconds,
    powershellPath: config.powershellPath,
  });
  agent.start();
  return agent;
}

if (isMainModule()) {
  main().catch((error) => {
    const message = error?.message ?? String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
