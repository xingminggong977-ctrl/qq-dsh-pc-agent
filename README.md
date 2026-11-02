# qq-dsh-pc-agent

**Lets a remote agent reach your desktop — a very small part of it.**

A tiny HTTP service that runs on your own machine and answers three verbs: run a command,
read a file, write a file. The agent on the server talks to it through an authenticated
relay, so nothing has to be exposed to the public internet.

## In short

- **You need:** Node 22+ on the desktop, and a token shared with the bridge.
- **Try it:** `node --test "test/**/*.test.js"` — 166 tests, no network needed.
- **Safety:** every path is resolved and checked against an allow-list; `exec` has a timeout
  and a size cap; the service refuses to start without a token.

---
# pc-agent

QQ 机器人「PC 工具通道」的本机代理。**云端永远不连进来**：它自己用 SSH 反向端口转发把云端的
`127.0.0.1:8787` 借到本机 `127.0.0.1:18787`，然后长轮询地取命令、在本机执行、把结果送回去。
协议见 `../docs/pc-bridge-protocol.md`，本目录只依赖 `node:` 内建模块，**零 npm 依赖**。

```
云端 bridge (127.0.0.1:8787，不对外开端口)
      ▲  出站 HTTP + Bearer NODE_TOKEN
      │
  ssh -N -L 18787:127.0.0.1:8787        ← tunnel.js，断了指数退避重连
      │
pc-agent (本机)
   ├─ 心跳每 10s：自述 capabilities + policy（roots / execAllow）
   ├─ 长轮询 25s：拿 command { id, kind, deadlineAt, payload }
   ├─ 执行：exec / read / write，全程白名单 + 路径策略
   └─ 投递结果：失败指数退避重试，同一个 id 重投（服务端按 id 去重）
```

## 装

```powershell
# 1. 配置（token 也可以放环境变量 PC_TOKEN，环境变量优先）
mkdir "$env:USERPROFILE\.dsh-qq-pc" -Force
copy config.example.json "$env:USERPROFILE\.dsh-qq-pc\config.json"
notepad "$env:USERPROFILE\.dsh-qq-pc\config.json"   # 填 token、按需改 roots

# 2. 先看它打算用哪套策略（不连服务器，不需要 token）
node src/index.js --print-policy

# 3. 前台跑一次，确认隧道和心跳都通
node src/index.js --verbose

# 4. 确认没问题再装成登录自启（当前用户的计划任务，不需要管理员）
powershell -ExecutionPolicy Bypass -File install-task.ps1 -Install
powershell -ExecutionPolicy Bypass -File install-task.ps1 -Status
```

卸载：`install-task.ps1 -Uninstall`。临时不起隧道：`node src/index.js --no-tunnel`（直连 `baseUrl`）。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `token` | 空（必填） | 云端 bridge 的 `NODE_TOKEN`；环境变量 `PC_TOKEN` 优先 |
| `agentId` | `pc-<主机名小写>` | 云端用它认人；环境变量 `PC_AGENT_ID` 优先 |
| `baseUrl` | 隧道开：`http://127.0.0.1:<localPort>`；关：`http://127.0.0.1:<remotePort>` | 留空就用默认，环境变量 `PC_BASE_URL` 优先 |
| `roots` | `Documents` / `Desktop` / `Downloads` | 允许触碰的目录；含 `.ssh` 之类硬拒目录会直接拒绝启动 |
| `defaultCwd` | `%USERPROFILE%\Documents` | 命令缺省工作目录，必须落在 `roots` 内且真实存在 |
| `powershellPath` | 自动探测 | 留空则先找 `pwsh.exe`，再退回 Windows PowerShell 5.1 |
| `heartbeatMs` | `10000` | 夹在 2000..120000 |
| `pollWaitSeconds` | `25` | 夹在 1..30 |
| `inflightMax` | `4` | 并发执行上限（1..8）；超了只记警告，不丢命令 |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |
| `tunnel.*` | 见 `config.example.json` | `host` / `keyPath` / `localPort` / `remotePort` / 退避参数 / `enabled` |

## 安全边界（这里的每一条都有对应的测试用例）

- **永不 `shell: true`**。白名单 exe 一律 `spawn(exe, argv)`；只有 `dir` / `type` 这类 cmd 内建和
  `Get-ChildItem` 这类 cmdlet 才包一层 `cmd.exe /d /s /c` 或 `powershell -NoProfile -NonInteractive -Command`，
  且包之前先做词法检查。
- **词法拒绝**：命令里出现 `; & | > < ^`、反引号、`$(`、`%~` 或控制字符，直接 `not_allowlisted`，
  连 spawn 都不会发生。
- **路径判定顺序**：`realpath`（解开符号链接与 `..`）→ 是否落在 `roots` 内（大小写不敏感、分隔符归一）
  → 硬拒目录。任一步不过就是 `path_denied`。`..` 是逐段弹**真实**父目录，符号链接指出去也算越界。
- **硬拒目录**（哪怕字面就落在 root 内）：`.ssh` `.dsh` `.gnupg` `.aws` `.azure` `.git-credentials`
  `.npmrc` `.netrc` `AppData` `.config`。
- **write 额外拒**：`*.exe *.dll *.bat *.ps1 *.cmd *.msi`，以及 `.git\` 下的任何文件。
- **参数级拦截**：`node`/`python` 拒 `-e --eval -c -m`；`git` 拒 `-c --exec-path --upload-pack`
  和 `!` 开头的首位置别名；`npm` 只允许 `ls` / `view` / `--version`。
  `git` 还拒 `--git-dir` / `--work-tree`（`=` 与空格两种写法都拦）：这俩能把仓库或工作区指到
  roots 之外，等于绕开「write 不许碰 `.git`」——`.git\hooks` 一旦可写，下一次 `git` 就能跑出边界。
  `git -C <path>` 仍放行，但那个 path 要照样过路径策略。
- **exec 的参数也走路径策略**：白名单命令拿到的参数如果是路径，同样按 `read` 规则校验，
  所以 `type C:\Windows\win.ini` 会被 `path_denied` 挡住；`type` / `findstr` 这类内容类命令还不许带 glob。
- **超时杀进程树**：默认 30s（夹在 1s..120s），超时用 `taskkill /T /F /PID` 连子孙进程一起收掉，
  不是只杀父进程。stdout / stderr 各只留最后 32KB 并置 `truncated: true`。
- **结果不丢**：投递失败按 500ms 起、30s 封顶指数退避重试（最多 8 次），每次都用同一个 `id`。

## 协议实现对照（§1）

| 端点 | 方向 | 请求体 | 响应 |
| --- | --- | --- | --- |
| `POST /node/pc/heartbeat` | 出站，10s | `agentId/hostname/platform/version/capabilities/policy` | `{ ok, now, serverVersion }` |
| `POST /node/pc/poll` | 出站，长轮询 | `{ agentId, waitSeconds }`（夹 1..30） | `{ ok, command }`，无命令是 `command: null` |
| `POST /node/pc/result` | 出站，每命令一次 | `{ id, ok, exitCode, stdout, stderr, truncated, bytes, durationMs, error, errorCode }` | `{ ok, accepted }` |

`errorCode` 取值：`not_allowlisted` `path_denied` `timeout` `spawn_failed` `too_large` `internal`。
`/node/pc/enqueue` 与 `/node/pc/status` 是云端侧的接口，PC 端不调用。

## 自检与测试

```powershell
node src/index.js --help          # 用法
node src/index.js --print-policy  # 当前生效的 roots / execAllow / baseUrl
node --test "test/**/*.test.js"   # 166 个用例（含本地假桥烟测，不连真服务器）
```

测试覆盖的正是最容易出事的地方：`..` 逃逸、符号链接（junction）逃逸、硬拒目录、白名单外命令、
编排字符、`-e/-c`、参数路径越界、超时杀进程树、输出截断、心跳与 poll 的请求体形状、
以及隧道断线后的退避序列 `1s→2s→4s→8s→16s→32s→60s→60s`。

`test/smoke.test.js` 会真起一个 http server 假装云端，跑通
心跳 → 取命令 → 本机真执行 → 投递结果 的完整往返（含一条被拦截的命令）。

## 已知限制

- 契约写的是 `pwsh`（PowerShell 7），**本机没有装**，所以 `exec.js` 先探测 `pwsh.exe`，
  找不到就退回 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（5.1）。
  两者都能跑同一批 cmdlet，但 5.1 的语法比 7 老。
- Windows 上 `npm` 只有 `npm.cmd` 垫片，`spawn('npm')` 在 `shell:false` 下必然失败，
  所以 npm 命令实际走 `node <npm-cli.js> <args>`。
- `write` 不会自动建父目录（建目录等于凭空扩大可写面积），父目录不存在就 `internal`。
- PC 关机或没登录期间没人轮询，云端会看到 `offline`；开机登录后自启任务会把它带回来。
- **白名单里的 `node` / `python` 等于「roots 内任意代码执行」**：这是契约 §3 的既定取舍，
  不是疏忽——给的就是「在我电脑上干活」的能力，本项目不假装自己是沙箱。
- `deadlineAt` 只透传给结果、不据以丢弃命令；同时在跑的命令数超过 `inflightMax` 只写告警日志。
  两个都由云端 sweep 兜底。
