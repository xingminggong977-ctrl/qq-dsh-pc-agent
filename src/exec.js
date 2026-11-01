/**
 * 命令白名单执行（协议 §3）。
 *
 * 三条铁律：
 * 1. 永不 shell:true。真正的 exe 一律 spawn(exe, argv)；
 *    cmd 内建与 PowerShell cmdlet 才经 cmd.exe / pwsh，且先过词法检查。
 * 2. 先判白名单与高危参数，再谈 spawn；任何一步不过直接 not_allowlisted。
 * 3. 超时杀进程树（taskkill /T /F /PID），输出各留最后 32KB。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  CMD_BUILTINS,
  CONTROL_CHARS,
  DEFAULT_CWD,
  DEFAULT_ROOTS,
  DENY_ARGS,
  GLOB_ALLOWED_EXES,
  INTERPRETER_EXPANSION_CHARS,
  NATIVE_EXES,
  NPM_ALLOWED_VERBS,
  ORCHESTRATION_TOKENS,
  OUTPUT_CAP_BYTES,
  PolicyError,
  POWERSHELL_CMDLETS,
  TIMEOUT_DEFAULT_MS,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
} from './policy.js';
import { checkPath } from './paths.js';
import { failureResult } from './result.js';

/** 按空格切词，支持 "..." / '...' 分组（分组只为带空格的文件名，不构成任何解释）。 */
export function tokenize(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let pending = false;

  for (const char of String(command)) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      pending = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      pending = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (pending) {
        tokens.push(current);
        current = '';
        pending = false;
      }
      continue;
    }
    current += char;
    pending = true;
  }

  if (quote !== null) throw new PolicyError('not_allowlisted', `引号没配对：${command}`);
  if (pending) tokens.push(current);
  return tokens;
}

/** 词法层：控制字符与编排字符一律拒（一条命令只许干一件事）。 */
export function assertLexicalClean(command, tokens) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new PolicyError('not_allowlisted', '命令不能为空');
  }
  if (CONTROL_CHARS.test(command)) {
    throw new PolicyError('not_allowlisted', '命令里含控制字符（换行等），不做多命令编排');
  }
  for (const token of tokens) {
    for (const bad of ORCHESTRATION_TOKENS) {
      if (token.includes(bad)) {
        throw new PolicyError('not_allowlisted', `命令里含编排字符 ${bad}：${token}`);
      }
    }
  }
}

/** 去 .exe、转小写，得到白名单里的键。 */
export function normalizeExe(token) {
  return String(token).trim().toLowerCase().replace(/\.exe$/, '');
}

/** native = 真 exe；cmd = cmd 内建；powershell = cmdlet；null = 白名单外。 */
export function classify(exe) {
  if (CMD_BUILTINS.includes(exe)) return 'cmd';
  if (POWERSHELL_CMDLETS.includes(exe)) return 'powershell';
  if (NATIVE_EXES.includes(exe)) return 'native';
  return null;
}

/**
 * 拒绝理由按参数分类：`--git-dir` / `--work-tree` 不是「执行代码」，
 * 它们是把目标仓库/工作区挪到别处，等于绕开「write 不许碰 .git」。
 */
const DENY_ARG_REASONS = Object.freeze({
  '--git-dir': '这条参数能把目标仓库指到 roots 之外，等于绕开「write 不许碰 .git」',
  '--work-tree': '这条参数能把工作区指到 roots 之外，等于绕开路径策略',
});

function denyArgReason(flag) {
  return DENY_ARG_REASONS[flag] ?? '这条参数等价于直接执行任意代码';
}

/**
 * 参数级拦截。短选项按最坏情况处理：`-c...` 连写也算命中（python 真的接受这种写法），
 * 但**大小写必须区分**：git 的 `-C`（换目录）和 `-c`（跑配置里的命令）是两件事，
 * 一律小写比较会把 `git -C repo status` 这种正常用法也挡掉。
 */
export function assertArgPolicy(exe, args) {
  const denied = DENY_ARGS[exe];
  if (denied !== undefined) {
    for (const arg of args) {
      for (const flag of denied) {
        if (flag.startsWith('--')) {
          // `--git-dir=x` 与 `--git-dir x` 都是 git 认的写法，命名本身命中就够了
          const lower = arg.toLowerCase();
          if (lower === flag || lower.startsWith(`${flag}=`)) {
            throw new PolicyError('not_allowlisted', `${exe} 不许用 ${flag}：${denyArgReason(flag)}`);
          }
          continue;
        }
        if (arg === flag || (arg.startsWith(flag) && !arg.startsWith('--'))) {
          throw new PolicyError('not_allowlisted', `${exe} 不许用 ${flag}：${denyArgReason(flag)}`);
        }
      }
    }
  }

  if (exe === 'git') {
    const first = args.find((arg) => !arg.startsWith('-'));
    if (first !== undefined && first.startsWith('!')) {
      throw new PolicyError('not_allowlisted', 'git 不许用 ! 开头的别名（那等于把命令交给 shell）');
    }
  }

  if (exe === 'npm') {
    const verbs = args.filter((arg) => !arg.startsWith('-'));
    const versionOnly = args.includes('--version');
    if (verbs.length === 0) {
      if (!versionOnly) throw new PolicyError('not_allowlisted', 'npm 只允许 ls / view / --version');
      return;
    }
    if (!NPM_ALLOWED_VERBS.includes(verbs[0].toLowerCase())) {
      throw new PolicyError('not_allowlisted', `npm 只允许 ls / view / --version，不许 ${verbs[0]}`);
    }
  }
}

/** 长得像路径的 token（含分隔符、盘符冒号或点）。 */
const PATH_LIKE = /[\\/:.]/;

/**
 * 参数里的路径也要过策略，否则 `type C:\Users\lenovo\.ssh\id_rsa` 一句就绕开整个 read 判定。
 * 同一条规则顺手挡住两类别处漏的洞：
 * - 解释器里的 %VAR% / $env:VAR 变量展开（能把硬拒目录拼出来）；
 * - 内容类命令的通配符（`type .s*\id_rsa` 就是拿 glob 拼出 .ssh）。
 * 选项 token（-x / /x）跳过：Windows 绝对路径不会以 / 开头。
 */
export function assertExecTokenPolicy({ exe, kind, tokens, cwd, roots = DEFAULT_ROOTS, fsImpl = fs }) {
  const allowGlob = GLOB_ALLOWED_EXES.includes(exe);
  const interpreting = kind === 'cmd' || kind === 'powershell';

  for (const token of tokens.slice(1)) {
    if (token === '') continue;
    if (token.startsWith('-') || token.startsWith('/')) continue;
    if (interpreting) {
      for (const char of INTERPRETER_EXPANSION_CHARS) {
        if (token.includes(char)) {
          throw new PolicyError('not_allowlisted', `解释器里不许用变量展开（${char}）：${token}`);
        }
      }
    }
    if (!allowGlob && /[*?]/.test(token)) {
      throw new PolicyError('not_allowlisted', `这条命令不许用通配符：${token}`);
    }
    if (!PATH_LIKE.test(token)) continue;
    const candidate = path.isAbsolute(token) || /^[A-Za-z]:/.test(token) ? token : `${cwd}\\${token}`;
    checkPath(candidate, { roots, mode: 'read', fsImpl });
  }
}

/** npm 在 Windows 上只有 .cmd 垫片，shell:false 起不来；找到真正的 CLI 脚本交给 node。 */
export function resolveNpmCli({ env = process.env, fsImpl = fs, execPath = process.execPath } = {}) {
  const dirs = [];
  if (typeof execPath === 'string' && execPath !== '') dirs.push(path.dirname(execPath));
  for (const entry of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (entry !== '') dirs.push(entry);
  }
  const candidates = dirs.map((dir) => path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  if (typeof env.APPDATA === 'string' && env.APPDATA !== '') {
    candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    try {
      if (fsImpl.existsSync(candidate)) return candidate;
    } catch {
      // 读不到的候选直接跳过
    }
  }
  return null;
}

function quoteForCmd(token) {
  return /[\s()%,;=&]/.test(token) ? `"${token}"` : token;
}

function quoteForPowerShell(token) {
  return /[\s#'"`]/.test(token) ? `'${token.replace(/'/g, "''")}'` : token;
}

/**
 * 组装 spawn 用的 { file, argv }。
 * cmd / powershell 这两个解释器分支由我们自己从 token 重建命令行，
 * 绝不把用户原始字符串直接塞进去。
 */
export function buildCommand({ exe, tokens, args, powershellPath, env = process.env, fsImpl = fs, execPath = process.execPath }) {
  const kind = classify(exe);
  if (kind === 'native') {
    if (exe === 'npm') {
      const cli = resolveNpmCli({ env, fsImpl, execPath });
      if (cli === null) {
        throw new PolicyError('spawn_failed', '找不到 npm 的 CLI 脚本：npm 在 Windows 上是 .cmd 垫片，不能不过这层');
      }
      return { kind, file: execPath, argv: [cli, ...args] };
    }
    return { kind, file: exe, argv: args };
  }
  if (kind === 'cmd') {
    const comspec = typeof env.ComSpec === 'string' && env.ComSpec !== '' ? env.ComSpec : 'cmd.exe';
    return { kind, file: comspec, argv: ['/d', '/s', '/c', tokens.map(quoteForCmd).join(' ')] };
  }
  if (kind === 'powershell') {
    if (typeof powershellPath !== 'string' || powershellPath === '') {
      throw new PolicyError('internal', '没有可用的 PowerShell 路径');
    }
    return {
      kind,
      file: powershellPath,
      argv: ['-NoProfile', '-NonInteractive', '-Command', tokens.map(quoteForPowerShell).join(' ')],
    };
  }
  throw new PolicyError('not_allowlisted', `命令不在白名单里：${exe}`);
}

/** 探测 PowerShell：优先 PowerShell 7 的 pwsh，退回系统自带的 5.1。 */
export function detectPowershell({ env = process.env, fsImpl = fs } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter((entry) => entry !== '');
  for (const dir of dirs) {
    const candidate = path.join(dir, 'pwsh.exe');
    try {
      if (fsImpl.existsSync(candidate)) return candidate;
    } catch {
      // 忽略
    }
  }
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const fallback = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (fsImpl.existsSync(fallback)) return fallback;
  } catch {
    // 忽略
  }
  return 'powershell.exe';
}

/** 去掉开头的 UTF-8 续字节，免得截断后的文本以乱码开头。 */
function trimUtf8Start(buffer) {
  let index = 0;
  while (index < buffer.length && (buffer[index] & 0xc0) === 0x80) index += 1;
  return buffer.subarray(index);
}

/**
 * 单条流（stdout 或 stderr）的收集器：只留最后 cap 字节。
 * totalBytes 记的是真实产出总量，不是留下来的量——协议里的 bytes 要能反映被截断了多少。
 */
export function createStreamCollector(cap = OUTPUT_CAP_BYTES) {
  const parts = [];
  let size = 0;
  let dropped = false;
  let totalBytes = 0;

  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buffer.length === 0) return;
      totalBytes += buffer.length;
      parts.push(buffer);
      size += buffer.length;
      // 从头丢，但保证留下来的不少于 cap：至少够最后 cap 字节尾巴
      while (parts.length > 1 && size - parts[0].length > cap) {
        const head = parts.shift();
        size -= head.length;
        dropped = true;
      }
    },
    text() {
      let merged = Buffer.concat(parts);
      if (merged.length > cap) {
        merged = merged.subarray(merged.length - cap);
        dropped = true;
      }
      return trimUtf8Start(merged).toString('utf8');
    },
    get truncated() {
      return dropped;
    },
    get totalBytes() {
      return totalBytes;
    },
  };
}

/** stdout / stderr 各一个收集器，合并成结果体要的样子。 */
export function createCollector(cap = OUTPUT_CAP_BYTES) {
  const out = createStreamCollector(cap);
  const err = createStreamCollector(cap);
  return {
    pushStdout: (chunk) => out.push(chunk),
    pushStderr: (chunk) => err.push(chunk),
    text: () => ({ stdout: out.text(), stderr: err.text() }),
    get truncated() {
      return out.truncated || err.truncated;
    },
    get totalBytes() {
      return out.totalBytes + err.totalBytes;
    },
  };
}

/** 杀进程树：Windows 用 taskkill /T /F，别只杀父进程（node 会留下子进程）。 */
export function killProcessTree(pid, { spawnImpl = spawn } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      const killer = spawnImpl('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      killer.on('error', () => {});
      killer.on('exit', () => {});
      return true;
    }
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行一条 exec 命令，返回协议 §1 的结果体（不含 id）。
 * 策略拒绝也走返回值，不抛异常——调用方只管把结果投递回去。
 */
export async function runCommand(payload = {}, options = {}) {
  const {
    roots = DEFAULT_ROOTS,
    defaultCwd = DEFAULT_CWD,
    spawnImpl = spawn,
    killTreeImpl = null,
    powershellPath = detectPowershell(),
    env = process.env,
    fsImpl = fs,
    execPath = process.execPath,
    limits = {},
    onSpawn = null,
  } = options;

  const cap = limits.outputCapBytes ?? OUTPUT_CAP_BYTES;
  const timeoutDefault = limits.defaultTimeoutMs ?? TIMEOUT_DEFAULT_MS;
  const timeoutMax = limits.maxTimeoutMs ?? TIMEOUT_MAX_MS;
  const timeoutMin = limits.minTimeoutMs ?? TIMEOUT_MIN_MS;
  const forceKillWaitMs = limits.forceKillWaitMs ?? 5000;
  const startedAt = Date.now();

  let plan;
  let workdir;
  try {
    const command = typeof payload.command === 'string' ? payload.command.trim() : '';
    if (command === '') throw new PolicyError('not_allowlisted', '命令不能为空');
    const tokens = tokenize(command);
    assertLexicalClean(command, tokens);
    const exe = normalizeExe(tokens[0]);
    if (classify(exe) === null) throw new PolicyError('not_allowlisted', `命令不在白名单里：${tokens[0]}`);
    const args = tokens.slice(1);
    assertArgPolicy(exe, args);
    workdir = checkPath(payload.cwd ?? defaultCwd, { roots, mode: 'cwd', fsImpl });
    assertExecTokenPolicy({ exe, kind: classify(exe), tokens, cwd: workdir, roots, fsImpl });
    plan = buildCommand({ exe, tokens, args, powershellPath, env, fsImpl, execPath });
  } catch (error) {
    return failureResult(error, startedAt);
  }

  const requested = Number(payload.timeoutMs);
  const timeoutMs = Number.isFinite(requested)
    ? Math.min(Math.max(requested, timeoutMin), timeoutMax)
    : Math.min(timeoutDefault, timeoutMax);

  return await new Promise((resolve) => {
    const collector = createCollector(cap);
    let settled = false;
    let timedOut = false;
    let timer = null;
    let guard = null;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (guard !== null) clearTimeout(guard);
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    const finishTimeout = (exitCode) => {
      const text = collector.text();
      settle({
        ok: false,
        exitCode: exitCode ?? null,
        stdout: text.stdout,
        stderr: text.stderr,
        truncated: collector.truncated,
        bytes: collector.totalBytes,
        error: `命令超时：${Math.round(timeoutMs / 1000)} 秒没跑完，进程树已经杀掉`,
        errorCode: 'timeout',
      });
    };

    let child;
    try {
      child = spawnImpl(plan.file, plan.argv, {
        cwd: workdir,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (error) {
      settle({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        bytes: 0,
        error: `起不了进程：${error?.message ?? error}`,
        errorCode: 'spawn_failed',
      });
      return;
    }
    if (typeof onSpawn === 'function') onSpawn(child);

    child.stdout?.on('data', (chunk) => collector.pushStdout(chunk));
    child.stderr?.on('data', (chunk) => collector.pushStderr(chunk));

    child.on('error', (error) => {
      settle({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        bytes: 0,
        error: `起不了进程：${plan.file}（${error?.code ?? 'error'}）`,
        errorCode: 'spawn_failed',
      });
    });

    child.on('close', (code) => {
      if (timedOut) {
        finishTimeout(code);
        return;
      }
      const text = collector.text();
      settle({
        ok: code === 0,
        exitCode: code ?? null,
        stdout: text.stdout,
        stderr: text.stderr,
        truncated: collector.truncated,
        bytes: collector.totalBytes,
        error: code === 0 ? null : `命令退出码 ${code ?? 'null'}`,
        errorCode: null,
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      const kill = killTreeImpl ?? ((pid) => killProcessTree(pid, { spawnImpl }));
      try {
        kill(child.pid);
      } catch {
        // 杀不掉也要往下走，guard 会兜住
      }
      guard = setTimeout(() => finishTimeout(null), forceKillWaitMs);
    }, timeoutMs);
  });
}
