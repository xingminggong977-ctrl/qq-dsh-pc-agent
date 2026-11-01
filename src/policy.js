/**
 * 本地安全策略的唯一出处：roots、命令白名单、危险参数、硬拒目录、体量上限。
 * 依据 docs/pc-bridge-protocol.md §3。改这里等于改安全边界，改完必须重跑 test/。
 */

export const VERSION = '1.0.0';

/** 协议 §3：stdout/stderr 各留最后 32KB。 */
export const OUTPUT_CAP_BYTES = 32 * 1024;
/** 协议 §3：单条超时默认 30s、上限 120s。 */
export const TIMEOUT_DEFAULT_MS = 30_000;
export const TIMEOUT_MAX_MS = 120_000;
export const TIMEOUT_MIN_MS = 1_000;
/** 协议 §1 read：maxBytes 默认 65536。 */
export const READ_MAX_BYTES = 64 * 1024;
/** 协议 §2：write 的 content 最大 1MB。 */
export const WRITE_MAX_BYTES = 1024 * 1024;
/** 协议 §1：心跳 10s 一次，与 poll 独立。 */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** 协议 §1：poll 的 waitSeconds 夹在 1..30，线上用 25。 */
export const POLL_WAIT_SECONDS = 25;
export const POLL_WAIT_MIN = 1;
export const POLL_WAIT_MAX = 30;
/** 协议 §2：bridge 在途上限 4 条，本地照这个数限并发。 */
export const INFLIGHT_MAX = 4;
/** 协议 §1：结果投递要重试而不是丢弃，同一个 id 由服务端去重。 */
export const RESULT_RETRY_ATTEMPTS = 8;
export const RESULT_RETRY_BASE_MS = 500;
export const RESULT_RETRY_MAX_MS = 30_000;

/** 协议 §3 给出的四个 root（去重后三个；写死在这里，改动看 README）。 */
export const DEFAULT_ROOTS = Object.freeze([
  'C:\\Users\\lenovo\\Documents',
  'C:\\Users\\lenovo\\Desktop',
  'C:\\Users\\lenovo\\Downloads',
]);
export const DEFAULT_CWD = 'C:\\Users\\lenovo\\Documents';

/** 白名单：cmd 内建，只能经 cmd.exe /d /s /c 跑。 */
export const CMD_BUILTINS = Object.freeze(['dir', 'type']);
/** 白名单：PowerShell cmdlet，经 -NoProfile -NonInteractive -Command 跑。 */
export const POWERSHELL_CMDLETS = Object.freeze([
  'get-childitem',
  'get-content',
  'get-location',
  'get-date',
  'get-process',
  'test-path',
  'select-string',
  'resolve-path',
]);
/** 白名单：真正的 exe，直接 spawn(argv)，永不过 shell。 */
export const NATIVE_EXES = Object.freeze(['where', 'findstr', 'git', 'node', 'python', 'py', 'npm']);
/** 心跳里报给 bridge 的 execAllow（协议 §1）。 */
export const DEFAULT_EXEC_ALLOW = Object.freeze([
  ...CMD_BUILTINS,
  ...NATIVE_EXES,
  ...POWERSHELL_CMDLETS,
]);

/**
 * 硬拒目录名（大小写不敏感）：即使字面落在 root 内也拒。
 * 这些目录里放的是凭据与配置，一次误读就等于把钥匙交出去。
 */
export const HARD_DENY_SEGMENTS = Object.freeze([
  '.ssh',
  '.dsh',
  '.gnupg',
  '.aws',
  '.azure',
  '.git-credentials',
  '.npmrc',
  '.netrc',
  'appdata',
  '.config',
]);

/** write 额外拒的扩展名（协议 §3）。 */
export const WRITE_DENY_EXTENSIONS = Object.freeze(['.exe', '.dll', '.bat', '.ps1', '.cmd', '.msi']);
/** write 额外拒的目录名（协议 §3：所有 .git 目录内容）。 */
export const WRITE_DENY_SEGMENTS = Object.freeze(['.git']);

/**
 * 编排字符（协议 §3）：任何 token 命中其一就判 not_allowlisted。
 * 我们从不 shell:true，但 cmd.exe / powershell 这一段本身就是解释器，
 * 所以词法层必须先挡住「一条命令变多条」的所有写法。
 */
export const ORCHESTRATION_TOKENS = Object.freeze([';', '&', '|', '>', '<', '^', '`', '$(', '%~']);
/** 换行等于第二条命令，任何控制字符一律拒。 */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 高危参数：命中即 not_allowlisted（协议 §3）。 */
export const DENY_ARGS = Object.freeze({
  node: Object.freeze(['-e', '--eval', '-c', '-m', '-p', '--print']),
  python: Object.freeze(['-e', '--eval', '-c', '-m']),
  py: Object.freeze(['-e', '--eval', '-c', '-m']),
  // --git-dir / --work-tree 不是「执行代码」，但它俩能把目标仓库指到 roots 之外，
  // 等于绕开「write 不许碰 .git」：仓库历史与 hooks/ 一旦可写，下一次 git 调用就能跑出策略边界。
  git: Object.freeze(['-c', '--exec-path', '--upload-pack', '--git-dir', '--work-tree']),
});
/** npm 只允许这三个动作（协议 §3）。 */
export const NPM_ALLOWED_VERBS = Object.freeze(['ls', 'view', '--version']);

/**
 * 只有「列目录」这两条命令可以带通配符。
 * `type .s*\id_rsa` 这种写法能绕过路径策略读到硬拒目录里的内容，所以内容类命令一律不许 glob。
 */
export const GLOB_ALLOWED_EXES = Object.freeze(['dir', 'get-childitem']);
/** 解释器（cmd / powershell）的 token 里不许出现变量展开。 */
export const INTERPRETER_EXPANSION_CHARS = Object.freeze(['%', '$']);

/** 一次拒绝：errorCode 直接进结果体，message 是给人看的中文一句。 */
export class PolicyError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.name = 'PolicyError';
    this.errorCode = errorCode;
  }
}

/** 心跳里报的 capabilities（协议 §1）。 */
export const CAPABILITIES = Object.freeze({ exec: true, read: true, write: true });
