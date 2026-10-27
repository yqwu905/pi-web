# Pi-Web

在浏览器里管理远程 SSH 服务器上的 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)。

- **离线部署**：服务器不能上网也没关系。Host 打包 Node.js 运行时和 pi，通过 SSH 上传并安装到 `~/.pi-web`，不需要 root。
- **集中管理**：服务器 → 工作区 → 对话三层结构。对话界面支持流式输出、工具卡片（bash / read / edit diff / write …）、steer / follow-up 队列、模型和思考级别切换、会话树跳转与标签、Fork / Clone、压缩上下文，以及导出 HTML / JSONL。扩展 UI（select / confirm / input / editor / notify）也在网页中呈现。
- **LLM 隧道代理**：服务器上 pi 的 LLM 请求，经 SSH 链路回到 Host 再发出（HTTP CONNECT，TLS 端到端），不依赖 sshd 的端口转发。Host 端强制执行域名白名单；默认只放行 LLM provider，可按服务器开放给工具命令。
- **配置与插件同步**：把 Host 的 `~/.pi/agent`（settings、models、auth、mcp、AGENTS.md、extensions、skills、prompts、themes、npm/git 插件包）单向增量同步到服务器，支持自动同步。冲突文件会先备份再覆盖。OAuth 的 refresh token 只保存在 Host，由 Pi-Web 在过期前刷新，再把 access token 推送到服务器。
- **对话体验**：每轮回复末尾显示模型的输出速率（tok/s，不含首字延迟）和首字延迟，生成中显示实时估算；工具调用默认折叠，可一键全部展开/折叠；右侧的消息导航条可悬停预览、点击跳转到任意一条用户消息；每轮回复末尾的 Fork 按钮可以接着这条回复开一个新对话；rpiv-todo（`@juicesharp/rpiv-todo`）的任务清单显示在输入框上方，压缩上下文后依然完整（需要 agent 0.1.3：在服务器页升级 agent 后，新启动的 pi 进程生效）。
- **归档会话**：把不再需要的会话归档，侧栏只在每个工作区的“已归档”分组中显示它们，可随时恢复或删除；在归档的会话里发消息会自动恢复。归档只是 Pi-Web 中的隐藏标记（保存在 Host，服务器离线时也能操作），服务器上的会话文件不动，pi 自己的 `/resume` 照样能看到。
- **工作区工具**：远程文件浏览（代码高亮、Markdown 预览）、Web 终端（xterm.js）、Git 变更与 diff 查看。
- **环境变量**：在“服务器设置 → 环境变量”中配置服务器级变量（例如扩展需要的内网服务地址），作用于该服务器所有工作区的 pi 进程、Web 终端和 `~/.pi-web/bin/pi`；工作区可设置同名变量覆盖。修改后对新启动的 pi 进程和新打开的终端生效（已部署的服务器需先升级 agent，Web 终端和 `bin/pi` 才能读到）。

> 设计文档：[docs/DESIGN.md](docs/DESIGN.md)（产品设计）· [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)（工程规范）· [docs/ui-design/](docs/ui-design/)（界面设计稿）

## 架构

```
浏览器 ──HTTP/WS──▶ Pi-Web（Host，Node.js）──SSH（一条 exec 通道复用所有流量 + SFTP）──▶ 服务器
                     │                                                  ~/.pi-web/
                     ├─ SSH 连接池（跳板机、主机指纹 TOFU）              ├─ runtime/  Node.js
                     ├─ 离线部署（打包 / 上传 / 安装）                   ├─ pi/       pi 及依赖
                     ├─ 隧道代理出口（白名单、上游代理）                 ├─ agent/    pi 配置目录（同步目标）
                     ├─ 配置同步 + OAuth 托管                            └─ daemon/   pi-web-agent（常驻）
                     └─ 对话服务（事件转发、快照、断线重放）                  └─ 每个对话一个 `pi --mode rpc` 进程
```

- 服务器端的 `pi-web-agent` 是常驻守护进程：Pi-Web 或网络断开时，正在运行的 pi 不会中断，重连后补发错过的事件。
- 代码按包组织：`packages/shared`（协议、类型、会话 reducer）、`packages/agent`（远端 daemon / bridge / pi 伴随扩展）、`packages/server`（Host 服务，npm 包名 `pi-web`）、`packages/web`（React 前端）。

## 环境要求

| | 要求 |
|---|---|
| Host | Linux，Node.js ≥ 22.19，`npm`、`tar`、`xz`。首次部署时需要能访问 Node.js 下载源和 npm registry（可配置镜像或上游代理） |
| 服务器 | Linux x86_64 / aarch64，glibc ≥ 2.28，`tar`、`gzip`，可以 SSH 登录（密码、私钥或 ssh-agent，支持跳板机）。**不需要外网** |

## 快速开始

```bash
npm ci
npm run build
node packages/server/dist/cli.mjs          # 或者：npm i -g ./packages/server && pi-web
```

浏览器打开 `http://127.0.0.1:7878/`，然后：

1. **添加服务器**：填写连接信息，确认主机指纹 → 环境探测 → 离线部署（实时进度）→ 选择同步项。
2. 在侧栏的服务器下 **新建工作区**：通过远程目录选择器选择或新建目录，并设置 project trust 和默认模型。
3. **新建对话**，开始使用。服务器的终端里也可以直接运行 `~/.pi-web/bin/pi`，它使用同一套配置和隧道。

命令行参数：

```
pi-web [--host 127.0.0.1] [--port 7878] [--data-dir DIR] [--dev]
```

- 数据目录默认是 `~/.pi-web-host`（也可用 `$PI_WEB_DATA_DIR` 指定），保存服务器配置、加密的凭据、离线包缓存和日志。
- Host 的 pi 配置目录默认是 `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent`，可以在“设置”中修改。

## 安全说明

- 默认只监听 `127.0.0.1`。每个请求都会校验 Host 和 Origin，防御 DNS rebinding 和 CSRF。在“设置 → 访问控制”可以开启访问令牌（Bearer），防止本机其他用户访问。
- SSH 密码和私钥口令使用 AES-256-GCM 加密存储（`master.key` 权限 0600）。首次连接时确认主机指纹，之后指纹变化会拒绝连接。
- 隧道代理：
  - 服务器端只监听回环地址，并需要每次启动时重新生成的令牌；
  - Host 端按 host:port 白名单放行，并拒绝回环地址、私有网段、本机地址以及 Pi-Web 自身端口；
  - 默认只放行 LLM provider，bash 工具不继承代理变量。
- 服务器上的 `auth.json` 不包含 OAuth refresh token。
- 同步到服务器的扩展和插件可以执行任意代码，请只同步你信任的内容。
- 服务器级和工作区环境变量以明文保存（Host 数据目录，以及服务器上权限 0600 的 `~/.pi-web/run/env.sh`），不要在其中存放高价值密钥。

## 开发

```bash
npm run dev -w pi-web -- --dev      # 后端（tsx watch，接受 Vite 来源）
npm run dev -w @pi-web/web          # 前端（Vite，代理 /api 和 /ws 到 7878）
```

测试：

```bash
npm run typecheck                    # 4 个包的类型检查
npm test                             # 单元/集成测试（vitest）
npm run build && npm run e2e:api     # API 端到端（需要 root 和 OpenSSH）
npm run build && npm run e2e:ui      # 浏览器端到端（Playwright + Chromium），截图保存在 e2e/screenshots/
```

API 端到端测试的流程：

1. 在本机启动 sshd（用户 `pitest`，端口 2222）作为“服务器”；
2. 启动一个 OpenAI 兼容的 mock LLM（`e2e/mock-llm.mjs`，域名 `mock-llm.test`）；
3. 走完整流程：部署 → 对话（LLM 流量经隧道）→ 伴随扩展操作 → 终端 → 服务器级环境变量 → 同步、自动同步、OAuth 变换 → 断线重连 → 生成计时、任务清单与上下文压缩 → 卸载。

## 已知限制

- 服务器只支持 Linux x64 / arm64（glibc ≥ 2.28），不支持 CentOS 7 等老系统。
- 含平台相关原生模块的插件包（例如只有 macOS 构建的）同步到 Linux 后可能无法使用，同步预览中会给出警告。
- `mcp.json` 中依赖 `npx` / `uvx` 在线安装的 MCP 服务器，在离线服务器上可能不可用。
- pi 的 RPC 模式不支持 TUI 专属功能，例如扩展的自定义组件和主题切换。
