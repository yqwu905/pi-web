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
R/run/agent.sock (0600)  R/run/proxy.env (0600)  R/run/env.sh (0600，服务器级环境变量)
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
- 配置：`agent.configure` 时把 AgentConfig 持久化到 `state/config.json`，再 (重新) 启动代理监听；**监听成功后**才写入 `run/proxy.env`。`proxy.env` 的内容是 `export HTTPS_PROXY=…` 等 6 个变量加 NO_PROXY，外面包一层“只有写入它的 daemon 进程仍在运行时才导出”的判断（`kill -0 <pid>` 且 `/proc/<pid>/cmdline` 含 daemon 脚本路径），因为端口固定，daemon 不在时可能被同机其他用户占用。代理关闭、监听失败、stopAccepting/关闭时删除该文件；启动时先删除遗留的文件，加载已有配置并监听后再写。
- 服务器级环境变量：`agent.configure` 保存配置后，把 `config.extraEnv` 原子写入 `run/env.sh`（0600），每个变量一行 `[ -n "${_piweb_keep_env-}" ] && [ -n "${NAME+x}" ] || export NAME='value'`（POSIX 单引号转义：`'` → `'\''`，值可含引号、`$`、反引号、空格、换行）：Web 终端直接 source，全部导出；`R/bin/pi` 设置 `_piweb_keep_env=1` 后 source，调用方环境中已有的同名变量保持不变（`NAME=x pi`、对话中运行的 `pi` 继承的 workspace 变量优先）。不是 shell 标识符的名字和含 NUL 的值跳过（Host 已拒绝）。extraEnv 为空时删除该文件。它不含与 daemon 绑定的秘密，daemon 停止或重启时保留；每次 `agent.configure`（包括每次重连）都会重写，所以离线期间修改的变量在 Link 恢复后才写到服务器。pi 进程仍通过 extraEnv 取得这些变量（见 2.5），文件只供 `R/bin/pi` 和 Web 终端使用。该文件从 agent 0.1.2 起才写入。
- 代理令牌：交给 pi 进程（环境变量、proxy.env）的是 daemon 每次启动随机生成的令牌，不是 Host 下发的令牌；Host 令牌只用于部署自检，仍被接受。部署自检只在 agent 报告代理已监听时才向端口发送令牌。
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
      - 依次合并 `config.extraEnv`（服务器级环境变量）、`params.env`（workspace 环境变量，同名时覆盖前者）
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
  - 同时把每条记录（连同它的 ts）喂给 shared 的 `applyConvRecord` 维护 tracker 状态（为节省内存，每次应用后把 `messages` 清空），供 `conv.snapshot` 使用。
  - 生成计时（`ConversationState.timing`）：reducer 用记录的 ts（agent 主机时钟，与 pi 的 `message.timestamp` 同一时钟）记下流式回复首个 text/thinking/toolcall delta 的时间，在 assistant 的 message_end 时按 `String(message.timestamp)` 保存 `{ttftMs: 首个 delta − message.timestamp, decodeMs: message_end − 首个 delta}`，最多 500 条；不带 ts 时不记录。
- `conv.send`：
  - 给命令分配 id `pw-<n>`，写入 stdin，等待 response。默认超时 60s；prompt、compact、export_html、abort、bash、fork、clone、new_session、switch_session 的超时为 10 分钟（pi 在准备好运行之后才回复 prompt：之前可能先自动压缩会话（一次完整的 LLM 摘要）、运行 before_agent_start 钩子；扩展斜杠命令在处理完、包括等待对话框之后才回复）。超时从收到请求开始计算，包括等待仍在启动的进程。
  - 超时常量和 `defaultCommandTimeout` 在 `@pi-web/shared` 的 `timeouts.ts` 中，agent 和 host 共用；host 在 link 上多等 10s，保证先收到 agent 的精确错误。
  - 返回 `{...response, seq: 读到 response 时的 lastSeq}`。
  - new_session、switch_session、fork、clone 成功后：重新 `get_state`，更新 sessionFile 索引，并转发一条 `pi_web_session_changed` 记录。
- `conv.snapshot`：在总预算 `CONV_SNAPSHOT_TIMEOUT_MS`（120s）内依次 `get_state`、`get_messages`（**记录此 response 被读到时的 seq 和 tracker 状态**）、`get_session_stats`（失败可忽略）。组装并返回 ConvSnapshot：runningTools 取 tracker.tools 中 status==="running" 的项；timing 取 tracker.timing（旧版 agent 没有该字段）。
- `conv.uiResponse`：写入 stdin，从 pendingUi 中移除，转发 `pi_web_ui_resolved`，重新计算状态；返回 `delivered`：对话框已不在 pendingUi（已被回答）或已过 pi 的 timeout 时为 false。
- `conv.companion`：
  - 生成 reqId，发送 prompt `/pi-web-<action> <JSON.stringify({reqId,...args})>`。扩展命令在 streaming 期间也会立即执行。
  - 等待 setStatus(`pi-web:result`) 中 reqId 匹配的 JSON；navigate 和 reload（先等待 pi 空闲）的总超时为 10 分钟，label 为 60s（`companionActionTimeout`，包括首次的 get_commands 检查）。
- `conv.stop`：关闭 stdin，5s 后发 SIGTERM，再过 3s 发 SIGKILL；`force` 时立即 SIGTERM，1s 后 SIGKILL（pi 的 SIGTERM 处理会结束 bash 工具的独立进程组，直接 SIGKILL 会留下孤儿进程）。
- 对话框清理：pi 在 AbortSignal 触发时静默 resolve 对话框（stdout 不输出任何内容）。没有 timeout 的对话框，如果是在某次运行中发起的，该运行 agent_settled 时视为已失效；如果是在斜杠命令执行期间（无运行）发起的，该命令收到 response 时视为已失效；两者都发 `pi_web_ui_resolved`。
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
- rpiv-todo 任务清单：rpiv 的面板用 setWidget 组件工厂，RPC 模式会丢弃。伴随扩展在 session_start、session_tree、session_compact、agent_end、`todo` 的 tool_execution_end（含 codemode 的嵌套调用）、user 或 `todo` toolResult 的 message_end 之后，用 shared 的 `replayTodos` 重放 `ctx.sessionManager.getBranch()`（包括压缩前的条目），值有变化时 `ctx.ui.setStatus("pi-web:todos", encodeTodoStatus(snapshot))`（没有清单时清除）。
  - 处理函数只同步记下 ui 和 sessionManager，再用 setTimeout(0) 合并成一次重放：pi 在 await 完扩展的 message_end 处理之后才把消息写入会话，延后才能读到。
  - 重放规则与 rpiv 的 `replayFromBranch` 一致：分支上有合法的 `rpiv-todo-state` 自定义条目时只看它们，否则看 `todo` toolResult 的 details；快照 `{v:1, tasks（不含已删除）, nextId, hidden}`，hidden 是在最后一条用户消息时已经完成、现在仍是已完成的任务（对应 rpiv 面板在 agent_start 时收起上一回合已完成的任务；clear 使 nextId 变小后重新计算）。
  - 每个扩展实例的第一次重放总会推送（包括清除），避免 reload 或切换会话后留下上一个会话的清单；定时器里的异常一律吞掉（抛出会让 pi 退出），session_shutdown 时取消尚未执行的重放。
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
  3. **先处理 deletes**：做冲突备份，再 unlink，并清理空目录；父路径（agentDir 以下的任一层）已是符号链接时，只移除 managed 记录、不动文件（否则会删掉链接目标里的文件）；
  4. 再处理 writes：对每个目标路径，若存在且（不在 managed 中，或当前 sha256 ≠ managed[path]），先复制到备份目录 `<label>/<path>`（保持相对路径），再 mkdir -p 父目录并 rename 到位（link 用 symlink 创建）；父路径中有符号链接时拒绝写入（不经由链接写到别处）；
  5. adopt：当前 sha256 与给定值相同的文件直接记入 managed（不写入），使以后 Host 端的删除能同步过去；
  6. 更新 managed（writes 写入新的 sha256，deletes 移除），处理过程中每秒及结束时（finally）都会落盘；删除 staging 和 archive；
  - 备份目录：agentDir 位于 R 内时为 `R/state/backup/`；共享 agent 目录（`~/.pi/agent`）时为 `<agentDir>/.pi-web-backup/`，卸载删除 R 时不会一并删除用户原有文件的备份；
  7. 返回统计。所有路径都必须校验在 agentDir 内（防止 `..`）。
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
  - 每 15s 执行一次 `link.ping` 测量延迟；连续 3 次超时（10s）才断开 link，但只要 ping 窗口内收到过任何字节就不算失败（回复可能排在一条大消息后面）；
  - LinkPeer 的写缓冲超过上限（默认 64MB + 32MB）时销毁该 peer（消息不受背压控制，停读的对端会让缓冲无限增长）；agent 端的 peer 60s 内没有收到任何数据即视为对端已失效并销毁，Host 重连后重放或重新同步；
  - link 断开后，若 SSH 仍在，则退避重连 link。
  - disconnect()/remove() 与 disconnectAgent() 会使正在进行的 SSH 连接 / link 建立作废：迟到的 SSH 客户端被关闭、迟到的 link 被关闭，并以 CANCELLED 失败；被 remove 的连接对象之后拒绝任何使用。
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
  if [ -f "<R>/run/env.sh" ]; then _piweb_keep_env=1; . "<R>/run/env.sh"; unset _piweb_keep_env; fi
  [ -f "<R>/run/proxy.env" ] && . "<R>/run/proxy.env"
  exec "<R>/runtime/current/bin/node" "<R>/pi/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"
  ```
- buildAgentConfig：
  - agentDir 按 agentDirMode 取 `<R>/agent` 或 `<home>/.pi/agent`；
  - nodePath、piCliPath、piPackageDir 走 current 软链；
  - proxy 字段来自 server.proxy，token 来自 secrets（缺失时生成 32 字节 hex 并保存）；
  - noProxy 为 `settings.defaultNoProxy ∪ server.proxy.noProxy`；
  - idleTimeoutMin 取自 server 配置；
  - extraEnv 为 server.env（服务器级环境变量）。
- uninstall：先 `agent.shutdown`，再删除 R。只删除带安装标记 `R/.pi-web-root`（或旧版安装布局 `R/daemon/VERSION`）的目录，且只删除 pi-web 自己创建的条目，R 为空时再删除 R 本身；拒绝 `/`、`$HOME` 及其上级目录。脚本使用 `umask 077`；keepSessions 为真时，先把 `R/agent/sessions`（chmod -R go-rwx）移到 `~/pi-web-backups/sessions-<ts>`（目录 0700）；旧版留在 `R/state/backup` 的同步备份同样移到 `~/pi-web-backups/sync-backup-<ts>`。
- 安装目录：保存前先规范化（去掉末尾斜杠、`.`、重复斜杠），不允许 `..`、家目录本身和 `/`；探测时若安装目录是家目录或其上级、已存在且不是 Pi-Web 安装目录（非空且无标记），列为问题；安装脚本也会再次检查。
- 探测还检查用户空间：`getconf LONG_BIT` 为 32，或缺少对应架构的动态链接器（x64：`/lib64/ld-linux-x86-64.so.2`，arm64：`/lib/ld-linux-aarch64.so.1`）时列为问题；安装时先运行一次 `node -v`。
- pi 版本：策略为 host 时，Host 上的 pi 低于 `MIN_PI_VERSION`（与 server 包依赖的下限一致）则改为部署 Pi-Web 自带的版本并在部署日志中警告。pi 的 CLI 路径取已安装包 package.json 的 `bin.pi`，记录到 `deployed.piCli`，bin/pi 和 AgentConfig.piCliPath 都用它（旧安装没有该字段时用 `dist/bundle/cli.js`）。
- `R/bin/pi` 先 source `run/env.sh`（只补上调用方没有的变量）再 source `proxy.env`，代理设置始终优先。env.sh 由 agent 0.1.2 起写入，包装脚本只在部署时写入：由旧版 agent（< 0.1.2）部署的服务器显示为“需要升级”，对话中的 pi 进程已能通过 extraEnv 取得服务器级变量，但 Web 终端和 bin/pi 都要在升级（重新部署）后才能读到；服务器设置的“环境变量”分区此时显示提示。
- 修改 agentDirMode 后，重写 `R/bin/pi`（其中写死了默认的 PI_CODING_AGENT_DIR）并更新 deployed.agentDir；服务器离线时在下次建立 Link 后补做。
- restartAgent：先 `agent.shutdown`，再重连 agent。

### 3.5 TunnelProxy
- attach 时调用 `client.peer.onStreamOpen(handler)`，按以下规则处理每个流：
  - `server.proxy.mode !== "tunnel"` 时，reject(403)；
  - 目标主机名：`127.1`、`2130706433`、`0x7f.1` 这类数字简写不是主机名，reject(400)；
  - 名单判断：provider 端点按 `host:port` 精确匹配（动态端点为 443 端口的服务级模式）；`extraDomains` 用 `matchDomain`；scope 为 tools 且 toolsPolicy 为 all 时放行任意名字；
  - 地址判断（所有 scope）：在 Host 上解析目标（`dns.lookup` all），任何一个地址是回环、未指定、本机网卡地址、私有网段（RFC1918、CGNAT）、链路本地（169.254/16、fe80::/10）、ULA、组播，或映射/内嵌到这些地址的 IPv6 时，只有“用户精确指定”的目标（provider baseUrl 的 host:port，或 extraDomains 中的精确条目，通配不算）才放行；Pi-Web 自己的监听端口在本机地址上永远拒绝；
  - 拒绝时记录 denied 统计，并 reject(403, 原因)。
- 出站：
  - settings.upstreamProxy 或 Host 环境变量 HTTPS_PROXY（遵循 NO_PROXY）存在时，向上游发送 HTTP CONNECT（按名字；Host 能解析时先做上面的地址判断）；
  - 否则直接连接已检查过的 IP（不再二次解析，防 DNS rebinding）；
  - 连接成功后 `control.accept()` 并双向 pipe，失败则 reject(502, 原因)。
- providerDomains 的来源：
  - `hostPi.modelRuntime().getProviders()` 中各 provider 及其 models 的 baseUrl 的 `host:port`（端口缺省 443/80）；
  - 加上动态端点（443），只用服务级模式，不用 `*.amazonaws.com`、`*.googleapis.com` 这种任何人都能在其下架设服务器的通配：
    - `*.githubcopilot.com`、`chatgpt.com`、`*.chatgpt.com`
    - `*.openai.azure.com`、`*.cognitiveservices.azure.com`、`*.ai.azure.com`
    - `bedrock(-runtime)(-fips).{aws-region}.amazonaws.com(.cn)`、`sts`/`portal.sso`/`oidc` 的区域端点
    - `{gcp-region}-aiplatform.googleapis.com`、`aiplatform.googleapis.com`、`oauth2`/`sts`/`iamcredentials.googleapis.com`
  - 缓存 60s，HostPi invalidate 时清空。
- stats：统计 active、byHost（requests、bytesUp/Down、lastAt）和 denied；变化时节流（1/s）发布 `proxy:<serverId>`，并通过 `connections.updateStatus` 写入 status.proxy。

### 3.6 同步（Syncer）
- **期望文件树（desired）**，从 Host agentDir 按启用的同步项生成：
  - 跳过 `SYNC_EXCLUDES` 和 `.DS_Store`。
  - symlink：目标在同一根目录内时保留为 link；目标在外部时，取消引用并复制内容。
  - 指向 agentDir 外部的本地路径（settings 中的 packages、extensions、skills、prompts、themes 里的本地路径，即非 `npm:`/`git:`/`http(s):`/`ssh:` 开头的条目）：如果存在，按 `external/<sha1(abs)前12位>-<basename>` 放入期望树，并改写 settings 中的引用。agentDir 内、属于已启用同步项的路径保留（绝对路径改写为相对路径）；agentDir 内但不属于任何同步项的路径（如 `./local/my-pkg`）按外部路径处理；属于未启用同步项或被排除的路径保留原样并给出警告。
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
  - desired 与远端 sha 相同、但 managed 中没有记录（或记录不同）的路径放入 `adopt`。
  - **禁用的同步项不删除远端文件**（roots 不包含它们）。
  - **读不到来源时不删除**：Host 的 settings.json / auth.json 无法解析时，`settings.json`+`external` / `auth.json` 列入 protectedRoots，其下不产生 delete；Host agent 目录不存在时，所有 roots 都受保护，计划为空并给出警告。只有文件确实不存在（目录存在）才视为删除。
- **执行**：
  - 把待写文件复制或硬链接到 `cache/tmp/sync-<id>/`，生成的内容直接写入，用 npm `tar` 包 `tar.c({gzip:true,cwd,portable:true})` 打包；
  - 上传到 `R/state/incoming/<id>.tar.gz`，调用 `sync.apply`，然后写入 SyncRecord；
  - 有变更时记录 `lastChangeAt` 并 emit `configUpdated`；
  - 同一服务器的同步串行执行。
- **自动同步**：
  - 用 chokidar 监听 Host agentDir（忽略 sessions、日志、trust.json）、启用 agentsSkills 时的 `~/.agents/skills`，以及外部路径；设置 `ignoreInitial`，awaitWriteFinish 为 500ms。
  - 变化后防抖 2s，对 `auto && 已连接` 的服务器执行 run("auto")。
  - 离线服务器记为 pendingSync，下次 `onAgentConnected` 时以 "connect" 触发补同步：auto 服务器做完整同步；手动同步的服务器只补 pendingItems（例如失败的 OAuth 推送只补 auth），不做未经确认的完整同步。
  - 非手动触发（oauth、auto、connect、deploy）的同步失败（异常或部分文件失败）时，把失败的同步项记入 pendingItems；服务器仍在线时按 30s 起、翻倍、最长 10 分钟的退避重试，成功后清除。这样 OAuth 推送失败后不必等到重连，access token 也不会在服务器上过期。
- **status**：
  - 每台服务器每个同步项的状态，由最近一次计划（preview 或 run 后缓存）得出：disabled、synced、pending（有条目）、conflict（有冲突条目）、unknown（从未计算）。
  - Host 文件变化后，在后台为已连接的服务器重新计算计划，随后 emit `status`。
- **pushAuth**：只针对 auth 同步项执行一次 run，trigger 记为 "oauth"。

### 3.7 OAuthKeeper
- 使用 `ModelRuntime.create({ authPath: <hostAgentDir>/auth.json, modelsPath: <hostAgentDir>/models.json, refreshOnCreate: false })`，即 HostPi.modelRuntime()。
- 每 60s 读取 Host auth.json。对每个 `type:"oauth"` 的条目，当 `expires - now < 20min` 时，调用 `runtime.getAuth(provider, { minOAuthValidityMs: 20*60_000 })` 触发 pi 自身的刷新，结果会在文件锁下写回 Host 的 auth.json。
- Host auth.json 发生变化时（无论刷新来自本服务还是 Host 上的 pi），执行 `syncer.pushAuth()`，并记录各服务器的推送结果。auth.json 无法解析（例如手写时多了逗号、或读到写了一半的文件）或 Host agent 目录不存在时不推送，也不更新已见的哈希，等文件恢复有效后再推送。推送失败的重试由 Syncer 的失败重试负责。
- pi-ai 的刷新请求用的是全局 `fetch`，而 pi 只在自己的 CLI 入口里安装代理 dispatcher。因此 `cli.ts` 启动时用 `installHostHttpDispatcher`（`src/core/http.ts`）安装全局 undici dispatcher：优先 settings.upstreamProxy（运行时修改即生效），否则 HTTP(S)_PROXY，两种情况都遵循 NO_PROXY。BundleCache 的下载复用同一种 dispatcher。
- settings.hostAgentDir 修改后，Syncer 和 OAuthKeeper 通过 `rewatch()` 改为监视新目录（Syncer 把新目录的全部内容视为已变化）。
- status 返回每个 OAuth provider 的 expiresAt、lastRefreshAt、refreshAt（= expiresAt − 20min）和 pushed。

### 3.8 ConversationService
- 维护 convId → `{serverId, workspaceId, info, lastSeq}` 的映射。
- `attach`：
  - 监听 `conv.event`：更新 lastSeq，发布 `conv:<id>`；
  - 监听 `conv.info`：更新映射，发布 `convs`，并通过 updateStatus 更新 conversationsRunning/Waiting；
  - 调用 `conv.list`：对已知会话执行 `conv.replay(lastSeq)` 补发事件；`complete=false` 时发布一条合成的 `pi_web_session_changed`。
  - 写入 ConvInfo（conv.list、conv.info 事件、snapshot、open 的结果）时，同一进程（pid 与 startedAt 相同）的 lastSeq 比已存的小则忽略：在 replay 往返期间到达的较新 conv.info 不会被较旧的 conv.list 覆盖。
  - workspaceId 用 cwd 与该服务器各 workspace.path 匹配，匹配不到为 null。
- `open`：
  - 未连接时先 connect；
  - 调用 `conv.start`，参数包括 cwd=workspace.path、trust、model/thinking（请求值优先，其次 workspace.defaults）、env=workspace.env。
- `snapshot`：调用 `conv.snapshot`，并计算 `configStale = syncer.lastChangeAt(serverId) > info.startedAt`。前端在对话打开期间还订阅 `sync` 话题，收到本服务器的 `configUpdated` 时直接显示“配置已更新”。
- `exportHtml`：
  - 先 `rpc export_html {outputPath: R/state/exports/<convId>-<ts>.html}`；
  - 再用 `createReadStream` 读取，读取结束后删除远端文件；
  - 文件名取会话名或 id。

### 3.8a 归档会话（`src/core/archive.ts`）
- 归档只在 Pi-Web 中隐藏会话：标记保存在 Host，不调用 agent，服务器上的会话文件不动；服务器离线时也能归档和恢复。
- 存储：Store 的 keyed state（`state.json`，原子写入），键 `archived:<serverId>`，值为 `{ [会话文件绝对路径]: { archivedAt, cwd? } }`；没有记录时删除该键。重复归档保留第一次的 archivedAt。
- 列表：`GET /workspaces/:wsId/sessions` 和 `GET /servers/:id/workspaces`（刷新会话数）在 `sessions.list` 成功后给已归档的会话填上 `SessionSummary.archivedAt`（agent 从不设置它）。Host 记住每个工作区最近一次成功列出的会话文件，工作区的 sessionCount 在生成视图时按当前归档记录计算、只计未归档的会话，所以归档和恢复（包括离线时）立即反映在 `GET /workspaces` 等的会话数上。离线时列表的行为不变（仍需 agent，不另做缓存）。
- 清理：
  - `DELETE /sessions` 成功后删除该会话的记录；`DELETE /servers/:id` 删除 `archived:<id>`；
  - 列表成功时，把出现在列表中的记录标上该工作区路径 `cwd`；之后同一工作区的成功列表读到了该文件所在的目录（列表中有同目录的其他会话）却没有该文件时，带此 `cwd` 的记录被删除（会话文件已不存在）。只删除在这次 `sessions.list` 开始之前归档的记录，避免与刚出现的会话竞争；列表失败时不清理。agent 列出的目录随配置变化（agentDirMode、`sessionDir`、`PI_CODING_AGENT_SESSION_DIR`），列表中没有该目录的会话（包括空列表）时保留记录：旧文件可能还在，换回原目录后仍是归档状态。
- 运行中（ConversationService 中 `info.sessionFile === file` 且状态为 running 或 waiting_ui）的会话不能归档：409 `BUSY`“会话正在运行，无法归档”。空闲的进程可以继续运行。
- 变化时发布 WS 话题 `sessions`：`SessionsTopicEvent { serverId, file, archivedAt | null, deleted? }`（归档、恢复，以及删除了已归档的会话，后者带 `deleted: true`）。网页只更新该服务器的工作区的缓存列表；删除事件只触发重新获取，不会把会话当作恢复显示到活动列表中。

### 3.9 HTTP / WS（Fastify）
- 路由表见第 5 节。错误统一返回 `ApiErrorBody`：ApiError 按其 status，参数校验失败返回 400，其余返回 500。
- 安全：
  - Host 头只接受 `127.0.0.1`、`localhost`、`[::1]` 和 settings.listenHost（防 DNS rebinding）；
  - 非 GET 请求必须带 Origin 头，且 Origin 必须与 Host 一致（开发模式额外放行 Vite 端口）；
  - 带有不必要转义（`%61` 之类的字母/数字/`-._~`）的路径一律 400；
  - 每个响应带 Content-Security-Policy（图片只允许同源与 data:/blob:）；
  - 开启 accessToken 时：
    - 启动时打印 `http://host:port/?token=…`，前端读取后存入本源（含端口）的 localStorage 并从地址栏移除；
    - 不使用 cookie（cookie 不按端口隔离，会发给同一主机的其他端口）；旧版本的 `pi_web_token` cookie 收到即清除；
    - 鉴权按路由匹配结果决定（默认拒绝）：只有 `/api/meta`、`/api/auth/login`、SPA 静态文件和 404 处理公开；
    - REST 带 `Authorization: Bearer`；WebSocket 握手在 `Sec-WebSocket-Protocol` 中带 `pi-web, pi-web.token.<token>`（服务端只回 `pi-web`）；
    - 浏览器直接下载（`<a href>`）先 `POST /auth/ticket` 换一次性票据（60s，绑定路径），以 `?ticket=` 访问。
- `/ws`：
  - 连接后先发 hello；
  - 按客户端的 subscribe/unsubscribe 维护订阅，publish 只发给订阅者；
  - 每 30s 发送 ping，客户端回 pong。
- `/ws/term?serverId&cwd&cols&rows`：
  - 执行 `openPty({command: \`cd ${q(cwd)} 2>/dev/null; [ -f ${q(R+"/run/env.sh")} ] && . ${q(R+"/run/env.sh")}; export PATH=${q(R+"/bin")}:"$PATH"; exec "${SHELL:-/bin/sh}" -l\`})`（服务器级环境变量在登录 shell 启动前导出，新开的终端即可 `echo $NAME`；env.sh 由 agent ≥ 0.1.2 写入，内容是 agent 最近一次收到的配置）；
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
  src/api/archive.ts                         归档/恢复：立即更新缓存的会话列表再重新获取，"sessions" 话题同步其他标签页
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
  - `/` 重定向到最近一个对话（跳过已归档的会话），没有时进入空状态页
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
    - 工具卡片：toolCall 与 toolResult 按 toolCallId 配对，运行中的状态和 partialResult 取自 state.tools；耗时取 state.tools，没有时（刷新后、只读）取 toolResult 消息的 `durationMs`。
      - 所有卡片默认折叠（运行中、出错的也一样），折叠时标题行显示图标、工具名、目标（`todo` 显示为“3 项任务”“#3 → 已完成”等）、状态和耗时；出错时标题下多一行错误摘要，write/edit 生成参数时显示“生成中 · N 行”。
      - 消息区右上角的“展开/折叠全部工具调用”按钮修改 `pi-web:ui` 中保存的 `toolsExpanded`，并清除所有卡片的手动选择；单张卡片的手动展开/折叠按 toolCallId 记在模块级 Map 中（最多 2000 条），页面刷新前跨分页、切换会话保留。
      - 列表吸底时展开的卡片若不在底部，先取消吸底，避免被点击的标题行被推出视野。
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
    - 支持图片粘贴和拖拽（base64 发送；缩略图用 object URL）；
    - 草稿（文本和图片）按 (工作区, 会话) 保存在内存中（文本另存 sessionStorage），切换标签页或会话后恢复；`?prefill=` 插入到光标处而不是替换草稿；
    - 运行中 Enter 为 steer，Alt+Enter 为 follow_up；
    - Esc 先 clear_queue，把返回的文本放回输入框，再 abort；
    - 显示队列。
  - 控件：
    - 模型选择（get_available_models + set_model）、思考级别（get_available_thinking_levels）；
    - 右侧面板：上下文占用条和用量（get_session_stats，运行结束后刷新）、平均生成速率和首字延迟、会话路径；
    - 输出速率（`logic/usage.ts`）：每个 assistant 分组末尾一行“52 tok/s · 1.2k tokens · 首字 0.8s”，悬停显示计算方式和每一轮的明细。
      - 有 timing 时按生成阶段计算：tokens = usage.output（推理内容不可见时扣除 usage.reasoning）÷ decodeMs，decodeMs 至少 200ms；
      - 否则按 pi 的 `durationMs`（含首字延迟）估算并标“≈”；中止、出错的回复不计；
      - 生成中显示“≈ N tok/s · 生成中”（每秒最多刷新 2 次）：provider 流式返回用量时用真实值，否则按已输出内容估算（CJK 字符约 1 token、其他字符约 1/4 token），并用本会话最近 10 条回复的“实际 token ÷ 估算 token”中位数校准；
    - 任务清单（`components/TodoPanel.tsx`、`logic/todos.ts`）：显示在输入框上方（实时和只读会话都显示），可折叠（`pi-web:todo-panel-open`）。数据来源依次为：只读会话按 branchIds 用 `replayTodos` 重放会话文件；伴随扩展推送的 `pi-web:todos` 状态；旧版伴随扩展时重放当前消息列表（压缩后可能不完整）。hidden 中的任务默认收起，可用“显示此前已完成的 N 项”展开；进度按显示的任务计算。`pi-web:` 开头的状态不显示为状态条目；
    - 操作：树视图、Fork（get_fork_messages + fork）、Clone、压缩（可附带指令）、导出 HTML、重命名、归档/恢复、删除、自动压缩和自动重试开关；
  - 归档：侧栏的活动列表和会话数不含已归档的会话，它们在每个工作区下默认折叠的“已归档（N）”分组中（打开、恢复、删除）；已归档的会话顶部显示“此会话已归档”和“恢复”；发送消息（含 steer/follow-up、`!cmd`）前先 `POST /sessions/unarchive`，失败时提示且不发送；已归档的会话不会被记为工作区的上一个会话（对话标签页、首页、“在对话中引用”的目标）；
    - configStale 时显示“配置已更新”卡片，提供“重新加载”（companion reload）。
  - 扩展 UI：
    - pending 对话框以模态呈现，有 timeout 时显示倒计时：截止时间从 pi 发出请求时算起（实时事件到达时记录；快照带 agent 计算的 `uiRemainingMs`），到 0 后禁用回答按钮；
    - confirm 默认聚焦“拒绝”，对话框出现后 400ms 内的确认操作被忽略（防止原本给输入框的 Enter 误点“允许”）；
    - 回答请求失败时把对话框放回并重新同步（pi 仍在等待）；
    - 标题可以多行（如 rpiv-ask-user-question 把选项列表、预览拼进标题）：第一个非空行作为标题，其余部分以等宽字体、保留换行和缩进显示在标题下方（最多 30vh，可滚动），并作为对话框的 aria 描述（`logic/dialog-title.ts`）；
    - 自定义回答：问答类扩展在 RPC 模式下常用 `select(问题, [...选项, "Type something."])`，选中后再用 `input()`/`editor()` 要文字。select 含这类选项（`logic/free-answer.ts` 的 `isFreeInputOption`：Type something / Other / Custom / Something else / 自定义 / 其他 / 输入… 等，以及 rpiv-ask-user-question 各语言的“Type something.”（如“输入内容”），忽略大小写和前面的编号、符号）时，高亮该选项会在它下方显示“自定义回答”输入框（点击或方向键选中即聚焦，在选项列表里直接打字会跳到输入框，Esc 回到列表；对话框出现后 400ms 内的按键及紧随其后的连续按键被忽略，防止原本给输入框的文字变成回答）。带文字提交时，先用该选项的原文回答 select，同时为本对话登记一个待用回答（`decideAutoAnswer`）：同一对话之后新到的第一个请求若是 input/editor 且在 60 秒内，就直接用这段文字回答、不显示对话框（不受 400ms 限制；已被其他标签页回答或已超时的不答）；若它是别的对话框或 60 秒内没有请求，就丢弃并提示“扩展没有请求文字输入，你输入的内容未被使用”。select 的回答未送达 pi（`delivered: false`，如已在其他标签页回答）时也丢弃并提示。空文字提交与普通选择相同；提交失败时对话框连同已输入的文字一起放回；
    - notify 显示为 toast；
  - 流式渲染：message_update / tool_execution_update 立即应用到状态，但每帧最多通知一次；正在生成的回复的 Markdown 最多每 120ms 重新解析；write/edit 参数生成期间只显示纯文本尾部，参数完整后才高亮和计算 diff；大参数的部分 JSON 在增长超过 1/16 后才重新解析；
  - 只读 ↔ 实时切换时保留消息：进程退出后在会话文件加载完成前显示最后的实时状态，恢复会话时在快照到达前显示会话文件内容；
  - Fork/Clone 后视图跟随新会话；用户经由侧栏或后退回到原会话时换一个新的视图（不再被固定在已切到新会话的进程上）；
  - 未读与通知：不在查看的对话运行结束或开始等待对话框时，侧栏显示“未读”；获准后（首次发送消息时请求权限）在标签页隐藏或在看别的对话时发浏览器通知；
  - Markdown：外部图片不自动加载，显示为链接；```mermaid 代码块在消息完成后用打包的 mermaid（按需加载，securityLevel strict）渲染为图表，可切换源码；
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
POST   /auth/login          { token }          → { ok: true }   (只校验；前端自行保存令牌)
POST   /auth/ticket         { path }           → { ticket, expiresAt }   (一次性下载票据)
POST   /auth/rotate                            → { token }   (更换令牌)

GET    /servers                                → { servers: ServerView[] }
POST   /servers             CreateServerRequest → ServerView
POST   /servers/test        { host, port, username, auth: ServerAuthInput, jumpServerIds?, serverId? } → TestConnectionResult
                            （serverId：编辑已有服务器时传入；host:port 不变则用其已信任的指纹，auth.secret 省略则用已保存的密码/口令）
GET    /servers/:id                            → ServerView
PUT    /servers/:id         UpdateServerRequest → ServerView
                            （env 给出时整体替换服务器级环境变量；修改 proxy、idleTimeoutMin、agentDirMode、remoteRoot 或 env 时向已连接的 agent 重新下发 AgentConfig）
                            （服务器级与 workspace 的 env 用同一套规则校验，见 @pi-web/shared 的 validateEnvMap，前端也用它：
                             变量名 ^[A-Za-z_][A-Za-z0-9_]*$、不超过 256 个字符；拒绝 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY（任意大小写）与 PI_CODING_AGENT_DIR，
                             以及 bash 的只读变量 UID/EUID/PPID/SHELLOPTS/BASHOPTS/BASH_VERSINFO（/bin/sh 是 bash 时 export 它们会让 bin/pi 退出）；
                             值不含 NUL、每个不超过 32 KiB（UTF-8）；最多 100 个，NAME=value 合计不超过 256 KiB（服务器级与 workspace 合并后仍远低于 execve 的环境大小上限）。
                             servers.json 中没有 env 的旧记录按 {} 加载）
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
DELETE /sessions?serverId=&file=               → { trashedTo }          (同时删除归档记录)
POST   /sessions/archive   ArchiveSessionRequest → ArchiveSessionResponse { ok, archivedAt }
                            （只在 Host 上标记，不需要 agent；file 必须是规范化的 .jsonl 绝对路径，否则 400；
                             服务器不存在 404；该会话的进程 running/waiting_ui 时 409 BUSY）
POST   /sessions/unarchive ArchiveSessionRequest → { ok: true }

GET    /conversations                          → { conversations: ConversationView[] }
POST   /workspaces/:wsId/conversations OpenConversationRequest → ConversationView
GET    /conversations/:convId/snapshot         → ConversationSnapshot
POST   /conversations/:convId/rpc ConversationRpcRequest → RpcResponse (& seq)
POST   /conversations/:convId/ui-response ConversationUiResponseRequest → { ok: true, delivered }
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
WebSocket：`/ws`（话题见 `api.ts`，含归档变化的 `sessions`），`/ws/term`（见 `api.ts` 末尾）。

---

## 6. 端到端验证（集成阶段）
本机安装 sshd，用一个测试用户把 `localhost:2222` 当作“服务器”，走完整流程：
1. 添加服务器；
2. 部署（Node 用官方源下载；pi 从 npm 安装）；
3. 在 Host 的 agentDir 放入 models.json，指向一个本地 mock OpenAI 兼容服务，域名用 `mock-llm.test`，经 `/etc/hosts` 解析到 127.0.0.2；
4. 在远端对话，LLM 流量经隧道代理到 Host；
5. 验证 fork/tree/label/reload、文件浏览、git、终端；
6. 验证自动同步和 OAuth 推送（用伪造的 oauth 条目验证变换）。

以上流程已自动化为 API 级 E2E：`npm run build && npm run e2e:api`（`e2e/api-e2e.mjs`，需 root + OpenSSH；`E2E_KEEP=1` 保留临时目录，`E2E_VERBOSE=1` 打印全部事件）。它像浏览器一样驱动 REST + `/ws` + `/ws/term`，并额外覆盖扩展对话框（ui-response）、提示模板/技能展开、write 工具、abort、生成计时（快照中的 ttft/decode）、rpiv-todo 任务清单（测试扩展里按 rpiv 格式保存状态的 `todo` 工具：伴随扩展推送 `pi-web:todos`、上一回合已完成的任务标记为 hidden、压缩掉 todo 工具结果后清单不变；E2E 设置把 `compaction.keepRecentTokens` 调小，mock LLM 对 `<conversation>` 摘要请求固定回复文字）、归档会话（列表标记、运行中 409、恢复、删除时清除记录、断开连接时归档）、Pi-Web 重启后的事件补发与卸载。

浏览器 E2E：`npm run build && npm run e2e:ui`（`e2e/ui-e2e.mjs`，与 API E2E 共用 `e2e/lib/env.mjs` 中的环境：sshd fixture、mock LLM、Host agent 目录、数据目录）。用 Playwright 驱动 Chromium（1440×960）走完添加服务器向导（连接 → 主机指纹 → 探测 → 离线部署 → 同步）、新建工作区（目录选择器 + 新建文件夹）、对话（流式回复、默认折叠的 bash 工具卡片、信息面板、会话树与标签、模型/思考选择、`/` 补全与提示模板、刷新恢复、离开再返回）、扩展对话框（在 select 的选项列表里直接输入自定义回答、普通选项、空回答后由扩展自己的 input 询问、打开时仍在输入的按键被忽略、提交失败后带文字放回、扩展随后不要文字时丢弃并提示，以及按 rpiv-ask-user-question 的 RPC 格式提问时的多行标题、直接输入和它自己的 input）、输出速率（回复末尾的速率行、信息面板的生成速率和首字延迟）、全部展开/折叠工具调用（偏好保存在浏览器）、任务清单（创建、进度、折叠时显示进行中的任务、此前回合已完成的任务收起与展开、刷新后保留、只读查看归档会话时从会话文件还原）、归档（侧栏归档、已归档分组、打开归档会话、发送时自动恢复）、文件/Git/终端、同步中心（预览、手动同步）、全局设置、服务器设置，以及断开/重连。每一步截图到 `e2e/screenshots/`，出现页面异常、未预期的 console.error、失败的 `/api` 请求或整页滚动即判失败。需要全局或本地安装的 `playwright` 包与 `PLAYWRIGHT_BROWSERS_PATH` 下的 Chromium；`E2E_HOLD=1` 在结束后保留环境便于手动调试。
