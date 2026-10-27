# Pi-Web 设计文档（v0.2）

> 目标 pi 版本：`@earendil-works/pi-coding-agent@1.4.x`（原 `@mariozechner/pi-coding-agent` 已废弃），要求 Node ≥ 22.19。
> 已确认的范围：
> - **LLM 代理**：只做 Tunnel 隧道模式（另有“关闭”，即服务器直连）。
> - **服务器系统**：Linux x64 / arm64，glibc ≥ 2.28。
> - **Host 系统**：Linux。
> - **使用方式**：本机单用户。
> - **服务器配置目录**：按服务器可选，默认使用独立目录。
> - **代理范围**：按服务器开关，默认仅放行 LLM 请求。
> - **OAuth 凭据**：由 Host 统一刷新后推送到服务器。
> - **附加功能**：文件浏览、Web 终端、Git 变更查看。

---

## 1. 目标与术语

在 Host 上运行一个 Web 服务，完成以下几件事：

- 通过 SSH 把 pi **离线**部署到远程服务器；
- 在浏览器中统一管理**服务器 → 工作区 → 对话**；
- 服务器上 pi 发出的 LLM 请求经 SSH 隧道回到 Host 再发出；
- Host 上的 pi 配置和插件同步到服务器，并支持自动同步。

| 术语 | 含义 |
|---|---|
| **Host** | 运行 Pi-Web 的 Linux 机器。能上网，装有 pi 和它的配置 `~/.pi/agent` |
| **Server** | 通过 SSH 连接的远程 Linux 机器，可能不能上网 |
| **Workspace** | Server 上的一个目录，作为 pi 运行时的 cwd |
| **Conversation** | 一个 pi session，即 Server 上的一个 JSONL 文件 |
| **Remote Agent** | Pi-Web 部署到 Server 上的常驻守护进程 `pi-web-agent` |
| **Link** | Host 与 Remote Agent 之间的一条 SSH exec 通道，所有通信在这条通道上多路复用 |

---

## 2. 总体架构

```
┌──────────── Browser ─────────────┐
│ React SPA                        │
│ 服务器 / 工作区 / 对话 / 文件 / 终端 / Git │
└───────────────┬──────────────────┘
                │ HTTP(REST) + WebSocket(事件推送、终端数据)
┌───────────────▼──────────────────────── Host (Linux) ─────────────────────────┐
│ Pi-Web Server (Node.js 22 / TypeScript)，只监听 127.0.0.1                      │
│  ├─ API / WS 网关          ├─ SSH 连接池 (ssh2)       ├─ 存储 ~/.pi-web-host/   │
│  ├─ Deployer 部署器        ├─ Syncer 同步器 + 文件监听 ├─ Bundle 缓存          │
│  ├─ TunnelProxy：HTTP CONNECT 出口 + 域名白名单 + 令牌校验                     │
│  └─ OAuthKeeper：用 Host 上 pi 的 AuthStorage 刷新 OAuth，再推送 access token  │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ SSH：① exec 通道 = Link（帧协议，多路复用）
                │      ② SFTP（批量上传）
                │      ③ shell 通道（Web 终端，带 pty）
┌───────────────▼──────────────────────── Server (Linux) ───────────────────────┐
│ ~/.pi-web/                                    （目录权限 0700）                │
│  ├─ runtime/node-<ver>-linux-<arch>/          上传的 Node 运行时               │
│  ├─ pi/<ver>/node_modules/...                 上传的 pi（含依赖，可离线运行）  │
│  ├─ agent/                                    默认的 PI_CODING_AGENT_DIR       │
│  │                                            （可按服务器改为 ~/.pi/agent）   │
│  ├─ daemon/{pi-web-agent.mjs, bridge.mjs}     Remote Agent                     │
│  ├─ bin/pi                                    包装脚本，SSH 登录后可直接用 pi  │
│  └─ run/agent.sock  logs/  state/  trash/                                     │
│                                                                               │
│ pi-web-agent（常驻，用 setsid 脱离 SSH 会话）                                  │
│  ├─ 每个活跃对话一个子进程：pi --mode rpc [--session f]（cwd = workspace）     │
│  ├─ 127.0.0.1:P 本地 HTTP 代理入口 → 经 Link 转发到 Host 的 TunnelProxy        │
│  ├─ 会话列表与读取（直接解析 JSONL；必要时复用 pi 的 SessionManager）          │
│  ├─ 文件浏览、Git 查询                                                         │
│  └─ 同步文件落盘（原子替换）、清单维护                                         │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 关键设计决策

1. **服务器端用常驻守护进程**
   Host 断线、Pi-Web 重启或浏览器关闭，都不会中断服务器上正在执行的工具。agent 为每个对话缓存最近的事件（环形缓冲，带递增序号），Host 重连后按序号补发；缓冲不够时用 `get_messages` 全量恢复。
   注意：Tunnel 模式下 LLM 请求依赖 Host 在线，Host 断线期间发起的 LLM 请求会失败，由 pi 自带的 auto-retry 处理。
2. **每个对话一个 RPC 子进程**
   用的是 pi 官方的 JSONL 协议，进程之间互相隔离。
3. **只用一条 SSH exec 通道（Link），不依赖 sshd 端口转发**
   Host 执行 `~/.pi-web/runtime/.../bin/node ~/.pi-web/daemon/bridge.mjs`。bridge 连接 `run/agent.sock`，如果 daemon 没在运行就先拉起它，之后在 stdio 和 socket 之间做双向透传。Link 上使用自定义帧协议，复用 RPC 调用、事件推送和代理的 TCP 流。这样即使 sshd 配置了 `AllowTcpForwarding no`，代理也能工作。
4. **代理入口由 agent 持有**
   代理监听在 127.0.0.1 的固定端口 P，并且必须带令牌。端口不随 SSH 重连变化，所以已经启动的 pi 进程里的 `HTTPS_PROXY` 不会失效。Host 不在线时，代理立即返回 502。

---

## 3. 关键流程

### 3.1 添加服务器并部署

```
填写 SSH 信息（或从 ~/.ssh/config 导入）
  → 测试连接（首次连接确认主机指纹，之后严格校验）
  → 探测服务器：uname -sm、getconf GNU_LIBC_VERSION（要求 ≥ 2.28）、$HOME、
    df、tar/gzip 是否可用、已有的 ~/.pi-web 版本，以及默认 shell
  → Host 准备离线包（命中缓存则跳过）：
       · Node 运行时：按 arch 从 nodejs.org 或 npmmirror 镜像下载，也可以导入本地 tar.xz；
         统一转成 tar.gz 并缓存
       · pi：在 Host 缓存目录执行 npm install @earendil-works/pi-coding-agent@<ver>。
         pi-tui 自带 linux-x64/arm64 的预编译，与 Host 无关。
         裁剪掉 darwin/win32 预编译后打成 tar.gz
       · agent：Pi-Web 内置，单文件 ESM，没有第三方依赖
  → SFTP 上传（显示进度，每个文件做 sha256 校验）
  → 远端解压到版本目录，写入 current 软链接和 bin/pi 包装脚本，启动 daemon
  → 执行一次完整的配置同步（见 3.4）
  → 自检：pi --version、get_available_models、通过代理访问一次 provider 域名
```

- **升级或回滚**：pi 和 Node 都按版本目录并存，切换 `current` 软链接即可。升级只上传有变化的组件。
- **pi 版本策略**：默认跟随 Host 上已经安装的 pi 版本，也可以在全局设置中指定版本。

### 3.2 对话

```
浏览器 ──WS──▶ Host ──Link──▶ agent ──stdin──▶ pi(rpc)
浏览器 ◀─WS── Host ◀─Link── agent ◀─stdout── pi(rpc)   事件原样透传，附带 convId 和 seq
```

- **新建对话**：agent 在 workspace 目录下启动 `pi --mode rpc`。按 workspace 的设置传入 `--approve` 或 `--no-approve`，因为 RPC 模式无法弹出 project trust 确认。
- **打开历史对话**：先由 agent 直接读取 JSONL 渲染（只读、秒开），用户发消息时才懒启动 `pi --mode rpc --session <file>`。
- **空闲回收**：对话不在运行，并且空闲超过 N 分钟（默认 30）时，agent 关闭它的 stdin，让 pi 正常退出。
- **进程环境**：
  - `PI_CODING_AGENT_DIR`：指向该服务器配置的 agent 目录；
  - `PI_OFFLINE=1`：禁止启动时访问网络；
  - `HTTPS_PROXY`/`HTTP_PROXY=http://pw:<token>@127.0.0.1:P`；
  - `NO_PROXY`：`localhost,127.0.0.1,::1`，再加上按服务器配置的内网地址，例如内网的 vLLM 地址；
  - 服务器级环境变量（服务器设置中配置，作用于该服务器的所有 workspace）；
  - workspace 上配置的额外环境变量（与服务器级变量同名时以 workspace 为准）。
  - 代理变量（`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`，不区分大小写）和 `PI_CODING_AGENT_DIR` 由 Pi-Web 管理，`UID` 等 bash 只读变量无法导出，都不能作为服务器级或 workspace 环境变量设置。
- **扩展 UI**：`extension_ui_request` 中的 select、confirm、input、editor 显示为网页对话框；notify 显示为 toast；setStatus、setWidget 显示在输入框上方的状态区。

### 3.3 LLM 隧道代理

```
pi(HTTPS_PROXY) ──CONNECT api.anthropic.com:443──▶ agent 127.0.0.1:P（校验 Proxy-Authorization）
   ──Link 流──▶ Host TunnelProxy（校验域名白名单；可经 Host 上游代理）──TCP──▶ 上游
```

- **TLS 端到端**：Host 只看得到目标域名，看不到请求内容。
- **代理范围**按服务器开关：
  - **仅 LLM（默认）**：
    - 白名单为 Host 上 pi 已知的所有 provider `baseUrl` 域名，加上 models.json 中的自定义 provider，再加上手动追加的域名；
    - 同步时向服务器的 `settings.json` 注入 `shellCommandPrefix`，内容是 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy`（与用户自己的前缀合并）。这样 bash 工具不会继承代理，访问内网的 pip/npm 镜像也不会被误导到 Host。
  - **工具也走代理**：不注入上面的前缀。白名单可以设为“指定域名”或“全部放行”。
- 白名单由 Host 端强制执行。服务器端剥离环境变量只是为了让工具的行为正确，不承担安全职责。
- 代理开启时，向服务器 settings 注入 `transport: "sse"`，避免 WebSocket 传输绕过代理（实现时会验证，如果确认 WebSocket 也走代理，就去掉这条注入）。
- 服务器可以单独设为“代理关闭”（服务器自己能上网时使用）。
- 每台服务器的代理面板会显示实时连接数、按域名统计的流量，以及被拒绝的请求。

### 3.4 配置同步（Host → Server，单向）

**同步项目**（每台服务器可以单独勾选）：

| 类别 | 内容 | 默认 |
|---|---|---|
| 设置 | `settings.json`（会经过转换） | ✅ |
| 模型 | `models.json` | ✅ |
| 凭据 | `auth.json`（OAuth 条目会经过处理，见 3.5） | ✅ |
| MCP | `mcp.json` | ✅ |
| 指令 | `AGENTS.md`/`CLAUDE.md`/`SYSTEM.md`/`APPEND_SYSTEM.md` | ✅ |
| 资源 | `extensions/` `skills/` `prompts/` `themes/` | ✅ |
| 插件包 | `npm/`（pi 管理的 npm 包）、`git/`（git 包，含 node_modules） | ✅ |
| 其他 | `~/.agents/skills/`、`keybindings.json` | ❌（可选） |
| 永不同步 | `sessions/`、`trust.json`、`*.log`、`bin/`、`tools/` | — |

**增量算法**
1. Host 生成清单（相对路径、size、mtime、sha256）。按 mtime 缓存哈希，并忽略 `.git/` 等目录。
2. agent 返回服务器端清单。它维护 `state/sync-manifest.json`，记录哪些文件是由同步写入的，以及当时的哈希。
3. 比较差异后，把新增和修改的文件打成 tar.gz，经 Link 流传给 agent。agent 先解压到临时目录，再逐个 rename，实现原子替换。
4. **只删除“由同步写入、而在 Host 上已删除”的文件**。服务器上本地新增的文件一律不动。
5. 如果同步写入的文件后来在服务器上被改过（哈希和清单不一致），先备份到 `state/backup/<时间>/`，再用 Host 的版本覆盖。界面上会给出提示。

**转换规则**
- `settings.json`：
  - 合并“服务器级覆盖”（JSON，深度合并）；
  - 去掉 Host 专属的设置：`npmCommand`、`shellPath`、`httpProxy`；
  - 注入代理相关的设置（见 3.3）；
  - 改写外部路径：`packages`、`extensions`、`skills`、`prompts`、`themes` 中指向 agent 目录以外的本地路径，会把对应的内容一起上传到 `agent/external/<hash>/`，并改写引用。
- 插件包中如果有 `*.node` 原生模块，并且平台不匹配（例如只有 darwin 构建），给出警告。

**自动同步**
- Host 用 chokidar 监听 `~/.pi/agent`（防抖 2 秒），对开启了自动同步并且在线的服务器做增量同步。
- 离线的服务器标记为“待同步”，下次连接成功后自动补上。
- 同步完成后，正在运行的对话会标记为“配置已更新”，并提供“重启会话”。原因是 pi 的 RPC 没有 reload 命令，需要重启进程才会生效。

### 3.5 OAuth 凭据：由 Host 统一刷新并推送
- **服务器上的 auth.json**：API Key 条目原样同步。OAuth 条目只保留 `access` 和 `expires`，`refresh` 字段换成占位值，所以服务器无法轮换 refresh token，也就不会把 Host 踢下线。
- **刷新**：Host 的 OAuthKeeper 定时检查 Host `auth.json` 中的 OAuth 条目，在过期前 10 分钟调用 pi 自己的刷新逻辑（复用 Host 上 pi 的 AuthStorage，加文件锁），刷新结果写回 Host。这样 Host 上直接使用的 pi CLI 也保持一致。
- **推送**：Host 的 auth.json 一有变化（包括 Host 上的 pi 自己刷新了 token），就立即把处理后的版本推送到所有在线的服务器。pi 在每次读取凭据时都会重新加载 auth.json，所以推送后立即生效。
- Host 离线时服务器本来就无法访问 LLM（Tunnel 模式），因此这个方案没有额外的可用性损失。

### 3.6 文件浏览 / Web 终端 / Git
- **文件浏览**：通过 agent 的 `fs.list` 和 `fs.read` 实现，有大小上限（默认 2 MB）和二进制检测；支持代码高亮、Markdown 预览、图片预览、下载；遵循 `.gitignore` 的过滤可以开关。为只读设计。
- **Web 终端**：用 ssh2 的 shell 通道（带 pty），先 `cd` 到 workspace，导出服务器级环境变量，并把 `~/.pi-web/bin` 加到 PATH，这样可以直接运行 `pi`。前端用 xterm.js，支持多个标签页和窗口大小自适应。终端随浏览器页面存在，关闭标签页即结束。
- **Git**：由 agent 在 workspace 中执行 `git status --porcelain=v2 -z`、`git diff`、`git diff --cached`、`git log`。界面包括变更文件列表、并排或行内 diff，以及最近的提交。为只读设计；可以从 diff 一键“把这段 diff 发给 pi 审阅”。

---

## 4. 功能清单

### 4.1 服务器管理
- 增删改查；分组；从 `~/.ssh/config` 导入
- 认证方式：密码 / 私钥（含 passphrase）/ ssh-agent（`SSH_AUTH_SOCK`）；跳板机（ProxyJump，可多级）
- 状态信息：连接状态、延迟、daemon 状态、pi/Node 版本、arch/glibc、磁盘空间、运行中的对话数、同步状态、代理状态
- 操作：连接/断开、部署/升级/回滚、重启 daemon、查看 agent 日志、卸载（删除 `~/.pi-web`；可选是否保留会话）
- 设置：
  - agent 目录模式（独立 / 共用 `~/.pi/agent`）
  - 代理（关闭 / 隧道；仅 LLM / 工具也走代理；白名单；NO_PROXY）
  - 同步项目、自动同步开关
  - settings 覆盖
  - 空闲回收时间
  - 服务器级环境变量：作用于该服务器所有 workspace 的 pi 进程、Web 终端和 `~/.pi-web/bin/pi`（例如扩展需要的内网服务地址）；同名时 workspace 的变量优先，运行 `~/.pi-web/bin/pi` 时调用方已设置的变量也优先；修改后对新启动的 pi 进程和新打开的终端生效（Web 终端和 bin/pi 需要 agent 0.1.2 及以上，旧版本升级后生效）。值以明文保存（Host 数据目录、服务器上 0600 的 `run/env.sh`），不适合存放高价值密钥

### 4.2 Workspace 管理
- 添加：用远程目录选择器选择已有目录，或新建目录
- 配置：别名、project trust（approve / no-approve）、默认模型和思考级别、额外环境变量
- 会话列表：读取 `sessions/--<编码后的 cwd>--/`
- 标签页：对话 / 文件 / 终端 / Git
- 从列表移除（不删除文件）

### 4.3 对话管理
- **列表**：按 workspace 分组，按修改时间排序，可按名称和首条消息搜索；显示“运行中”“等待输入（扩展对话框）”“未读”标记
- **会话操作**：新建、打开、重命名、删除（移到 `~/.pi-web/trash`）、归档/恢复、fork（选择一条用户消息，或用回复末尾的 Fork 按钮接着这条回复）、clone、树视图跳转（`get_tree` + 切换分支）、导出 HTML/JSONL
- **归档**：只在 Pi-Web 中隐藏会话，服务器上的会话文件不移动也不修改（pi 自己的 `/resume` 仍能看到）。归档标记按（服务器, 会话文件绝对路径）保存在 Host 上，服务器离线时也能归档和恢复。
  - 侧栏的会话列表和工作区会话数不含已归档的会话；会话行悬停或键盘聚焦时显示“归档”按钮，会话运行中或等待对话框时不可归档
  - 每个工作区下有默认折叠的“已归档（N）”分组：打开会话（只读查看，发送消息前不启动进程）、恢复、删除（与对话页相同的删除确认）；搜索也匹配已归档的会话，结果显示在展开的分组中
  - 对话页：已归档的会话顶部显示“此会话已归档”和“恢复”按钮，信息面板提供“归档会话/恢复会话”；在已归档的会话中发送消息（含 steer、follow-up、`!cmd`）会先自动恢复，恢复失败则不发送
  - 首页重定向、对话标签页记住的会话、文件/Git 的“在对话中引用”都跳过已归档的会话
- **消息渲染**：
  - Markdown（含 mermaid）
  - 代码高亮
  - thinking 默认折叠
  - 工具卡片：bash 的输出流式显示；edit 显示 diff；read/write 显示文件预览；其他工具显示 JSON
  - 工具卡片默认折叠（运行中和出错的也一样）：折叠时标题行显示工具、目标、状态和耗时，出错时多一行错误摘要；消息区右上角的按钮可以展开或折叠全部工具调用，这个选择保存在浏览器中；单张卡片的手动展开/折叠在页面刷新前保留
  - 每轮回复末尾有 Fork 按钮：把对话复制到这轮回复为止，作为新会话继续（输入框留空）；运行中不可用
  - 消息导航：消息区右侧一列短横线，每条对应一条用户消息，正在阅读的那条高亮；悬停预览消息内容，点击平滑滚动到该消息并短暂高亮
  - 每轮回复末尾显示输出速率（如“52 tok/s · 1.2k tokens · 首字 0.8s”）：按 agent 记录的首个输出到回复结束的时间计算，不含首字延迟；没有这项记录时（旧会话、旧版 agent）按 pi 记录的总耗时估算，并标“≈”；生成中显示估算的实时速率
  - compaction 和 branch summary 的标记
- **输入框**：
  - `/` 补全：`get_commands` 返回的扩展命令、prompt 模板和 skills
  - `!cmd` 执行 bash 并把结果加入上下文；`!!cmd` 执行但不加入上下文
  - 图片粘贴和拖拽
  - 运行中按 Enter 为 steer，Alt+Enter 为 follow-up，并显示队列（可撤回）；Esc 中止
- **控制项**：
  - 模型选择（`get_available_models`）
  - 思考级别（`get_available_thinking_levels`）
  - 手动 compact（可附带指令）
  - 自动压缩和自动重试开关
- **统计**：token（输入/输出/缓存）、费用、上下文占用条、平均生成速率和首字延迟
- **任务清单**：rpiv-todo（`@juicesharp/rpiv-todo`）的 TUI 面板在 RPC 模式下不显示，Pi-Web 在输入框上方显示同样的任务清单（可折叠；状态、进行中的说明、依赖；此前回合已完成的任务默认收起，与 rpiv 的面板一致）。伴随扩展按 rpiv 的规则从当前分支还原清单并推送，压缩上下文后仍然完整；只读查看时从会话文件还原
- **其他**：多个对话可以并行；运行结束或需要输入时发浏览器通知

### 4.4 同步中心
- 浏览 Host 的 `~/.pi/agent`：扩展、skills、prompts、包列表，以及 OAuth/API Key 条目（只显示名称）
- 同步矩阵：服务器 × 同步项目的状态
- 同步前预览差异（新增 / 修改 / 删除 / 冲突）
- 操作：手动同步单台或全部服务器、自动同步开关；查看同步历史和错误日志

### 4.5 全局设置
- Node 运行时下载源（官方 / npmmirror / 自定义 URL / 导入本地文件）；Node 版本
- pi 版本策略（跟随 Host / 指定版本）；npm registry
- Host 上游代理
- 监听地址和端口、访问令牌（可选）
- 离线包缓存管理

---

## 5. 协议

### 5.1 Browser ⇄ Host
- **REST**（`/api`）：
  - `servers`：CRUD、test、connect、disconnect、deploy、status、logs
  - `servers/:id/workspaces`
  - `workspaces/:id/sessions`
  - `conversations/:id`：open、close、rpc、ui-response、export
  - `workspaces/:id/fs`
  - `workspaces/:id/git`
  - `sync`：preview、run、history
  - `settings`
- **WebSocket**（`/ws`）：
  - 客户端发送 `subscribe` / `unsubscribe` 来订阅主题（`server:<id>`、`conv:<id>`、`sync`、`deploy:<id>`）
  - 服务端推送：pi 事件（带 seq）、部署和同步进度、服务器状态、代理统计
  - 终端使用独立的 WS：`/ws/term/:termId`，传二进制数据

### 5.2 Host ⇄ Remote Agent（Link 帧协议）

```
帧：[type:u8][stream:u32 BE][len:u32 BE][payload]
type 1 = JSON 消息（stream=0）：
         {id, method, params} / {id, result} / {id, error} / {event, data}
type 2 = 流打开（payload 为 JSON 元数据，例如 {kind:"proxy", host, port} 或 {kind:"upload"}）
type 3 = 流数据（二进制）
type 4 = 流关闭（payload 可带错误信息）
type 5 = 流量控制窗口更新（防止单个流占满通道）
```

**方法**：
- `hello`（版本协商）
- `agent.status` / `agent.logs` / `agent.shutdown`
- `fs.list` / `fs.stat` / `fs.read` / `fs.mkdir`
- `git.status` / `git.diff` / `git.log`
- `sessions.list(cwd)` / `sessions.read(file)` / `sessions.delete(file)`
- `conv.start({cwd, sessionFile?, args, env})` / `conv.stop` / `conv.list`
- `conv.send(convId, rpcCommand)`：透传 pi 的 RPC 命令，返回 pi 的 response
- `conv.uiResponse` / `conv.replay(convId, fromSeq)`
- `sync.manifest` / `sync.apply(streamId, plan)`
- `proxy.configure({port, token})`

**事件**：
- `conv.event {convId, seq, data}`
- `conv.exit {convId, code}`
- `conv.stderr`
- `agent.log`

---

## 6. 数据模型（Host 端，`~/.pi-web-host/`）

```ts
Server {
  id, name, group?, host, port, username,
  auth: { type: "password" | "key" | "agent", keyPath?, secretRef? },
  jumps?: string[],                     // 跳板机为其他 Server 的 id（按顺序）
  remoteRoot: "~/.pi-web",
  agentDirMode: "isolated" | "shared",
  proxy: { mode: "off" | "tunnel", port, scope: "llm" | "tools",
           toolsAllow: "list" | "all", extraDomains: string[], noProxy: string[] },
  sync: { items: Record<SyncItemKey, boolean>, auto: boolean, settingsOverride: object },
  idleTimeoutMin: number,
  env: Record<string, string>,          // 服务器级环境变量（workspace.env 同名时覆盖）
  hostKey?: { alg, fingerprint },
  deployed?: { nodeVersion, piVersion, agentVersion, arch, glibc, at }
}
Workspace  { id, serverId, path, alias, trust: "approve" | "no-approve",
             defaults: { provider?, model?, thinking? }, env: Record<string, string> }
SyncRecord { id, serverId, at, trigger: "manual" | "auto" | "connect" | "oauth",
             added, changed, deleted, conflicts, status, error? }
Secrets    —— SSH 密码、passphrase、代理令牌：用主密钥（~/.pi-web-host/master.key，0600）
              做 AES-256-GCM 加密后存储
```

会话以服务器为唯一来源；Host 只在内存中缓存列表摘要。

---

## 7. 安全
- 默认只监听 `127.0.0.1`；可以设置访问令牌（保存在浏览器本源存储中，不使用 Cookie），防止同一台机器上的其他用户访问；所有接口都校验 Origin
- 首次连接时确认主机指纹，之后指纹变化会拒绝连接并告警
- 远端代理：只监听回环地址，需要令牌，并由 Host 强制执行域名白名单
- 服务器上的 auth.json 不含 OAuth refresh token；同步凭据前在界面上提示风险
- daemon socket 和 `~/.pi-web` 权限分别为 0600 / 0700
- Web 终端和文件浏览只限于当前 SSH 用户的权限范围

---

## 8. 技术选型

| 层 | 选型 |
|---|---|
| Host 后端 | Node.js 22 + TypeScript、Fastify、@fastify/websocket、ssh2、chokidar、tar、zod |
| Host 存储 | JSON 文件（原子写入），不引入原生依赖 |
| pi 集成（Host） | 依赖 `@earendil-works/pi-coding-agent`，用到 AuthStorage、ModelRegistry 和 OAuth 刷新 |
| 前端 | React 18 + Vite + TypeScript + Tailwind CSS、Zustand、TanStack Query、react-markdown + shiki、xterm.js、diff 视图 |
| Remote Agent | 纯 Node ESM 单文件，零第三方依赖（用 esbuild 打包） |
| 工程结构 | pnpm workspace：`packages/shared`（协议类型）、`packages/agent`、`packages/server`、`packages/web` |
| 分发 | `npm i -g pi-web && pi-web`，前端构建产物由 server 托管 |
| 测试 | vitest；集成测试用本地 sshd 容器（Docker）跑完整的部署、同步和代理流程 |

---

## 9. 风险与待验证
1. **WebSocket 传输是否走 HTTPS_PROXY**：实现时验证；兜底方案是注入 `transport: "sse"`。
2. **剥离 refresh token 后 pi 的行为**：在 access token 有效期内应当正常；过期后刷新会失败并报错。实现时验证，必要时把推送提前量调大。
3. **插件包含平台相关的原生模块**：检测并警告。
4. **mcp.json 中 stdio 类 MCP 的命令**（例如 `npx xxx`）在离线服务器上可能不可用：同步时检测命令并提示。
5. **服务器的 `/tmp` 空间不足或有 noexec**：上传和解压都直接在 `~/.pi-web` 下进行。
