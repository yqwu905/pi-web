# Pi-Web 工程实现规范（给实现者）

本文是 `docs/DESIGN.md` 的工程落地版。**契约文件优先级最高**，实现与本文冲突时以契约文件为准：

| 契约 | 文件 |
|---|---|
| Link 帧协议 + LinkPeer 实现（已完成、已测试） | `packages/shared/src/link.ts` |
| pi RPC / 会话文件类型 | `packages/shared/src/pi.ts` |
| Host ⇄ Agent 方法与事件 | `packages/shared/src/agent-protocol.ts` |
| 会话状态 reducer（agent 与前端共用，已测试） | `packages/shared/src/conversation.ts` |
| Host 持久化模型、同步项定义 | `packages/shared/src/models.ts` |
| REST / WS DTO | `packages/shared/src/api.ts` |
| Host 内部服务接口 | `packages/server/src/core/types.ts` |

UI 视觉稿：`/tmp/claude-0/-home-user/cab7cdeb-e9e3-56ca-be7d-6ab089327a40/scratchpad/design/project/*.dc.html`（11 个画板：Main、SessionTree、Dialogs、AddServer、ServerDetail、ServerSettings、Files、Terminal、Git、SyncCenter、Settings）。前端应还原其布局、文案和配色。

pi 参考（只读）：`node_modules/@earendil-works/pi-coding-agent/`（`docs/*.md`、`dist/**/*.d.ts`、`dist/core/tools/*.js`、`dist/modes/rpc/*`）。**不要凭记忆猜 pi 的行为，查源码。**

---

## 0. 通用约定

- Node ≥ 22.19，ESM，TypeScript strict。代码、注释、日志使用英文；**用户可见的 UI 文案使用简体中文**。
- 风格：tab 缩进、双引号、分号；函数和模块保持小而清晰；不写无意义的注释。
- 依赖已全部安装（见各 `package.json`）。**不要新增依赖，也不要改 package.json**。确需新增时，在最终报告中说明，由集成阶段统一处理。
- 共享代码的导入方式：`import { … } from "@pi-web/shared"`；Link 用 `import { LinkPeer } from "@pi-web/shared/link"`（只在 Node 端使用）。
- 测试：每个模块写 vitest 单元测试，放在 `packages/<pkg>/test/` 或与源文件同目录的 `*.test.ts`。运行方式为 `npm test -w <pkg>`。类型检查用 `npm run typecheck -w <pkg>`。
- 只修改自己负责的目录。其他模块按 `core/types.ts` 的接口编程；它们可能还未完成，因此引用它们的模块导致的类型错误留给集成阶段处理，但自己目录内的代码必须类型正确。
- 安全：所有拼接进 shell 命令的值都要用 `shellQuote()`（shared/util）；绝不把 secret 写进日志。

## 1. 仓库结构

```
packages/
  shared/   协议与纯逻辑（已完成）
  agent/    远端 daemon + bridge + pi 伴随扩展（esbuild 打成 3 个单文件 .mjs）
  server/   Host 服务（npm 包名 pi-web，提供 CLI `pi-web`）
  web/      React SPA（Vite）
```

构建顺序：agent → web → server。server 的 `build.mjs` 用 esbuild 打包 `src/cli.ts` 为 `dist/cli.mjs`（依赖设为 external），并把 `packages/agent/dist/*` 复制到 `dist/agent/`，把 `packages/web/dist` 复制到 `dist/web/`。

---

## 2. packages/agent（远端）

### 2.1 产物（esbuild，platform=node，target=node22，format=esm，bundle，零运行时依赖）
- `dist/pi-web-agent.mjs`：daemon（入口 `src/daemon/main.ts`）
- `dist/bridge.mjs`：stdio↔socket 桥（入口 `src/bridge.ts`）
- `dist/pi-web-ext.mjs`：pi 伴随扩展（入口 `src/companion-ext.ts`）
- `dist/VERSION`：取自 package.json 的 version，并通过 esbuild `define` 注入 `__AGENT_VERSION__`

### 2.2 远端目录（R = 绝对路径的 remoteRoot，例如 `/home/dev/.pi-web`）
```
R/runtime/node-v<ver>-linux-<arch>/   R/runtime/current -> node-v…   (由 Host 部署)
R/pi/<ver>/node_modules/…             R/pi/current -> <ver>          (由 Host 部署)
R/daemon/{pi-web-agent.mjs,bridge.mjs,pi-web-ext.mjs,VERSION}        (由 Host 部署)
R/bin/pi                              包装脚本（由 Host 部署）
R/agent/                              默认的隔离 agentDir
R/run/agent.sock (0600)  R/run/proxy.env (0600)
R/logs/agent.log（5MB 轮转，保留 3 份）
R/state/config.json  R/state/sync-manifest.json  R/state/hash-cache.json
R/state/backup/<label>/…  R/state/incoming/  R/state/exports/
R/trash/sessions/
```
所有目录的权限为 0700。

### 2.3 bridge（`node R/daemon/bridge.mjs --root R`）
1. 连接 `R/run/agent.sock`。如果报 ENOENT 或 ECONNREFUSED：用 `spawn(process.execPath, [R/daemon/pi-web-agent.mjs, "--root", R], { detached: true, stdio: ["ignore", out, out] })` 启动 daemon（out 是 `R/logs/daemon.out` 的 fd），调用 `unref()`，然后每 100ms 重试连接，最多等 15s。
2. 连接成功后，先向 stdout 写入 `LINK_PREAMBLE`，再双向透传 stdin↔socket（raw bytes）。任一端关闭即退出。
3. 失败时把原因写到 stderr，以退出码 1 退出。**stdout 上除 preamble 和帧之外不得输出任何内容。**

### 2.4 daemon
- 启动：
  - 解析 `--root`，创建目录，设置 `process.title = "pi-web-agent"`，忽略 SIGHUP。
  - SIGTERM 或 `agent.shutdown` 时，优雅关闭所有会话（关闭 stdin，等待 5s 后 SIGTERM），然后退出。
  - 单实例：listen socket 遇到 EADDRINUSE 时先尝试连接；能连上说明已有实例，直接退出 0；连不上就 unlink 旧 socket 后重新 listen。
- 每个 socket 连接创建一个 `new LinkPeer(socket, { side: "agent" })` 并注册所有方法。事件广播给所有已连接的 peer。
- 配置：`agent.configure` 时把 AgentConfig 持久化到 `state/config.json`，再 (重新) 启动代理监听，并写入 `run/proxy.env`。`proxy.env` 的内容是 `export HTTPS_PROXY=…` 等 6 个变量加 NO_PROXY；代理关闭时删除该文件。启动时加载已有配置。
- `hello` 返回版本、pid、home、platform、arch、nodeVersion、remoteRoot 和当前 config。
- 日志：写 `logs/agent.log`；info 及以上级别同时以 `agent.log` 事件推送。

### 2.5 会话管理（核心）
- `conv.start`：
  - 如果 `sessionFile` 已被某个未退出的进程服务，直接返回该进程（`attached: true`）。
  - 否则 spawn：`config.nodePath [config.piCliPath, "--mode","rpc", ("--session", file)?, trust==="approve"?"--approve":"--no-approve", "-e", config.companionExtPath, ("--model", "prov/id")?, ("--thinking", lvl)?, ("--name", name)?]`。
    - cwd 为 params.cwd。
    - env 的构造：以 process.env 为基础，删除所有代理变量，再设置
      - `PI_CODING_AGENT_DIR=config.agentDir`
      - `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`
      - 代理开启时：`HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy`=`http://pw:<token>@127.0.0.1:<port>`，`NO_PROXY`/`no_proxy`=noProxy 用逗号连接
      - 依次合并 `config.extraEnv`、`params.env`
      - PATH 前面加上 `R/bin` 和 node 所在目录
  - 启动后发送 `get_state`（超时 60s）；成功后状态置为 idle，返回 `{conv, state}`。若该 convId 或 sessionFile 已有存活进程（包括并发的 start），则等待它启动并返回 `attached: true`，总预算 `CONV_START_TIMEOUT_MS`（90s）。
- stdout 按 **LF 严格分帧**（StringDecoder + indexOf("\n")，去掉行尾 `\r`；**禁止用 readline**）。逐条记录处理：
  - `type==="response"`：按 id 交给等待中的 send。
  - `extension_ui_request`：
    - 对话框类（select/confirm/input/editor）：加入 pendingUi，状态改为 waiting_ui。请求带 timeout 时，设置一个 timeout+1s 的定时器，到期后移除该请求并发出 `pi_web_ui_resolved`。
    - `setStatus` 且 statusKey 为 `COMPANION_STATUS_KEY`：交给等待中的 companion 请求，**不转发**。
    - 其他 setStatus/setWidget：更新 ConvInfo.statuses/widgets，并转发。
  - 其余（会话事件）：转发。`agent_start` 时状态改为 running；`agent_settled` 时，有 pendingUi 则改为 waiting_ui，否则改为 idle。`session_info_changed` 时更新 sessionName。
  - 每条转发的记录分配递增的 seq，存入环形缓冲（3000 条），并 `emitEvent("conv.event", {convId, seq, ts, record})`。状态变化时额外发送 `pi_web_status` 记录和 `conv.info` 事件。
  - 同时把每条记录喂给 shared 的 `applyConvRecord` 维护 tracker 状态（为节省内存，每次应用后把 `messages` 清空），供 `conv.snapshot` 使用。
- `conv.send`：
  - 给命令分配 id `pw-<n>`，写入 stdin，等待 response。默认超时 60s；compact、export_html、abort、bash、fork、clone、new_session、switch_session 以及以 `/` 开头的 prompt（扩展命令，pi 在命令处理完、包括等待对话框之后才回复）的超时为 10 分钟。超时从收到请求开始计算，包括等待仍在启动的进程。
  - 超时常量和 `defaultCommandTimeout` 在 `@pi-web/shared` 的 `timeouts.ts` 中，agent 和 host 共用；host 在 link 上多等 10s，保证先收到 agent 的精确错误。
  - 返回 `{...response, seq: 读到 response 时的 lastSeq}`。
  - new_session、switch_session、fork、clone 成功后：重新 `get_state`，更新 sessionFile 索引，并转发一条 `pi_web_session_changed` 记录。
- `conv.snapshot`：在总预算 `CONV_SNAPSHOT_TIMEOUT_MS`（120s）内依次 `get_state`、`get_messages`（**记录此 response 被读到时的 seq 和 tracker 状态**）、`get_session_stats`（失败可忽略）。组装并返回 ConvSnapshot：runningTools 取 tracker.tools 中 status==="running" 的项。
- `conv.uiResponse`：写入 stdin，从 pendingUi 中移除，转发 `pi_web_ui_resolved`，重新计算状态。
- `conv.companion`：
  - 生成 reqId，发送 prompt `/pi-web-<action> <JSON.stringify({reqId,...args})>`。扩展命令在 streaming 期间也会立即执行。
  - 等待 setStatus(`pi-web:result`) 中 reqId 匹配的 JSON；navigate 和 reload（先等待 pi 空闲）的总超时为 10 分钟，label 为 60s（`companionActionTimeout`，包括首次的 get_commands 检查）。
- `conv.stop`：关闭 stdin，5s 后发 SIGTERM，再过 3s 发 SIGKILL；`force` 时直接 SIGKILL。
- 进程退出时：
  - 状态改为 exited，发送 `pi_web_exit`（附带 stderr 末尾 4KB）和 `conv.info`；
  - reject 所有挂起的请求；
  - ConvInfo 保留 10 分钟供 replay，之后删除。
- stderr：保存末尾 64KB；按行转发为 `pi_web_stderr`（每秒最多 20 行）。
- 空闲回收：每 60s 检查一次。`idleTimeoutMin>0`、状态为 idle 且没有 pendingUi、且 `now-lastActivityAt > timeout` 时，stop 该会话。
- `conv.replay`：返回 seq > afterSeq 的事件。环形缓冲最早一条的 seq 大于 afterSeq+1 时，`complete=false`。

### 2.6 伴随扩展（`pi-web-ext.mjs`，pi 用 jiti 加载，默认导出 `function (pi) {}`）
注册 3 个命令：`pi-web-navigate`、`pi-web-label`、`pi-web-reload`。handler 签名为 `(args: string, ctx)`。
- navigate：`await ctx.waitForIdle()`，然后 `await ctx.navigateTree(targetId, {summarize, customInstructions, label})`。
- label：`pi.setLabel(entryId, label)`。
- reload：`await ctx.waitForIdle()`，然后 `await ctx.reload()`。
- 结果统一通过 `ctx.ui.setStatus("pi-web:result", JSON.stringify({reqId, ok, error?, cancelled?}))` 回报，异常时 ok=false。
- 实现前请先在 `dist/core/extensions/types.d.ts` 中核对 API。

### 2.7 HTTP 代理监听（仅在 config.proxy.enabled 时开启）
- `net.createServer` 监听 `127.0.0.1:port`。读取请求头（最多 64KB，到 `\r\n\r\n` 为止）。
- 校验 `Proxy-Authorization: Basic base64("pw:"+token)`，用 timingSafeEqual 比较。失败返回 407，并带 `Proxy-Authenticate: Basic realm="pi-web"`。
- `CONNECT host:port`：
  - 选择最近连接的 host peer。没有 peer 时返回 `502 Pi-Web host not connected`。
  - `peer.openStream({kind:"proxy",host,port,protocol:"connect"})`。被拒绝时，status 为 403 则返回 403，否则返回 502，body 为错误原因。
  - 成功后回 `HTTP/1.1 200 Connection Established\r\n\r\n`，把请求头之后的剩余字节写入流，然后双向 pipe，任一端出错时销毁两端。
- 绝对 URI 的 HTTP 请求（`GET http://h:p/x HTTP/1.1`）：
  - 打开 protocol:"http" 的流；
  - 把请求行改写为 origin-form，删除 Proxy-Authorization 和 Proxy-Connection，强制 `Connection: close`；
  - 写入改写后的头和剩余字节，然后双向 pipe。
- 维护活动连接计数（供 `agent.status`）。

### 2.8 其他方法
- `sessions.list(cwd)`：
  - 目录为 agentDir/`sessions/<encodeCwdForSessions(cwd)>`。agentDir/settings.json 中的 `sessionDir` 若是绝对路径或 `~` 开头，则以它为准；若是相对路径，相对 cwd 解析。
  - 读取每个 `*.jsonl`：第一行为 header；流式扫描整个文件，统计 message 条目数，取第一条 user 消息的文本（截断到 200 字符），取最后一个 session_info 的 name。
  - 用 (path,size,mtime) 作为缓存键；结果按 modified 倒序。
  - 若该文件有运行中的进程，带上 runningConvId。
- `sessions.read(file)`：解析全部条目。leafId 取最后一个非 header 条目的 id（与 pi `_buildIndex` 一致），branchIds 从 leaf 沿 parentId 回溯得到（root 在前）。单文件上限 64MB，超出报错。
- `sessions.delete`：如果该文件有运行中的进程则拒绝（code `BUSY`）；否则移动到 `R/trash/sessions/<时间戳>-<文件名>`。
- `fs.*`：
  - `~` 展开为 home。
  - list 默认按“目录在前、名称”排序，showHidden 默认 false；`respectGitignore` 时对条目批量执行 `git check-ignore --stdin -z`（不是仓库就跳过）。
  - read 默认 maxBytes 为 2MiB；检测 NUL 字节判定 binary；binary 内容用 base64 返回。
- `git.*`（execFile git，`-c core.quotepath=off`，设置 `GIT_TERMINAL_PROMPT=0`、`LC_ALL=C`）：
  - status：解析 `git status --porcelain=v2 --branch -z`，并用 `git diff --numstat -z`（unstaged）和 `--cached`（staged）补充增删行数。
  - diff：untracked 文件用 `git diff --no-index -- /dev/null <path>`（退出码 1 属正常）；输出上限 4MB，超出时 truncated。
  - log：`git log -n <limit> --format=%H%x00%h%x00%s%x00%an%x00%ae%x00%ct%x00%D%x1e`。
  - 不是仓库时，status 返回 `{isRepo:false, ahead:0, behind:0, files:[]}`。
- `sync.manifest(roots)`：
  - 遍历 agentDir 下的这些 root，用 lstat 获取信息。普通文件计算 sha256，按 (path,size,mtimeMs) 缓存到 `state/hash-cache.json`；symlink 记录 link 字段，sha256 取 `sha256("symlink:"+target)`。
  - 跳过 `sessions/`、`trust.json`、`bin/`、`tools/`、`*.log`。
  - 同时返回 managed 记录（来自 `state/sync-manifest.json`）。
- `sync.apply`：
  1. archivePath 非空时，把它解压到 `state/incoming/<label>/`（使用系统 `tar -xzf`）；
  2. 校验每个 write 的 sha256（link 则校验 readlink）；
  3. 对每个目标路径：若存在且（不在 managed 中，或当前 sha256 ≠ managed[path]），先复制到 `state/backup/<label>/<path>`（保持相对路径），再 mkdir -p 父目录并 rename 到位（link 用 symlink 创建）；
  4. deletes 先做同样的冲突备份，再 unlink，并清理空目录；
  5. 更新 managed（writes 写入新的 sha256，deletes 移除），删除 staging 和 archive；
  6. 返回统计。所有路径都必须校验在 agentDir 内（防止 `..`）。
- `agent.status`：返回会话列表、代理状态、`df` 得到的可用空间（`fs.statfs`）和 loadavg。

### 2.9 测试
- 用 `test/fixtures/fake-pi.mjs`（模拟 RPC 的 JSONL 进程）覆盖会话管理的各条路径：start、send、事件、seq、snapshot、ui、companion、exit、replay。
- 代理：起一个本地 TCP echo/HTTP 服务，验证 CONNECT、HTTP 绝对 URI 和 407。
- sync：在临时目录验证 manifest、apply、冲突备份、symlink 和路径穿越防护。
- sessions 和 git：在临时目录造数据验证。
- 一个用**真实 pi**（`node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`）的集成测试：
  - 在临时 agentDir 写入 models.json，provider 指向测试内启动的本地 mock OpenAI 兼容服务（`/v1/chat/completions` SSE 流）；
  - 验证 conv.start、prompt 能收到流式文本、companion reload 和 label 可用。

---

## 3. packages/server（Host）

### 3.1 模块与负责人

| 目录/文件 | 内容 | 负责 |
|---|---|---|
| `src/core/{paths,log,store,secrets,errors}.ts` | 基础设施 | ssh-deploy |
| `src/ssh/*` | ConnectionManager、ServerConnection、AgentClient、ssh-config 解析、指纹 | ssh-deploy |
| `src/deploy/*` | Deployer、BundleCache、远端脚本 | ssh-deploy |
| `src/hostpi.ts` | HostPi | features |
| `src/proxy/*` | TunnelProxy | features |
| `src/sync/*` | Syncer（inventory/transform/plan/apply/watch）、OAuthKeeper | features |
| `src/conv/*` | ConversationService | api |
| `src/term/*` | Web 终端 | api |
| `src/routes/*`、`src/ws.ts`、`src/app.ts`、`src/context.ts`、`src/cli.ts`、`build.mjs` | HTTP/WS、组装、CLI、构建 | api |

### 3.2 数据目录（`~/.pi-web-host`，0700）
```
settings.json  servers.json  workspaces.json  sync-history.json  state.json
secrets.json   master.key(0600)
cache/node/node-v<ver>-linux-<arch>.tar.gz   cache/pi/pi-<ver>-linux.tar.gz   cache/tmp/
logs/pi-web.log
```

### 3.3 SSH（ssh2）
- 认证方式：
  - key：读取 keyPath（展开 `~`），passphrase 取自 secrets `server:<id>:secret`；
  - password：secret，同时支持 keyboard-interactive 回填密码；
  - agent：使用 `process.env.SSH_AUTH_SOCK`。
- 跳板机：按 `jumpServerIds` 依次连接，前一跳的 `forwardOut("127.0.0.1",0,next.host,next.port)` 得到的流作为下一跳的 `sock`。每一跳都使用自己的配置、认证和指纹。
- 主机指纹：`hostVerifier(keyBuffer)` 计算 `"SHA256:"+base64(sha256(key))`（去掉 `=`），算法名从 key 的第一个 SSH string 解析。
  - 未信任时以 code `HOSTKEY_UNKNOWN` 失败，details 带 `{algorithm,fingerprint}`；
  - 不一致时以 `HOSTKEY_MISMATCH` 失败；
  - testConnection 返回 hostKey 和 hostKeyStatus 供 UI 确认。
- 连接参数：`keepaliveInterval 15000`、`keepaliveCountMax 3`、`readyTimeout 20000`。
- 用户主动 connect 后启用自动重连：退避 2s→60s；用户 disconnect 则停止。启动时 `autoConnectAll()` 连接所有已部署的服务器。
- exec：用 `conn.exec(cmd)`，收集 stdout/stderr，支持 stdin 和超时。
- upload：SFTP fastPut 带进度；SFTP 失败时回退到 `exec("mkdir -p dir && cat > file")`，用 stdin 流式写入；写完按需 chmod。
- Agent link：
  - exec `<R>/runtime/current/bin/node <R>/daemon/bridge.mjs --root <R>`；
  - 用 `new LinkPeer(channel, {side:"host", preamble: LINK_PREAMBLE})` 建立 link，`await peer.ready`，超时 20s。失败时的错误需包含 stderr 和 preambleJunk；
  - 调用 `hello`；
  - 收到的 hello.agentVersion 与 Deployer.agentVersion 不同时，更新 deployState 为 outdated，但仍可使用；
  - 每 15s 执行一次 `link.ping` 测量延迟；
  - link 断开后，若 SSH 仍在，则退避重连 link。
  - 发出 `agent-connected` 和 `agent-disconnected` 事件。
- 状态：ServerRuntimeStatus 聚合 connection 和 agent 信息，以及其他服务通过 updateStatus 写入的字段；每次变化都 emit `status`。

### 3.4 部署
- probe：执行一段 POSIX sh 脚本，输出 `key=value` 行，包括：
  - `uname -s/-m/-r`、HOME、SHELL；
  - glibc（`getconf GNU_LIBC_VERSION`，失败时用 `ldd --version`）；
  - tar/gzip/curl 是否存在；
  - `df -Pk $HOME`；
  - 已有安装：`cat R/daemon/VERSION`、`readlink R/pi/current`、`readlink R/runtime/current`；
  - 外网检测：先用 `curl -sS -m 5 -o /dev/null https://api.anthropic.com`，没有 curl 时用 `timeout 5 bash -c 'exec 3<>/dev/tcp/api.anthropic.com/443'`。

  SFTP 是否可用通过打开 sftp 子系统来判断。arch 为 x86_64 时映射为 x64，aarch64 映射为 arm64，其他值都判为不支持。glibc < 2.28 以及没有 tar/gzip 都列为 issue。
- BundleCache：
  - Node：
    - 下载源与 settings.nodeSource 对应：official 为 `https://nodejs.org/dist/`，npmmirror 为 `https://npmmirror.com/mirrors/node/`，custom 使用自定义 base。
    - `latest-22` 从 `<base>/index.json` 中选取最高的 v22.x（≥22.19，且 files 包含 `linux-x64` 或 `linux-arm64`）。
    - 下载 `node-v<ver>-linux-<arch>.tar.xz`，用 `SHASUMS256.txt` 校验。
    - 使用 Host 系统的 `tar -xJf` 解压，再 `tar -czf` 重新打包为 tar.gz（顶层目录保持 `node-v<ver>-linux-<arch>/`），放入缓存。
    - **出站 HTTP 必须使用 undici 的 `EnvHttpProxyAgent`**，以遵循 Host 的 HTTPS_PROXY/NO_PROXY，或优先使用 settings.upstreamProxy。
  - pi：
    - 在 `cache/tmp/pi-<ver>/` 执行 `npm install --prefix . --no-audit --no-fund --omit=dev @earendil-works/pi-coding-agent@<ver> [--registry]`。npm 取自 `process.execPath` 同目录，找不到时用 PATH 中的。
    - 当 prunePrebuilds 开启时，删除所有路径中含 `prebuilds/(darwin|win32)-*` 或 `native/(darwin|win32)` 的目录。
    - 执行 `tar -czf` 打包 `node_modules` 和 `package.json` 到 `cache/pi/pi-<ver>-linux.tar.gz`。该包与架构无关。
  - targetPiVersion：policy 为 host 时，取 PATH 中 `pi --version` 的输出，没有则取依赖 `@earendil-works/pi-coding-agent` 的版本；否则取 pinned 版本。
- deploy（后台 job，每个服务器同时只有一个，进度以 DeployProgress 事件推送）。步骤依次为：
  1. probe
  2. prepare（生成缓存包）
  3. upload_node：已存在同版本时跳过，除非 force
  4. upload_pi：同上
  5. upload_agent
  6. install：执行远端脚本
     - 解压到 `*.tmp` 后再 mv；
     - 建立 `current` 软链；
     - 写 `R/bin/pi`；
     - 版本不变时不覆盖已有目录；
     - 删除 `.upload`。
  7. start_agent：版本变化时，先请求旧 daemon 执行 `agent.shutdown`，再通过 bridge 启动新的
  8. sync（`syncer.run(id,"deploy")`）
  9. selfcheck：执行 `R/bin/pi --version`，调用 `agent.status`；代理开启时在远端用 node 一行脚本经代理 CONNECT `api.anthropic.com:443`，看是否返回 200

  完成后写入 `ServerConfig.deployed`。取消时中止上传并标记 cancelled。

  `R/bin/pi` 的内容：
  ```sh
  #!/bin/sh
  export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-<agentDir>}"
  export PI_OFFLINE="${PI_OFFLINE:-1}"
  [ -f "<R>/run/proxy.env" ] && . "<R>/run/proxy.env"
  exec "<R>/runtime/current/bin/node" "<R>/pi/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"
  ```
- buildAgentConfig：
  - agentDir 按 agentDirMode 取 `<R>/agent` 或 `<home>/.pi/agent`；
  - nodePath、piCliPath、piPackageDir 走 current 软链；
  - proxy 字段来自 server.proxy，token 来自 secrets（缺失时生成 32 字节 hex 并保存）；
  - noProxy 为 `settings.defaultNoProxy ∪ server.proxy.noProxy`；
  - idleTimeoutMin 取自 server 配置。
- uninstall：先 `agent.shutdown`，再执行 `rm -rf R`。keepSessions 为真时，先把 `R/agent/sessions` 移到 `~/pi-web-sessions-backup-<ts>`。
- restartAgent：先 `agent.shutdown`，再重连 agent。

### 3.5 TunnelProxy
- attach 时调用 `client.peer.onStreamOpen(handler)`，按以下规则处理每个流：
  - `server.proxy.mode !== "tunnel"` 时，reject(403)；
  - 放行判断：scope 为 tools 且 toolsPolicy 为 all 时全部放行；否则用 `matchDomain(host, providerDomains ∪ extraDomains)` 判断；
  - 拒绝时记录 denied 统计，并 reject(403, "目标不在白名单：host")。
- 出站：
  - settings.upstreamProxy 或 Host 环境变量 HTTPS_PROXY（遵循 NO_PROXY）存在时，向上游发送 HTTP CONNECT；
  - 否则直接 `net.connect`；
  - 连接成功后 `control.accept()` 并双向 pipe，失败则 reject(502, 原因)。
- providerDomains 的来源：
  - `hostPi.modelRuntime().getProviders()` 中各 provider 及其 models 的 baseUrl 主机名；
  - 加上动态端点的通配：
    - `*.githubcopilot.com`
    - `chatgpt.com`、`*.chatgpt.com`
    - `*.openai.azure.com`、`*.cognitiveservices.azure.com`
    - `*.googleapis.com`（仅在配置了对应 provider 时）
    - `*.amazonaws.com`
  - 缓存 60s，HostPi invalidate 时清空。
- stats：统计 active、byHost（requests、bytesUp/Down、lastAt）和 denied；变化时节流（1/s）发布 `proxy:<serverId>`，并通过 `connections.updateStatus` 写入 status.proxy。

### 3.6 同步（Syncer）
- **期望文件树（desired）**，从 Host agentDir 按启用的同步项生成：
  - 跳过 `SYNC_EXCLUDES` 和 `.DS_Store`。
  - symlink：目标在同一根目录内时保留为 link；目标在外部时，取消引用并复制内容。
  - 指向 agentDir 外部的本地路径（settings 中的 packages、extensions、skills、prompts、themes 里的本地路径，即非 `npm:`/`git:`/`http(s):`/`ssh:` 开头的条目）：如果存在，按 `external/<sha1(abs)前12位>-<basename>` 放入期望树，并改写 settings 中的引用。agentDir 内的绝对路径改写为相对路径。
  - agentsSkills：Host 的 `~/.agents/skills` 映射到远端 agentDir 下的 `agents-skills/`，并把 `"agents-skills"` 追加到 settings 的 `skills` 数组。
  - settings.json 变换：
    - 删除 `npmCommand`、`shellPath`、`httpProxy`；`sessionDir` 是绝对路径时删除；
    - 代理为 tunnel 时注入 `transport:"sse"`；
    - scope 为 llm 时，把 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy` 加在 `shellCommandPrefix` 前面（与已有前缀用换行连接）；
    - 最后 deepMerge `server.sync.settingsOverride`。
  - auth.json 变换：type 为 `oauth` 的条目保留其他字段，只把 `refresh` 替换为 `"pi-web-managed"`。
  - 警告（写入 SyncPlan.warnings）：
    - key 以 `!` 开头（shell 命令取值），或 key 形似环境变量名；
    - models.json 的 baseUrl 指向内网或 localhost（提示加入 NO_PROXY）；
    - mcp.json 中的 stdio 命令用 npx/uvx（离线可能不可用）；
    - 插件包中含非 linux 平台的 `*.node` 文件。
  - 哈希缓存按 (path,size,mtimeMs) 存到 `state.json` 的 `syncHashCache` 键。
- **计划**：roots 为启用同步项的顶层名，加上 external（若有）和 agents-skills（若启用）。调用 `sync.manifest(roots)` 后：
  - desired 中的每个路径，与远端 sha 不同时，按远端是否存在记为 add 或 update；`conflict = 远端存在 && managed[p] !== 远端sha`。
  - managed 中位于 roots 内、但不在 desired 中的路径：远端仍存在时记为 delete，conflict 判断同上。
  - **禁用的同步项不删除远端文件**（roots 不包含它们）。
- **执行**：
  - 把待写文件复制或硬链接到 `cache/tmp/sync-<id>/`，生成的内容直接写入，用 npm `tar` 包 `tar.c({gzip:true,cwd,portable:true})` 打包；
  - 上传到 `R/state/incoming/<id>.tar.gz`，调用 `sync.apply`，然后写入 SyncRecord；
  - 有变更时记录 `lastChangeAt` 并 emit `configUpdated`；
  - 同一服务器的同步串行执行。
- **自动同步**：
  - 用 chokidar 监听 Host agentDir（忽略 sessions、日志、trust.json）、启用 agentsSkills 时的 `~/.agents/skills`，以及外部路径；设置 `ignoreInitial`，awaitWriteFinish 为 500ms。
  - 变化后防抖 2s，对 `auto && 已连接` 的服务器执行 run("auto")。
  - 离线服务器记为 pendingSync，下次 `onAgentConnected` 时以 "connect" 触发补同步。
- **status**：
  - 每台服务器每个同步项的状态，由最近一次计划（preview 或 run 后缓存）得出：disabled、synced、pending（有条目）、conflict（有冲突条目）、unknown（从未计算）。
  - Host 文件变化后，在后台为已连接的服务器重新计算计划，随后 emit `status`。
- **pushAuth**：只针对 auth 同步项执行一次 run，trigger 记为 "oauth"。

### 3.7 OAuthKeeper
- 使用 `ModelRuntime.create({ authPath: <hostAgentDir>/auth.json, modelsPath: <hostAgentDir>/models.json, refreshOnCreate: false })`，即 HostPi.modelRuntime()。
- 每 60s 读取 Host auth.json。对每个 `type:"oauth"` 的条目，当 `expires - now < 20min` 时，调用 `runtime.getAuth(provider, { minOAuthValidityMs: 20*60_000 })` 触发 pi 自身的刷新，结果会在文件锁下写回 Host 的 auth.json。
- Host auth.json 发生变化时（无论刷新来自本服务还是 Host 上的 pi），执行 `syncer.pushAuth()`，并记录各服务器的推送结果。
- pi-ai 的刷新请求用的是全局 `fetch`，而 pi 只在自己的 CLI 入口里安装代理 dispatcher。因此 `cli.ts` 启动时用 `installHostHttpDispatcher`（`src/core/http.ts`）安装全局 undici dispatcher：优先 settings.upstreamProxy（运行时修改即生效），否则 HTTP(S)_PROXY，两种情况都遵循 NO_PROXY。BundleCache 的下载复用同一种 dispatcher。
- settings.hostAgentDir 修改后，Syncer 和 OAuthKeeper 通过 `rewatch()` 改为监视新目录（Syncer 把新目录的全部内容视为已变化）。
- status 返回每个 OAuth provider 的 expiresAt、lastRefreshAt、refreshAt（= expiresAt − 20min）和 pushed。

### 3.8 ConversationService
- 维护 convId → `{serverId, workspaceId, info, lastSeq}` 的映射。
- `attach`：
  - 监听 `conv.event`：更新 lastSeq，发布 `conv:<id>`；
  - 监听 `conv.info`：更新映射，发布 `convs`，并通过 updateStatus 更新 conversationsRunning/Waiting；
  - 调用 `conv.list`：对已知会话执行 `conv.replay(lastSeq)` 补发事件；`complete=false` 时发布一条合成的 `pi_web_session_changed`。
  - workspaceId 用 cwd 与该服务器各 workspace.path 匹配，匹配不到为 null。
- `open`：
  - 未连接时先 connect；
  - 调用 `conv.start`，参数包括 cwd=workspace.path、trust、model/thinking（请求值优先，其次 workspace.defaults）、env=workspace.env。
- `snapshot`：调用 `conv.snapshot`，并计算 `configStale = syncer.lastChangeAt(serverId) > info.startedAt`。前端在对话打开期间还订阅 `sync` 话题，收到本服务器的 `configUpdated` 时直接显示“配置已更新”。
- `exportHtml`：
  - 先 `rpc export_html {outputPath: R/state/exports/<convId>-<ts>.html}`；
  - 再用 `createReadStream` 读取，读取结束后删除远端文件；
  - 文件名取会话名或 id。

### 3.9 HTTP / WS（Fastify）
- 路由表见第 5 节。错误统一返回 `ApiErrorBody`：ApiError 按其 status，参数校验失败返回 400，其余返回 500。
- 安全：
  - Host 头只接受 `127.0.0.1`、`localhost`、`[::1]` 和 settings.listenHost（防 DNS rebinding）；
  - 非 GET 请求必须带 Origin 头，且 Origin 必须与 Host 一致（开发模式额外放行 Vite 端口）；
  - 开启 accessToken 时：
    - 启动时打印 `http://host:port/?token=…`；
    - 访问 `/?token=` 时设置 HttpOnly、SameSite=Strict 的 cookie `pi_web_token`；
    - `/api` 和 `/ws` 必须带 cookie 或 `Authorization: Bearer`。
- `/ws`：
  - 连接后先发 hello；
  - 按客户端的 subscribe/unsubscribe 维护订阅，publish 只发给订阅者；
  - 每 30s 发送 ping，客户端回 pong。
- `/ws/term?serverId&cwd&cols&rows`：
  - 执行 `openPty({command: \`cd ${q(cwd)} 2>/dev/null; export PATH=${q(R+"/bin")}:"$PATH"; exec "${SHELL:-/bin/sh}" -l\`})`；
  - 二进制帧双向透传；
  - 文本帧 `{type:"resize"}` 调用 `channel.setWindow(rows, cols, 0, 0)`；
  - 退出时发送 `{type:"exit"}` 后关闭。
- 静态资源：webDistDir 存在时托管，并对 `/` 下的非 API 路径回退到 index.html。
- CLI：`pi-web [--host 127.0.0.1] [--port 7878] [--data-dir DIR] [--dev]`。

---

## 4. packages/web（React SPA）

- 技术栈：Vite 8 + React 19 + TS + Tailwind v4（`@tailwindcss/vite`）、react-router 7、zustand 5、TanStack Query 5、react-markdown + remark-gfm + rehype-highlight、@xterm/xterm、lucide-react 图标（stroke 风格）、diff（计算 edit 工具的 diff）。
- 视觉：严格沿用画布的 Graphite 深色风格。设计 token 在 `src/styles.css` 的 `@theme` 中定义：
  - 背景与面板：bg #0E1014、panel #13161C、raised #191D25、code #0B0D11、border #262C37 / #33405A、selected #1F2A3D
  - 文字：fg #E7E9EE、code #C9CFD9、fg-2 #A9B1BE、fg-3 #8A93A3
  - 强调与状态：accent #6AA6FF、link #8DBBFF、primary #2F6FDB；成功 #3CC8B4/#7FE0D2；警告 #F0A03C/#F7C47E；删除 #F4A29A
  - 字体：Inter + JetBrains Mono
- 开发时由 Vite 代理 `/api` 和 `/ws` 到 `http://127.0.0.1:7878`。
- 目录：
  ```
  src/main.tsx  src/App.tsx(路由)  src/styles.css
  src/api/{client.ts,ws.ts,hooks.ts}        REST 封装(类型取自 shared/api)、WS 单连接+话题引用计数+自动重连、useTopic
  src/stores/{servers.ts,convs.ts,toasts.ts,conversation.ts}
  src/components/ui/*                        Button/IconButton/Input/Select/Textarea/Checkbox/Radio/Switch/Segmented/Card/Badge/StatusDot/Modal/Tabs/Toast/Spinner/ProgressBar/EmptyState/KeyValue
  src/components/{Markdown,CodeBlock,DiffView,JsonView}.tsx
  src/layout/{AppShell,Header,Sidebar}.tsx   侧栏：服务器→工作区→会话树(懒加载)、运行/等待徽标、新建对话
  src/pages/servers/{AddServer,ServerDetail,ServerSettings}.tsx
  src/pages/sync/SyncCenter.tsx  src/pages/settings/Settings.tsx
  src/pages/chat/*                           对话
  src/pages/workspace/{Files,Terminal,Git}.tsx + NewWorkspaceDialog + WorkspaceSettingsDialog
  src/lib/{format.ts,diff-parse.ts}
  ```
- 路由：
  - `/` 重定向到最近一个对话，没有时进入空状态页
  - `/servers/new`、`/servers/:serverId`、`/servers/:serverId/settings`
  - `/w/:workspaceId/chat`（新对话）、`/w/:workspaceId/chat/:sessionId`（sessionId 取文件名中的 uuid 部分，通过 sessions 列表映射到文件）
  - `/w/:workspaceId/files`、`/w/:workspaceId/terminal`、`/w/:workspaceId/git`
  - `/sync`、`/settings`
- 对话页：
  - 打开会话时：
    - 若有运行中的进程（runningConvId），取 snapshot 后订阅 `conv:<id>`，并用 shared 的 `applyConvRecord` 只应用 seq 大于 snapshot.seq 的事件；
    - 否则以只读模式渲染 `sessions/read` 的 `entriesToMessages`，用户发送消息时再 open 进程（带 sessionFile）。
    - `needsResync` 为真时重新取 snapshot。
  - 消息渲染：
    - user：文本和图片；assistant：Markdown，thinking 折叠；
    - 工具卡片：toolCall 与 toolResult 按 toolCallId 配对，运行中的状态和 partialResult 取自 state.tools。
      - bash：流式输出
      - read：文件内容
      - edit：用 diff 包对 oldText/newText 计算并渲染；参数格式以 pi 的 `dist/core/tools/edit.js` 为准
      - write：内容预览
      - grep、find、ls 等：结果文本
      - 其他工具：显示 JSON
    - bashExecution、custom（display 为真时）、compactionSummary、branchSummary 也要渲染。
  - 输入框：
    - `/` 补全来自 get_commands，过滤掉 `pi-web-` 开头的命令；
    - `!cmd` 发送 RPC bash，`!!cmd` 带 excludeFromContext；
    - 支持图片粘贴和拖拽（base64）；
    - 运行中 Enter 为 steer，Alt+Enter 为 follow_up；
    - Esc 先 clear_queue，把返回的文本放回输入框，再 abort；
    - 显示队列。
  - 控件：
    - 模型选择（get_available_models + set_model）、思考级别（get_available_thinking_levels）；
    - 右侧面板：上下文占用条和用量（get_session_stats，运行结束后刷新）、会话路径；
    - 操作：树视图、Fork（get_fork_messages + fork）、Clone、压缩（可附带指令）、导出 HTML、重命名、自动压缩和自动重试开关；
    - configStale 时显示“配置已更新”卡片，提供“重新加载”（companion reload）。
  - 扩展 UI：
    - pending 对话框以模态呈现，有 timeout 时显示倒计时；
    - notify 显示为 toast；
    - statuses 和 widgets 显示在输入框上方；
    - set_editor_text 时填充输入框。
  - 会话树模态：
    - 用 get_tree 构建，筛选项有：默认、隐藏工具、仅用户、仅已标记、全部；
    - 预览选中的条目，可执行“跳转到此处”（navigate，可选摘要）、Fork（仅 user 条目）、添加标签（label）。
- 工作区页面：
  - Files：懒加载目录树；查看器支持代码高亮、Markdown 预览/源码切换、图片预览、下载、在对话中引用（跳转到对话并在输入框预填 `@path`）。
  - Terminal：xterm 多标签，用 FitAddon 适配尺寸并发送 resize。
  - Git：变更分组；diff 支持行内和并排两种视图；显示提交记录；“发给 pi 审阅”跳转到对话并预填 diff 摘要。
- 管理页面：
  - 添加服务器向导，5 步：
    1. 连接：从 `~/.ssh/config` 导入，test，指纹确认；
    2. 主机验证：trust；
    3. 探测；
    4. 部署：订阅 `deploy:<id>` 显示进度和日志；
    5. 同步：配置同步项后完成。
  - 服务器概览、服务器设置；
  - 同步中心：清单、矩阵、差异预览、OAuth、历史；
  - 全局设置。

---

## 5. REST 路由表（/api，JSON）

```
GET    /meta                                   → MetaResponse
GET    /settings                               → HostSettings
PUT    /settings            UpdateSettingsRequest → HostSettings
GET    /ssh-config                             → { hosts: SshConfigHost[] }
POST   /auth/login          { token }          → { ok: true }   (设置 cookie)

GET    /servers                                → { servers: ServerView[] }
POST   /servers             CreateServerRequest → ServerView
POST   /servers/test        { host, port, username, auth: ServerAuthInput, jumpServerIds?, serverId? } → TestConnectionResult
                            （serverId：编辑已有服务器时传入；host:port 不变则用其已信任的指纹，auth.secret 省略则用已保存的密码/口令）
GET    /servers/:id                            → ServerView
PUT    /servers/:id         UpdateServerRequest → ServerView
DELETE /servers/:id                            → { ok: true }
POST   /servers/:id/test                       → TestConnectionResult
POST   /servers/:id/trust-host-key TrustHostKeyRequest → ServerView
POST   /servers/:id/connect                    → ServerView
POST   /servers/:id/disconnect                 → ServerView
POST   /servers/:id/probe                      → ProbeResult
POST   /servers/:id/deploy  DeployRequest      → DeployProgress
GET    /servers/:id/deploy                     → { job: DeployProgress | null }
POST   /servers/:id/deploy/cancel              → { ok: true }
POST   /servers/:id/restart-agent              → { ok: true }
POST   /servers/:id/uninstall UninstallRequest → { ok: true }
GET    /servers/:id/agent-status               → AgentStatus
GET    /servers/:id/logs?tail=200              → AgentLogsResponse
GET    /servers/:id/proxy                      → ProxyStats
POST   /servers/:id/proxy/allow { domain }     → ServerView
GET    /servers/:id/fs/list?path=&showHidden=  → FsListResponse       (目录选择器，path 可为 ~)
POST   /servers/:id/fs/mkdir { path }          → { ok: true, path }

GET    /workspaces                             → { workspaces: WorkspaceView[] }
GET    /servers/:id/workspaces                 → { workspaces: WorkspaceView[] }
POST   /servers/:id/workspaces CreateWorkspaceRequest → WorkspaceView
PUT    /workspaces/:wsId    UpdateWorkspaceRequest → WorkspaceView
DELETE /workspaces/:wsId                       → { ok: true }
GET    /workspaces/:wsId/sessions              → SessionListResponse
GET    /workspaces/:wsId/fs/list?path=&showHidden=&hideIgnored= → FsListResponse  (path 相对工作区或绝对；默认工作区根)
GET    /workspaces/:wsId/fs/read?path=&maxBytes= → FsReadResponse
GET    /workspaces/:wsId/fs/download?path=     → 二进制流
GET    /workspaces/:wsId/git/status            → GitStatusResponse
GET    /workspaces/:wsId/git/diff?path=&area=&context= → GitDiffResponse
GET    /workspaces/:wsId/git/log?limit=        → GitLogResponse

GET    /sessions/read?serverId=&file=          → SessionFileResponse
DELETE /sessions?serverId=&file=               → { trashedTo }

GET    /conversations                          → { conversations: ConversationView[] }
POST   /workspaces/:wsId/conversations OpenConversationRequest → ConversationView
GET    /conversations/:convId/snapshot         → ConversationSnapshot
POST   /conversations/:convId/rpc ConversationRpcRequest → RpcResponse (& seq)
POST   /conversations/:convId/ui-response ConversationUiResponseRequest → { ok: true }
POST   /conversations/:convId/navigate NavigateRequest → CompanionActionResponse
POST   /conversations/:convId/label LabelRequest → CompanionActionResponse
POST   /conversations/:convId/reload           → CompanionActionResponse
POST   /conversations/:convId/stop { force? }  → { ok: true }
GET    /conversations/:convId/replay?afterSeq= → ConvReplayResult
GET    /conversations/:convId/export           → text/html 下载

GET    /sync/inventory                         → HostInventory
GET    /sync/status                            → SyncStatusResponse
POST   /sync/preview        { serverId }       → SyncPlan
POST   /sync/run            SyncRunRequest     → SyncRunResponse
GET    /sync/history?limit=                    → { records: SyncRecord[] }
GET    /oauth                                  → OAuthStatusResponse
POST   /oauth/:provider/refresh                → OAuthStatusResponse

GET    /cache                                  → CacheResponse
DELETE /cache/:name                            → { ok: true }
POST   /cache/import-node?fileName=  (raw body) → CacheEntry
```
WebSocket：`/ws`（话题见 `api.ts`），`/ws/term`（见 `api.ts` 末尾）。

---

## 6. 端到端验证（集成阶段）
本机安装 sshd，用一个测试用户把 `localhost:2222` 当作“服务器”，走完整流程：
1. 添加服务器；
2. 部署（Node 用官方源下载；pi 从 npm 安装）；
3. 在 Host 的 agentDir 放入 models.json，指向一个本地 mock OpenAI 兼容服务，域名用 `mock-llm.test`，经 `/etc/hosts` 解析到 127.0.0.2；
4. 在远端对话，LLM 流量经隧道代理到 Host；
5. 验证 fork/tree/label/reload、文件浏览、git、终端；
6. 验证自动同步和 OAuth 推送（用伪造的 oauth 条目验证变换）。

以上流程已自动化为 API 级 E2E：`npm run build && npm run e2e:api`（`e2e/api-e2e.mjs`，需 root + OpenSSH；`E2E_KEEP=1` 保留临时目录，`E2E_VERBOSE=1` 打印全部事件）。它像浏览器一样驱动 REST + `/ws` + `/ws/term`，并额外覆盖扩展对话框（ui-response）、提示模板/技能展开、write 工具、abort、Pi-Web 重启后的事件补发与卸载。

浏览器 E2E：`npm run build && npm run e2e:ui`（`e2e/ui-e2e.mjs`，与 API E2E 共用 `e2e/lib/env.mjs` 中的环境：sshd fixture、mock LLM、Host agent 目录、数据目录）。用 Playwright 驱动 Chromium（1440×960）走完添加服务器向导（连接 → 主机指纹 → 探测 → 离线部署 → 同步）、新建工作区（目录选择器 + 新建文件夹）、对话（流式回复、bash 工具卡片、信息面板、会话树与标签、模型/思考选择、`/` 补全与提示模板、刷新恢复、离开再返回）、文件/Git/终端、同步中心（预览、手动同步）、全局设置、服务器设置，以及断开/重连。每一步截图到 `e2e/screenshots/`，出现页面异常、未预期的 console.error、失败的 `/api` 请求或整页滚动即判失败。需要全局或本地安装的 `playwright` 包与 `PLAYWRIGHT_BROWSERS_PATH` 下的 Chromium；`E2E_HOLD=1` 在结束后保留环境便于手动调试。
