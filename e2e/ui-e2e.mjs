#!/usr/bin/env node
/**
 * Browser end-to-end test of Pi-Web: drives the built SPA (served by packages/server/dist/cli.mjs)
 * in headless Chromium at 1440×960 with Playwright, against the same environment as
 * e2e/api-e2e.mjs — a real local sshd (pitest@127.0.0.1:2222) and the mock LLM on mock-llm.test.
 *
 * Every step takes a screenshot into e2e/screenshots/. A step fails on uncaught page errors,
 * unexpected console errors, failed /api calls (HTTP ≥ 400 or network failures) and on a page
 * that scrolls as a whole (the app shell must fit the viewport).
 *
 * Prerequisites: Linux, root, OpenSSH server, Chromium for Playwright (PLAYWRIGHT_BROWSERS_PATH),
 * the playwright package (local or global npm install) and a build:
 *   npm run build && npm run e2e:ui
 *
 * Environment:
 *   E2E_KEEP=1      keep the temp directory (host agent dir, data dir, logs) after the run
 *   E2E_VERBOSE=1   print server output and browser console messages
 *   E2E_HEADED=1    run Chromium with a window (needs a display)
 *   E2E_HOLD=1      keep the environment running after the steps (prints the URL; Ctrl+C stops it)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
	AssertionError,
	ROOT,
	Runner,
	VERBOSE,
	assert,
	cleanup,
	freePort,
	info,
	pinCachedNodeVersion,
	prepareHostAgentDir,
	preflight,
	seedBundleCache,
	sleep,
	startMockLlm,
	startPiWebProcess,
	startSshdFixture,
	tailFile,
	waitUntil,
} from "./lib/env.mjs";

const SHOTS = path.join(ROOT, "e2e/screenshots");
const VIEWPORT = { width: 1440, height: 960 };
const WS_DIR = "ui-e2e-ws";
const SERVER_NAME = "ui-e2e";

const runner = new Runner();
const step = (...args) => runner.step(...args);

// ------------------------------------------------------------------ playwright

/** Resolves the playwright package: local node_modules first, then the global npm root. */
async function loadPlaywright() {
	try {
		return await import("playwright");
	} catch {
		// not installed locally
	}
	const roots = [];
	try {
		roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
	} catch {
		// npm unavailable
	}
	roots.push("/opt/node22/lib/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules");
	for (const root of roots) {
		try {
			return createRequire(path.join(root, "noop.js"))("playwright");
		} catch {
			// try the next root
		}
	}
	throw new AssertionError("the playwright package is not installed (npm i -g playwright, browsers via PLAYWRIGHT_BROWSERS_PATH)");
}

/** A Chromium binary from PLAYWRIGHT_BROWSERS_PATH, used when Playwright's own lookup fails. */
function findChromium() {
	const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
	if (!existsSync(base)) return undefined;
	for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
		for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
			const file = path.join(base, dir, rel);
			if (existsSync(file)) return file;
		}
	}
	return undefined;
}

/**
 * Browser problems seen since the last check: page errors, console errors and failed API calls.
 * `allow` patterns (matched against the problem text) mark expected ones.
 */
class ProblemLog {
	constructor() {
		this.items = [];
		this.checked = 0;
	}
	add(kind, text) {
		this.items.push({ kind, text });
		if (VERBOSE) info(`  [browser ${kind}] ${text}`);
	}
	/** Throws when unexpected problems occurred since the previous check. */
	check(allow = []) {
		const fresh = this.items.slice(this.checked);
		this.checked = this.items.length;
		const unexpected = fresh.filter((p) => !allow.some((re) => re.test(p.text)));
		assert(unexpected.length === 0, `browser problems:\n      ${unexpected.map((p) => `${p.kind}: ${p.text}`).join("\n      ")}`);
	}
}

// ------------------------------------------------------------------ main

async function main() {
	let tmp;
	let hostAgentDir;
	let dataDir;
	let fixture;
	let runAsTestUser;
	let api;
	let base;
	let serverLogFile;
	let browser;
	let page;
	const problems = new ProblemLog();
	let shotIndex = 0;
	const screenshots = [];

	/** Screenshot of the current page into e2e/screenshots/NN-name.png. */
	async function shot(name) {
		shotIndex++;
		const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
		await page.screenshot({ path: file });
		screenshots.push(path.relative(ROOT, file));
	}

	/** The app shell fits the viewport: the document itself never scrolls. */
	async function checkLayout(where) {
		const m = await page.evaluate(() => {
			const el = document.scrollingElement ?? document.documentElement;
			return { sw: el.scrollWidth, sh: el.scrollHeight, w: window.innerWidth, h: window.innerHeight };
		});
		assert(m.sw <= m.w && m.sh <= m.h, `${where}: the page scrolls as a whole (${m.sw}×${m.sh} in a ${m.w}×${m.h} viewport)`);
	}

	/** Runs a UI step: screenshot on failure, browser problem + layout checks on success. */
	function uiStep(section, name, fn, { critical = false, allow = [], layout = true } = {}) {
		return step(
			section,
			name,
			async () => {
				try {
					await fn();
					if (layout) await checkLayout(name);
					problems.check(allow);
				} catch (err) {
					if (page) {
						const file = path.join(SHOTS, `FAILED-${String(shotIndex + 1).padStart(2, "0")}-${name.replace(/[^\w一-龥-]+/g, "_").slice(0, 60)}.png`);
						await page.screenshot({ path: file }).catch(() => {});
						info(`      failure screenshot: ${path.relative(ROOT, file)}`);
					}
					problems.checked = problems.items.length;
					throw err;
				}
			},
			{ critical },
		);
	}

	const sidebar = () => page.getByRole("complementary", { name: "服务器与会话" });
	const messages = () => page.getByRole("region", { name: "对话消息" });
	const composer = () => page.getByLabel("消息", { exact: true });
	const infoPanel = () => page.getByRole("complementary", { name: "会话信息" });

	// ---------------------------------------------------------------- setup
	const S0 = "setup";
	await step(S0, "preflight: built dist, root, OpenSSH, Playwright + Chromium", async () => preflight(), { critical: true });

	let playwright;
	await step(
		S0,
		"load Playwright",
		async () => {
			playwright = await loadPlaywright();
		},
		{ critical: true },
	);

	await step(
		S0,
		"environment: host agent dir, mock LLM, sshd fixture, pi-web",
		async () => {
			({ tmp, hostAgentDir, dataDir } = await prepareHostAgentDir("pi-web-ui-e2e-"));
			await startMockLlm(tmp);
			({ fixture, runAsTestUser } = await startSshdFixture({ cleanPaths: [WS_DIR] }));
			runner.onFirstFailure = async () => {
				await writeFile(path.join(tmp, "remote-agent.log"), runAsTestUser("cat ~/.pi-web/logs/agent.log 2>/dev/null").stdout).catch(() => {});
			};
			await seedBundleCache(dataDir);
			const port = await freePort();
			serverLogFile = path.join(tmp, "pi-web.out");
			({ api } = await startPiWebProcess({ hostAgentDir, dataDir, port, logFile: serverLogFile }));
			base = api.base;
			await pinCachedNodeVersion(api, dataDir);
		},
		{ critical: true },
	);

	await step(
		S0,
		"launch Chromium 1440×960",
		async () => {
			rmSync(SHOTS, { recursive: true, force: true });
			mkdirSync(SHOTS, { recursive: true });
			const headless = process.env.E2E_HEADED !== "1";
			try {
				browser = await playwright.chromium.launch({ headless });
			} catch (err) {
				const executablePath = findChromium();
				if (!executablePath) throw err;
				browser = await playwright.chromium.launch({ headless, executablePath });
			}
			const context = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
			context.setDefaultTimeout(15_000);
			page = await context.newPage();
			page.on("pageerror", (err) => problems.add("pageerror", err.stack ?? err.message));
			page.on("console", (msg) => {
				if (msg.type() === "error") problems.add("console.error", msg.text());
				else if (VERBOSE) info(`  [console.${msg.type()}] ${msg.text()}`);
			});
			page.on("response", (res) => {
				const url = new URL(res.url());
				if (url.pathname.startsWith("/api/") && res.status() >= 400) problems.add("api", `${res.request().method()} ${url.pathname}${url.search} → ${res.status()}`);
			});
			page.on("requestfailed", (req) => {
				const url = new URL(req.url());
				// Requests cancelled by a navigation or an unmounting component are not failures.
				if (url.pathname.startsWith("/api/") && req.failure()?.errorText !== "net::ERR_ABORTED") problems.add("requestfailed", `${req.method()} ${url.pathname} ${req.failure()?.errorText}`);
			});
		},
		{ critical: true },
	);

	// ---------------------------------------------------------------- add-server wizard
	const S1 = "wizard";
	let serverId;

	await uiStep(
		S1,
		"home page offers 添加服务器 → wizard step 1",
		async () => {
			await page.goto(`${base}/`);
			await page.getByText("欢迎使用 Pi-Web").waitFor();
			await shot("home-empty");
			await page.getByRole("main").getByRole("link", { name: "添加服务器" }).click();
			await page.waitForURL(/\/servers\/new$/);
			await page.getByRole("heading", { name: "SSH 连接" }).waitFor();
			await shot("wizard-connection");
		},
		{ critical: true },
	);

	await uiStep(
		S1,
		"连接信息: key auth with the fixture key, 测试连接",
		async () => {
			await page.getByLabel("名称").fill(SERVER_NAME);
			await page.getByLabel("主机").fill("127.0.0.1");
			await page.getByLabel("端口").fill(String(fixture.port));
			await page.getByLabel("用户名").fill(fixture.user);
			await page.getByRole("button", { name: "私钥", exact: true }).click();
			await page.getByLabel("私钥路径").fill(fixture.keyPath);
			await page.getByRole("button", { name: "测试连接" }).click();
			await page.getByText("已连接到 SSH 服务 · 下一步核对主机指纹").waitFor({ timeout: 20_000 });
			await shot("wizard-connection-tested");
		},
		{ critical: true },
	);

	await uiStep(
		S1,
		"主机验证: the presented fingerprint matches sshd, trust it",
		async () => {
			await page.getByRole("button", { name: "下一步" }).click();
			await page.waitForURL(/\/servers\/new\?server=/);
			serverId = new URL(page.url()).searchParams.get("server");
			assert(serverId, "server id in the URL");
			const trust = page.getByRole("button", { name: "信任并继续" });
			await trust.waitFor();
			await page.getByText("需要确认 · 未知主机").waitFor();
			const body = await page.getByRole("main").innerText();
			assert(fixture.hostFingerprints.some((fp) => body.includes(fp)), "the wizard shows the sshd host key fingerprint", body.slice(0, 1500));
			await shot("wizard-hostkey");
			await trust.click();
			await page.getByRole("heading", { name: "环境探测" }).waitFor({ timeout: 20_000 });
		},
		{ critical: true },
	);

	await uiStep(
		S1,
		"环境探测: every check passes",
		async () => {
			await page.getByText(/\d+ 项通过/).waitFor({ timeout: 60_000 });
			const next = page.getByRole("button", { name: "下一步" });
			await waitUntil("下一步 enabled", () => next.isEnabled(), { timeoutMs: 10_000 });
			const text = await page.getByRole("main").innerText();
			assert(/Linux x64/.test(text) && text.includes(fixture.home), "probe shows the OS and home", text.slice(0, 2000));
			assert(!/未通过|不满足/.test(text), "no failed probe checks", text.slice(0, 2000));
			await shot("wizard-probe");
			await next.click();
			await page.getByRole("button", { name: "开始部署" }).waitFor();
			await shot("wizard-deploy-options");
		},
		{ critical: true },
	);

	await uiStep(
		S1,
		"离线部署: live progress until done",
		async () => {
			const panel = page.getByRole("region", { name: "部署进度" });
			await page.getByRole("button", { name: "开始部署" }).click();
			// Live state: elapsed time ticking and a running step.
			await panel.getByText(/已用时/).waitFor({ timeout: 10_000 });
			await panel.getByText("进行中").first().waitFor({ timeout: 10_000 });
			await shot("wizard-deploy-running");
			await panel.getByText(/部署完成 · 用时/).waitFor({ timeout: 10 * 60_000 });
			const text = await panel.innerText();
			assert(!/失败|等待|进行中/.test(text), "every deploy step finished", text);
			assert(/100%/.test(text) && /自检/.test(text), "deploy panel complete", text);
			await shot("wizard-deploy-done");
		},
		{ critical: true },
	);

	await uiStep(
		S1,
		"同步配置 → 完成: server page shows 在线 and the deployment",
		async () => {
			await page.getByRole("button", { name: "下一步" }).click();
			await page.getByRole("button", { name: "完成并打开服务器" }).waitFor();
			const text = await page.getByRole("main").innerText();
			assert(/extensions\//.test(text) && /skills\//.test(text) && /prompts\//.test(text), "sync step lists the sync items", text.slice(0, 1500));
			await shot("wizard-sync");
			await page.getByRole("button", { name: "完成并打开服务器" }).click();
			await page.waitForURL(new RegExp(`/servers/${serverId}$`));
			await page.getByRole("heading", { name: SERVER_NAME }).waitFor();
			const main = page.getByRole("main");
			await main.getByText(/^在线 · \d+ms$/).first().waitFor({ timeout: 20_000 });
			await main.getByRole("heading", { name: "运行环境" }).waitFor();
			const detail = await main.innerText();
			const view = await api.get(`/servers/${serverId}`);
			assert(view.config.deployed?.piVersion && view.status.connection === "connected", "server deployed and connected", view.status);
			for (const expected of [view.config.deployed.piVersion, view.config.deployed.nodeVersion, "pi-web-agent", "~/.pi-web"]) {
				assert(detail.includes(expected), `server page shows ${expected}`, detail.slice(0, 2500));
			}
			assert(/部署时间/.test(detail), "server page shows when it was deployed", detail.slice(0, 2500));
			await shot("server-detail");
		},
		{ critical: true },
	);

	// ---------------------------------------------------------------- workspace
	const S2 = "workspace";
	let workspaceId;

	await uiStep(
		S2,
		"新建工作区 dialog: directory picker + 新建文件夹",
		async () => {
			const sb = sidebar();
			await sb.getByRole("button", { name: "新建工作区" }).click();
			const dialog = page.getByRole("dialog", { name: `新建工作区 · ${SERVER_NAME}` });
			await dialog.waitFor();
			await dialog.getByRole("navigation", { name: "当前目录" }).getByText(fixture.user).waitFor();
			await shot("workspace-dialog");
			await dialog.getByRole("button", { name: "新建文件夹" }).click();
			await dialog.getByLabel("新文件夹名称").fill(WS_DIR);
			await dialog.getByLabel("新文件夹名称").press("Enter");
			const created = dialog.getByRole("button", { name: WS_DIR, pressed: true });
			await created.waitFor({ timeout: 15_000 });
			assert(runAsTestUser(`test -d ~/${WS_DIR} && echo yes`).stdout.trim() === "yes", "the folder exists on the server");
			assert((await dialog.getByLabel("别名").inputValue()) === WS_DIR, "alias defaults to the folder name");
			await dialog.getByText(`${fixture.home}/${WS_DIR}`).waitFor();
			await shot("workspace-dialog-mkdir");
		},
		{ critical: true },
	);

	await uiStep(
		S2,
		"创建 → the workspace appears in the sidebar and its new conversation opens",
		async () => {
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("button", { name: "创建", exact: true }).last().click();
			await page.waitForURL(/\/w\/[^/]+\/chat$/, { timeout: 20_000 });
			workspaceId = decodeURIComponent(new URL(page.url()).pathname.split("/")[2]);
			await dialog.waitFor({ state: "detached" });
			await sidebar().getByRole("button", { name: WS_DIR, exact: false }).first().waitFor();
			await page.getByText("开始新对话").waitFor();
			const list = await api.get(`/servers/${serverId}/workspaces`);
			assert(list.workspaces.some((w) => w.config.id === workspaceId && w.config.path === `${fixture.home}/${WS_DIR}`), "workspace saved", list);
			await shot("workspace-created");
			// Project content for the files / git pages.
			const r = runAsTestUser(
				[
					"set -e",
					`cd ~/${WS_DIR}`,
					"git init -q -b main . 2>/dev/null || git init -q .",
					`printf '# UI E2E\\n\\nSome **bold** text.\\n\\n- item one\\n- item two\\n' > README.md`,
					"mkdir -p src && printf 'export const answer = 42;\\n' > src/app.js",
					"git add -A && git -c user.name=E2E -c user.email=e2e@example.com commit -qm 'initial commit'",
					`printf '\\nChanged by ui-e2e.\\n' >> README.md`,
					"printf 'untracked\\n' > notes.txt",
				].join("\n"),
			);
			assert(r.status === 0, "workspace content setup failed", r.stdout);
		},
		{ critical: true },
	);

	// ---------------------------------------------------------------- chat
	const S3 = "chat";
	let sessionId;

	await uiStep(S3, "新建对话 from the sidebar", async () => {
		await sidebar().getByRole("button", { name: "新建对话" }).click();
		await page.waitForURL(new RegExp(`/w/${workspaceId}/chat$`));
		await composer().waitFor();
		await page.getByText("开始新对话").waitFor();
	});

	await uiStep(S3, 'send "你好" → streamed reply', async () => {
		await composer().fill("你好");
		await composer().press("Enter");
		await messages().getByText("你好", { exact: true }).waitFor();
		await messages().getByText("收到：你好").waitFor({ timeout: 60_000 });
		await page.waitForURL(new RegExp(`/w/${workspaceId}/chat/[^/]+$`), { timeout: 20_000 });
		sessionId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
		await sidebar().getByRole("link", { name: /你好/ }).first().waitFor({ timeout: 20_000 });
		await waitUntil("composer ready", async () => (await composer().inputValue()) === "", { timeoutMs: 5000 });
		await shot("chat-hello");
	});

	await uiStep(S3, 'send "run: echo ui-e2e" → bash tool card with output', async () => {
		await composer().fill("run: echo ui-e2e");
		await composer().press("Enter");
		await messages().getByText("工具执行完成：ui-e2e").waitFor({ timeout: 60_000 });
		const card = messages().getByRole("group", { name: "工具 bash echo ui-e2e" });
		await card.getByText(/退出码 0/).waitFor();
		const output = await card.locator("pre").first().innerText();
		assert(output.trim() === "ui-e2e", "tool card shows the command output", output);
		await shot("chat-bash-tool");
	});

	await uiStep(S3, "info panel: context and usage numbers", async () => {
		const panel = infoPanel();
		await panel.waitFor();
		// Stats refresh shortly after agent_settled.
		await waitUntil("usage after the tool call", async () => /工具调用\s+1\b/.test(await panel.innerText()), { timeoutMs: 15_000 });
		const text = await panel.innerText();
		assert(/\d+(\.\d+)?k? \/ 32k/.test(text) && /\d+%/.test(text), "context window usage", text);
		const number = (label) => Number((text.match(new RegExp(`${label}\\s+([\\d.,]+)`)) ?? [])[1]?.replace(/,/g, ""));
		assert(number("输入") > 0 && number("输出") > 0, "token usage", text);
		assert(text.includes(sessionId), "the session file is shown", text);
		await shot("chat-info-panel");
	});

	await uiStep(S3, "session tree: entries listed, label an entry", async () => {
		await infoPanel().getByRole("button", { name: "树视图" }).click();
		const dialog = page.getByRole("dialog", { name: "会话树" });
		await dialog.waitFor();
		const rows = dialog.locator("button[data-row]");
		await rows.first().waitFor();
		const texts = await rows.allInnerTexts();
		assert(texts.some((t) => t.includes("run: echo ui-e2e")) && texts.some((t) => t.includes("收到：你好")), "tree lists the conversation", texts);
		assert((await dialog.getByText("当前位置", { exact: true }).count()) === 1, "one current position");
		await shot("session-tree");
		const userRow = rows.filter({ hasText: "用户" }).filter({ hasText: "你好" }).first();
		await userRow.click();
		await dialog.getByRole("button", { name: "添加标签" }).click();
		await dialog.getByLabel("标签名称").fill("ui-label");
		await dialog.getByLabel("标签名称").press("Enter");
		await userRow.getByText("ui-label").waitFor({ timeout: 10_000 });
		// Labelling appends an entry after the last message; that message stays the current position.
		await dialog.getByText("当前位置", { exact: true }).waitFor();
		assert((await dialog.getByText("当前位置", { exact: true }).count()) === 1, "still one current position after labelling");
		await shot("session-tree-labelled");
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
	});

	await uiStep(S3, "model and thinking pickers open", async () => {
		await page.getByRole("button", { name: /^模型/ }).click();
		const listbox = page.getByRole("listbox");
		await listbox.getByRole("option", { name: /mock-1/ }).waitFor();
		await shot("chat-model-picker");
		await page.keyboard.press("Escape");
		await listbox.waitFor({ state: "detached" });
		await page.getByRole("button", { name: /^思考/ }).click();
		await page.getByRole("listbox").getByRole("option", { name: /off/ }).waitFor();
		await shot("chat-thinking-picker");
		await page.keyboard.press("Escape");
		await page.getByRole("listbox").waitFor({ state: "detached" });
	});

	await uiStep(S3, '"/" autocomplete shows the synced prompt template and skill; the template expands remotely', async () => {
		await composer().fill("/");
		const menu = page.getByRole("listbox");
		await menu.getByRole("option", { name: /\/e2e-review/ }).waitFor();
		await menu.getByRole("option", { name: /\/skill:demo/ }).waitFor();
		await menu.getByRole("option", { name: /\/e2e-hello/ }).waitFor();
		await shot("chat-slash-menu");
		await composer().fill("/e2e-rev");
		await menu.getByRole("option", { name: /\/e2e-review/ }).waitFor();
		await composer().press("Tab");
		await waitUntil("template completed", async () => (await composer().inputValue()) === "/e2e-review ", { timeoutMs: 5000 });
		await composer().pressSequentially("security");
		await composer().press("Enter");
		await messages().getByText("收到：Review the workspace. Focus on security.").waitFor({ timeout: 60_000 });
		await shot("chat-prompt-template");
	});

	await uiStep(S3, "reload restores the conversation from the snapshot", async () => {
		await page.reload();
		await messages().getByText("收到：你好").waitFor({ timeout: 30_000 });
		await messages().getByText("工具执行完成：ui-e2e").waitFor();
		await messages().getByText("收到：Review the workspace. Focus on security.").waitFor();
		await messages().getByText("echo ui-e2e", { exact: true }).waitFor();
		await waitUntil("usage restored", async () => /工具调用\s+1/.test(await infoPanel().innerText()), { timeoutMs: 15_000 });
		await shot("chat-reloaded");
	});

	await uiStep(S3, "navigate away (server page) and back (sidebar) keeps the history", async () => {
		await page.getByRole("navigation", { name: "位置" }).getByRole("link", { name: SERVER_NAME, exact: true }).click();
		await page.waitForURL(new RegExp(`/servers/${serverId}$`));
		await page.getByRole("heading", { name: "运行环境" }).waitFor();
		await sidebar().getByRole("link", { name: /你好/ }).first().click();
		await page.waitForURL(new RegExp(`/w/${workspaceId}/chat/${sessionId}$`));
		await messages().getByText("工具执行完成：ui-e2e").waitFor();
		await messages().getByText("收到：你好").waitFor();
		await shot("chat-back");
	});

	// ---------------------------------------------------------------- files / git / terminal
	const S4 = "files+git+terminal";

	await uiStep(S4, "files: tree, open README.md, markdown preview and source", async () => {
		await page.getByRole("link", { name: "文件" }).click();
		await page.waitForURL(new RegExp(`/w/${workspaceId}/files`));
		const tree = page.getByRole("tree", { name: "工作区文件" });
		for (const name of ["src", "README.md", "notes.txt"]) await tree.getByRole("treeitem", { name: new RegExp(name.replace(".", "\\.")) }).waitFor();
		await shot("files-tree");
		await tree.getByRole("treeitem", { name: /README\.md/ }).click();
		await page.waitForURL(/\?path=README\.md$/);
		const preview = page.getByRole("article", { name: "README.md 预览" });
		await preview.getByRole("heading", { name: "UI E2E" }).waitFor();
		await preview.locator("strong", { hasText: "bold" }).waitFor();
		await preview.getByRole("listitem").filter({ hasText: "item two" }).waitFor();
		await shot("files-markdown-preview");
		await page.getByRole("button", { name: "源码", exact: true }).click();
		await page.getByRole("region", { name: "文件内容" }).getByText("# UI E2E").waitFor();
		await shot("files-markdown-source");
	});

	await uiStep(S4, "git: changed file and its diff, inline and side by side", async () => {
		await page.getByRole("link", { name: /^Git/ }).click();
		await page.waitForURL(new RegExp(`/w/${workspaceId}/git`));
		await page.getByText("未暂存（1）").waitFor({ timeout: 20_000 });
		await page.getByText("未跟踪（1）").waitFor();
		await page.getByText("initial commit").waitFor();
		const added = page.getByText("Changed by ui-e2e.");
		await added.first().waitFor();
		await shot("git-inline");
		await page.getByRole("button", { name: "并排" }).click();
		await waitUntil("side-by-side diff", async () => (await page.getByRole("button", { name: "并排" }).getAttribute("aria-pressed")) === "true", { timeoutMs: 5000 });
		await added.first().waitFor();
		await shot("git-split");
		await page.getByRole("button", { name: "行内" }).click();
	});

	await uiStep(S4, "terminal: type a command and see its output", async () => {
		await page.getByRole("link", { name: "终端" }).click();
		await page.waitForURL(new RegExp(`/w/${workspaceId}/terminal`));
		const term = page.locator(".xterm").first();
		await term.waitFor({ timeout: 20_000 });
		await page.getByText("已连接").first().waitFor({ timeout: 20_000 });
		await waitUntil("shell prompt", async () => /\$\s*$/m.test(await page.locator(".xterm-rows").first().innerText()), { timeoutMs: 20_000 });
		await term.click();
		await page.keyboard.type("echo term-$((6*7))\n");
		await waitUntil("command output", async () => /^term-42\s*$/m.test(await page.locator(".xterm-rows").first().innerText()), { timeoutMs: 15_000 });
		await shot("terminal");
	});

	// ---------------------------------------------------------------- sync center
	const S5 = "sync";

	await uiStep(S5, "sync center: inventory, matrix and preview", async () => {
		await sidebar().getByRole("link", { name: "同步中心" }).click();
		await page.waitForURL(/\/sync$/);
		const main = page.getByRole("main");
		await main.getByRole("heading", { name: "同步中心" }).waitFor();
		await main.getByText(`Host 配置 · ${hostAgentDir}`).waitFor();
		for (const item of ["settings.json", "models.json", "extensions/", "skills/", "prompts/"]) await main.getByText(item, { exact: true }).first().waitFor();
		const row = main.getByRole("region", { name: "同步矩阵" }).getByRole("row").filter({ hasText: SERVER_NAME });
		await row.waitFor();
		await waitUntil("matrix row synced", async () => (await row.innerText()).includes("已同步"), { timeoutMs: 20_000 });
		await main.getByText(/OAuth 托管/).waitFor();
		await main.getByText("e2e-oauth").waitFor();
		await waitUntil("auth.json pushed (deploy sync counts)", async () => !(await main.innerText()).includes("尚未推送到服务器"), { timeoutMs: 10_000 });
		await shot("sync-center");
		await main.getByRole("button", { name: "预览全部差异" }).click();
		const preview = main.getByRole("region", { name: `差异预览 · ${SERVER_NAME}` });
		await preview.getByText("已是最新，无需同步").waitFor({ timeout: 20_000 });
		await shot("sync-preview");
	});

	await uiStep(S5, "sync center: a host change shows up in the preview, run sync applies it", async () => {
		// Turn auto-sync off for this server so the change waits for the manual run.
		await api.put(`/servers/${serverId}`, { sync: { auto: false } });
		await writeFile(path.join(hostAgentDir, "prompts", "ui-e2e-new.md"), "---\ndescription: UI E2E prompt\n---\nUI E2E prompt body\n");
		const main = page.getByRole("main");
		const preview = main.getByRole("region", { name: `差异预览 · ${SERVER_NAME}` });
		await waitUntil(
			"pending change in the preview",
			async () => {
				await preview.getByRole("button", { name: "重新计算差异" }).click({ timeout: 2000 }).catch(() => {});
				return (await preview.getByText("prompts/ui-e2e-new.md").count()) > 0;
			},
			{ timeoutMs: 30_000, intervalMs: 1500 },
		);
		await main.getByRole("region", { name: "同步矩阵" }).getByRole("row").filter({ hasText: SERVER_NAME }).getByText("待同步").first().waitFor({ timeout: 10_000 });
		// The host inventory follows the change (prompts/ now holds two templates).
		await main.getByRole("region", { name: /^Host 配置/ }).getByText("prompts/").locator("xpath=..").getByText("2 个").waitFor({ timeout: 10_000 });
		await shot("sync-pending-change");
		await preview.getByRole("button", { name: `同步 ${SERVER_NAME}` }).click();
		await preview.getByText("已是最新，无需同步").waitFor({ timeout: 30_000 });
		await main.getByRole("region", { name: "同步历史" }).getByRole("row").filter({ hasText: "手动" }).first().waitFor({ timeout: 10_000 });
		assert(runAsTestUser("cat ~/.pi-web/agent/prompts/ui-e2e-new.md").stdout.includes("UI E2E prompt body"), "the prompt reached the server");
		await shot("sync-run");
		await api.put(`/servers/${serverId}`, { sync: { auto: true } });
	});

	// ---------------------------------------------------------------- settings
	const S6 = "settings";

	await uiStep(S6, "global settings: change the proxy port range end and save", async () => {
		await page.getByRole("link", { name: "全局设置" }).click();
		await page.waitForURL(/\/settings$/);
		await page.getByRole("heading", { name: "全局设置" }).waitFor();
		await page.getByText("所有更改已保存").waitFor();
		await shot("settings");
		const before = await api.get("/settings");
		const portTo = page.getByLabel("结束端口");
		const next = String(Number(await portTo.inputValue()) - 1);
		await portTo.fill(next);
		await page.getByText("有 1 项未保存的更改").waitFor();
		await page.getByRole("button", { name: "保存", exact: true }).click();
		await page.getByText("所有更改已保存").waitFor({ timeout: 10_000 });
		const after = await api.get("/settings");
		assert(String(after.proxyPortRange?.[1]) === next && after.proxyPortRange[1] !== before.proxyPortRange[1], "port range saved", { before: before.proxyPortRange, after: after.proxyPortRange });
		await page.reload();
		await waitUntil("saved value after reload", async () => (await page.getByLabel("结束端口").inputValue()) === next, { timeoutMs: 10_000 });
		await shot("settings-saved");
	});

	await uiStep(S6, "server settings: change 空闲回收 and save", async () => {
		await page.goto(`${base}/servers/${serverId}`);
		await page.getByRole("heading", { name: "运行环境" }).waitFor();
		await page.getByRole("main").getByRole("link", { name: "设置" }).first().click();
		await page.waitForURL(new RegExp(`/servers/${serverId}/settings$`));
		await page.getByRole("heading", { name: "服务器设置" }).waitFor();
		await shot("server-settings");
		const idle = page.getByLabel("空闲回收");
		await idle.selectOption("60");
		await page.getByRole("button", { name: "保存更改" }).click();
		await page.getByText("所有更改已保存").waitFor({ timeout: 15_000 });
		const view = await api.get(`/servers/${serverId}`);
		assert(view.config.idleTimeoutMin === 60, "idle timeout saved", view.config);
		assert(view.status.connection === "connected", "still connected", view.status);
		await page.reload();
		await waitUntil("saved value after reload", async () => (await page.getByLabel("空闲回收").inputValue()) === "60", { timeoutMs: 10_000 });
		await shot("server-settings-saved");
	});

	// ---------------------------------------------------------------- offline + reconnect
	const S7 = "reconnect";
	const offlineNoise = [/→ 409$/, /→ 503$/, /status of (409|503)/];

	await uiStep(
		S7,
		"断开连接: the chat shows the offline state with a connect button",
		async () => {
			await page.goto(`${base}/servers/${serverId}`);
			await page.getByRole("heading", { name: "运行环境" }).waitFor();
			await page.getByRole("button", { name: "断开连接" }).click();
			await page.getByRole("main").getByText("离线", { exact: true }).first().waitFor({ timeout: 15_000 });
			await sidebar().getByText("离线", { exact: true }).waitFor();
			// The cached session list stays visible while the server is away.
			await sidebar().getByRole("link", { name: /你好/ }).first().click();
			await page.waitForURL(new RegExp(`/w/${workspaceId}/chat/${sessionId}$`));
			await page.getByRole("heading", { name: "服务器未连接" }).waitFor({ timeout: 15_000 });
			await shot("chat-offline");
		},
		{ allow: offlineNoise },
	);

	await uiStep(
		S7,
		"连接服务器 → the conversation history comes back",
		async () => {
			await page.getByRole("button", { name: "连接服务器" }).click();
			await messages().getByText("工具执行完成：ui-e2e").waitFor({ timeout: 30_000 });
			await messages().getByText("收到：你好").waitFor();
			await sidebar().getByText(/^在线 · \d+ms$/).waitFor({ timeout: 15_000 });
			await composer().fill("重连之后");
			await composer().press("Enter");
			await messages().getByText("收到：重连之后").waitFor({ timeout: 60_000 });
			await shot("chat-reconnected");
		},
		{ allow: offlineNoise },
	);

	// ---------------------------------------------------------------- diagnostics
	if (runner.failed) {
		console.log("\n---- pi-web output (tail) ----");
		console.log(tailFile(serverLogFile, 60));
		if (tmp) console.log(`\n(temp dir: ${tmp}${process.env.E2E_KEEP === "1" ? "" : " — set E2E_KEEP=1 to keep it"})`);
	}
	if (screenshots.length) console.log(`\nscreenshots (${screenshots.length}) in ${path.relative(ROOT, SHOTS)}/:\n  ${screenshots.map((s) => path.basename(s)).join("\n  ")}`);
	await browser?.close().catch(() => {});
	if (process.env.E2E_HOLD === "1" && base) {
		// Debugging aid: keep pi-web, sshd and the mock LLM running until Ctrl+C.
		info(`E2E_HOLD: environment kept at ${base} (server ${serverId}, workspace ${workspaceId}, key ${fixture?.keyPath}) — Ctrl+C to stop`);
		await new Promise(() => {});
	}
}

let exitCode = 0;
try {
	await main();
} catch (err) {
	console.error(`unexpected error: ${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await cleanup();
	await sleep(0);
}

exitCode = Math.max(exitCode, runner.summary("Pi-Web UI E2E summary"));
console.log(exitCode === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(exitCode);
