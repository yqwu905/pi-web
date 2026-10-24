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

	await uiStep(S3, 'send "run: echo ui-e2e" → collapsed bash tool card; expanding it shows the output', async () => {
		await composer().fill("run: echo ui-e2e");
		await composer().press("Enter");
		await messages().getByText("工具执行完成：ui-e2e").waitFor({ timeout: 60_000 });
		const card = messages().getByRole("group", { name: "工具 bash echo ui-e2e" });
		await card.getByText(/退出码 0/).waitFor();
		const toggle = card.locator("button[aria-expanded]").first();
		assert((await toggle.getAttribute("aria-expanded")) === "false", "tool cards start collapsed");
		assert((await card.locator("pre").count()) === 0, "a collapsed card renders no output");
		await shot("chat-bash-tool-collapsed");
		await toggle.click();
		assert((await toggle.getAttribute("aria-expanded")) === "true", "the card expands");
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

	// ---------------------------------------------------------------- extension dialogs
	const S3b = "extension dialogs";
	const QUESTION = "你更喜欢哪种语言？";
	const questionDialog = () => page.getByRole("dialog", { name: QUESTION });
	const notUsedToast = () => page.getByText("扩展没有请求文字输入");
	/** Runs /e2e-question (or `command`) and waits for its select; resolves once the dialog accepts answers (400 ms arm delay). */
	async function askQuestion(command = "/e2e-question", name = QUESTION) {
		await composer().fill(command);
		await composer().press("Enter");
		await page.getByRole("dialog", { name }).getByRole("group", { name }).waitFor({ timeout: 20_000 });
		const shownAt = Date.now();
		return () => sleep(Math.max(0, shownAt + 500 - Date.now()));
	}
	/** Records whether the extension's own input dialog (placeholder "输入语言", or `selector`) is ever added to the page. */
	const watchInputDialog = (selector = 'input[placeholder="输入语言"]') =>
		page.evaluate((selector) => {
			window.__inputDialogSeen = false;
			window.__inputDialogObserver?.disconnect();
			const seen = (node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null);
			window.__inputDialogObserver = new MutationObserver((records) => {
				if (records.some((r) => [...r.addedNodes].some(seen))) window.__inputDialogSeen = true;
			});
			window.__inputDialogObserver.observe(document.body, { childList: true, subtree: true });
		}, selector);
	const inputDialogSeen = () => page.evaluate(() => window.__inputDialogSeen);

	await uiStep(S3b, 'select with "Type something.": typing in the option list answers with the text in one step', async () => {
		const armed = await askQuestion();
		const dialog = questionDialog();
		const group = dialog.getByRole("group", { name: QUESTION });
		await group.getByRole("button", { name: "Rust", pressed: true }).waitFor();
		await dialog.getByText("直接输入可自定义回答").waitFor();
		await waitUntil("focus on the option list", () => page.evaluate(() => document.activeElement?.getAttribute("aria-pressed") === "true"), { timeoutMs: 5000 });
		// Keys right after the dialog opened are ignored (typed for the composer).
		await armed();
		// No click on the option: the typed text moves to the inline field under "Type something.".
		await page.keyboard.type("Zig");
		const field = dialog.getByLabel("自定义回答");
		await field.waitFor();
		assert((await field.inputValue()) === "Zig", "the typed text is in the inline field", await field.inputValue());
		assert(await field.evaluate((el) => el === document.activeElement), "the inline field has the focus");
		await group.getByRole("button", { name: "Type something.", pressed: true }).waitFor();
		const description = await field.evaluate((el) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent);
		assert(description === "Type something.", "the inline field is described by its option", description);
		await shot("extension-select-free-text");
		await watchInputDialog();
		await page.keyboard.press("Enter");
		await page.getByText("回答：Zig").waitFor({ timeout: 15_000 });
		await dialog.waitFor({ state: "detached" });
		assert((await page.getByRole("dialog").count()) === 0, "no input dialog remains");
		assert(!(await inputDialogSeen()), "the extension's input dialog was answered without being shown");
		assert((await notUsedToast().count()) === 0, "the typed text was used");
	});

	await uiStep(S3b, 'select: picking "Go" answers as before', async () => {
		const armed = await askQuestion();
		const dialog = questionDialog();
		await dialog.getByRole("group", { name: QUESTION }).getByRole("button", { name: "Go" }).click();
		assert((await dialog.getByLabel("自定义回答").count()) === 0, "no inline field for a regular option");
		await armed();
		await dialog.getByRole("button", { name: "确定" }).click();
		await page.getByText("回答：Go").waitFor({ timeout: 15_000 });
		await dialog.waitFor({ state: "detached" });
		assert((await page.getByRole("dialog").count()) === 0, "no dialog remains");
	});

	await uiStep(S3b, 'select: clicking "Type something." focuses the inline field; empty Enter shows the extension\'s own input', async () => {
		const armed = await askQuestion();
		const dialog = questionDialog();
		await dialog.getByRole("group", { name: QUESTION }).getByRole("button", { name: "Type something." }).click();
		const field = dialog.getByLabel("自定义回答");
		await waitUntil("inline field focused", () => field.evaluate((el) => el === document.activeElement), { timeoutMs: 5000 });
		await armed();
		await field.press("Enter");
		const input = dialog.getByPlaceholder("输入语言");
		await input.waitFor({ timeout: 15_000 });
		await sleep(500);
		await input.fill("Kotlin");
		await input.press("Enter");
		await page.getByText("回答：Kotlin").waitFor({ timeout: 15_000 });
		await dialog.waitFor({ state: "detached" });
		assert((await notUsedToast().count()) === 0, "no dropped-text toast");
	});

	await uiStep(S3b, "select: the rest of a message typed into the composer when it opens is ignored", async () => {
		await composer().fill("/e2e-question");
		await composer().press("Enter");
		// Keep typing (spaces included) as if writing a message: the question opens in the middle of it.
		const group = questionDialog().getByRole("group", { name: QUESTION });
		const text = "please use rust ";
		let openedAt = 0;
		for (let i = 0, end = Date.now() + 20_000; Date.now() < end; i++) {
			await page.keyboard.type(text[i % text.length]);
			await sleep(60);
			if (!openedAt && (await group.count()) > 0) openedAt = Date.now();
			if (openedAt && Date.now() - openedAt > 1200) break;
		}
		assert(openedAt, "the question opened");
		const dialog = questionDialog();
		assert((await dialog.getByLabel("自定义回答").count()) === 0, "no free-text answer was started");
		await group.getByRole("button", { name: "Rust", pressed: true }).waitFor();
		assert(await page.evaluate(() => document.activeElement?.getAttribute("aria-pressed") === "true"), "focus stays on the option list");
		await dialog.getByRole("button", { name: "取消" }).click();
		await dialog.waitFor({ state: "detached" });
		await page.getByText("回答：undefined").waitFor({ timeout: 15_000 });
		await composer().fill("");
	});

	await uiStep(
		S3b,
		"select: a failed answer brings the question back with the typed text",
		async () => {
			const armed = await askQuestion();
			const dialog = questionDialog();
			await waitUntil("focus on the option list", () => page.evaluate(() => document.activeElement?.getAttribute("aria-pressed") === "true"), { timeoutMs: 5000 });
			await armed();
			const route = "**/api/conversations/*/ui-response";
			let failed = 0;
			await page.route(route, (r) => {
				failed++;
				return r.abort("failed");
			});
			try {
				await page.keyboard.type("Nim");
				await dialog.getByLabel("自定义回答").waitFor();
				await page.keyboard.press("Enter");
				await page.getByText("无法提交回复").first().waitFor({ timeout: 10_000 });
			} finally {
				await page.unroute(route);
			}
			assert(failed === 1, "one answer failed", failed);
			const field = dialog.getByLabel("自定义回答");
			await field.waitFor();
			assert((await field.inputValue()) === "Nim", "the question is back with the typed text", await field.inputValue());
			await dialog.getByRole("group", { name: QUESTION }).getByRole("button", { name: "Type something.", pressed: true }).waitFor();
			await waitUntil("inline field focused", () => field.evaluate((el) => el === document.activeElement), { timeoutMs: 5000 });
			await sleep(500);
			await field.press("Enter");
			await page.getByText("回答：Nim").waitFor({ timeout: 15_000 });
			await dialog.waitFor({ state: "detached" });
			assert((await page.getByRole("dialog").count()) === 0, "no input dialog remains");
		},
		{ allow: [/ui-response/, /ERR_FAILED/] },
	);

	await uiStep(S3b, "select: typed text is dropped with a notice when the extension asks for something else", async () => {
		const OTHER = "下一步做什么？";
		await composer().fill("/e2e-other");
		await composer().press("Enter");
		const dialog = page.getByRole("dialog", { name: OTHER });
		await dialog.getByRole("group", { name: OTHER }).waitFor({ timeout: 20_000 });
		const shownAt = Date.now();
		await waitUntil("focus on the option list", () => page.evaluate(() => document.activeElement?.getAttribute("aria-pressed") === "true"), { timeoutMs: 5000 });
		await sleep(Math.max(0, shownAt + 500 - Date.now()));
		await page.keyboard.type("hello");
		const field = dialog.getByLabel("自定义回答");
		await field.waitFor();
		assert((await field.inputValue()) === "hello", "the typed text is in the inline field", await field.inputValue());
		await page.keyboard.press("Enter");
		// The extension's follow-up is a confirm: it is shown, not answered with the text.
		const confirm = page.getByRole("alertdialog", { name: "E2E 其他" });
		await confirm.waitFor({ timeout: 15_000 });
		await notUsedToast().filter({ hasText: "“hello”" }).waitFor({ timeout: 5000 });
		await shot("extension-free-text-dropped");
		await sleep(500);
		await confirm.getByRole("button", { name: "允许" }).click();
		await page.getByText("下一步：Other true").waitFor({ timeout: 15_000 });
		await confirm.waitFor({ state: "detached" });
	});

	const RPIV_QUESTION = "[运行时] 选哪个运行时？";
	const rpivDialog = () => page.getByRole("dialog", { name: RPIV_QUESTION });
	/** innerText of what describes the dialog (the title lines after the first). */
	const dialogDetail = async (dialog) => page.locator(`[id="${await dialog.getAttribute("aria-describedby")}"]`).innerText();

	await uiStep(S3b, 'rpiv-ask-user-question: multi-line title, typing answers with "3. 输入内容" in one step', async () => {
		const armed = await askQuestion("/e2e-rpiv", RPIV_QUESTION);
		const dialog = rpivDialog();
		const group = dialog.getByRole("group", { name: RPIV_QUESTION });
		await group.getByRole("button", { name: "1. Rust — 系统编程", pressed: true }).waitFor();
		// The preview folded into the title is shown under the heading with its line breaks and indentation.
		const detail = await dialogDetail(dialog);
		assert(detail === '--- 1. Rust preview ---\nfn main() {\n    println!("hi");\n}', "title lines after the first shown as is", detail);
		await dialog.getByText("直接输入可自定义回答").waitFor();
		await waitUntil("focus on the option list", () => page.evaluate(() => document.activeElement?.getAttribute("aria-pressed") === "true"), { timeoutMs: 5000 });
		await armed();
		await page.keyboard.type("Odin");
		const field = dialog.getByLabel("自定义回答");
		await field.waitFor();
		assert((await field.inputValue()) === "Odin", "the typed text is in the inline field", await field.inputValue());
		await group.getByRole("button", { name: "3. 输入内容", pressed: true }).waitFor();
		await shot("extension-rpiv-question");
		await watchInputDialog(`input[aria-label="${RPIV_QUESTION}"]`);
		await page.keyboard.press("Enter");
		await page.getByText("rpiv 回答：Odin").waitFor({ timeout: 15_000 });
		await dialog.waitFor({ state: "detached" });
		assert((await page.getByRole("dialog").count()) === 0, "no input dialog remains");
		assert(!(await inputDialogSeen()), "rpiv's input dialog was answered without being shown");
		// The previous step's notice may still be shown.
		assert((await notUsedToast().filter({ hasText: "“Odin”" }).count()) === 0, "the typed text was used");
	});

	await uiStep(S3b, 'rpiv-ask-user-question: empty Enter on "3. 输入内容" shows its input with the options in the title', async () => {
		const armed = await askQuestion("/e2e-rpiv", RPIV_QUESTION);
		const dialog = rpivDialog();
		await dialog.getByRole("group", { name: RPIV_QUESTION }).getByRole("button", { name: "3. 输入内容" }).click();
		const field = dialog.getByLabel("自定义回答");
		await waitUntil("inline field focused", () => field.evaluate((el) => el === document.activeElement), { timeoutMs: 5000 });
		await armed();
		await field.press("Enter");
		const input = dialog.getByRole("textbox", { name: RPIV_QUESTION });
		await input.waitFor({ timeout: 15_000 });
		const detail = await dialogDetail(dialog);
		assert(detail === "1. Rust — 系统编程\n2. Go — 云原生\n\n输入你的回答：", "the options and the prompt are shown one per line", detail);
		await shot("extension-rpiv-input");
		await sleep(500);
		await input.fill("Elixir");
		await input.press("Enter");
		await page.getByText("rpiv 回答：Elixir").waitFor({ timeout: 15_000 });
		await dialog.waitFor({ state: "detached" });
	});

	// ---------------------------------------------------------------- throughput, tool cards, rpiv-todo
	const S3c = "throughput+todos";
	const todoPanel = () => page.getByRole("group", { name: "任务清单" });
	const todoHeader = () => todoPanel().locator("button[aria-controls]").first();
	const todoRows = () => todoPanel().locator("li");
	const toolReplies = () => messages().getByText(/^工具执行完成：/);
	/** Sends a todo tool call through the mock LLM and waits for the reply that follows the tool. */
	async function sendTodo(args) {
		const before = await toolReplies().count();
		await composer().fill(`todo: ${JSON.stringify(args)}`);
		await composer().press("Enter");
		await waitUntil("reply after the todo tool", async () => (await toolReplies().count()) > before, { timeoutMs: 60_000 });
		await waitUntil("composer ready", async () => (await composer().inputValue()) === "", { timeoutMs: 5000 });
	}

	await uiStep(S3c, "throughput: a reply ends with its output rate; the info panel shows the average", async () => {
		// The mock streams 3 characters every 15 ms: about 20 chunks, so the rate is measured over the output phase.
		const prompt = `速率测试 ${"一二三四五六七八九十".repeat(6)}`;
		await composer().fill(prompt);
		await composer().press("Enter");
		await messages().getByText(`收到：${prompt}`).waitFor({ timeout: 60_000 });
		const line = messages().getByText(/tok\/s · 7 tokens/).last();
		await line.waitFor({ timeout: 10_000 });
		const text = (await line.innerText()).trim();
		assert(/^\d+(\.\d)? tok\/s · 7 tokens · 首字 [\d.]+s$/.test(text), "rate of the output phase, with the time to first token", text);
		assert((await line.getAttribute("title"))?.includes("不含首字延迟"), "the tooltip explains the basis", await line.getAttribute("title"));
		await waitUntil("info panel rate", async () => /生成速率\s+≈? ?\d+(\.\d)? tok\/s/.test(await infoPanel().innerText()), { timeoutMs: 10_000 });
		assert(/首字延迟\s+[\d.]+s/.test(await infoPanel().innerText()), "info panel time to first token", await infoPanel().innerText());
		await shot("chat-throughput");
	});

	await uiStep(S3c, "tool cards: expand-all / collapse-all applies to every card and is remembered", async () => {
		const card = messages().getByRole("group", { name: "工具 bash echo ui-e2e" });
		const toggle = card.locator("button[aria-expanded]").first();
		if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
		assert((await toggle.getAttribute("aria-expanded")) === "false", "collapsed by hand");
		await page.getByRole("button", { name: "展开全部工具调用" }).click();
		await page.getByRole("button", { name: "折叠全部工具调用" }).waitFor();
		assert((await toggle.getAttribute("aria-expanded")) === "true", "expand-all overrides the card's own choice");
		await card.locator("pre").first().waitFor();
		const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("pi-web:ui") ?? "{}").state?.toolsExpanded);
		assert((await stored()) === true, "the preference is stored", await stored());
		await shot("chat-tools-expanded");
		await page.getByRole("button", { name: "折叠全部工具调用" }).click();
		await page.getByRole("button", { name: "展开全部工具调用" }).waitFor();
		assert((await toggle.getAttribute("aria-expanded")) === "false", "collapse-all collapses the card");
		assert((await stored()) === false, "the preference is stored", await stored());
	});

	await uiStep(S3c, "rpiv-todo: creating tasks shows the task list above the composer", async () => {
		await sendTodo({ action: "create", tasks: [{ subject: "调研现有实现" }, { subject: "编写测试" }, { subject: "更新文档" }] });
		await todoPanel().waitFor({ timeout: 15_000 });
		await waitUntil("three tasks", async () => (await todoRows().count()) === 3, { timeoutMs: 10_000 });
		const rows = await todoRows().allInnerTexts();
		assert(rows.map((r) => r.replace(/\s+/g, "")).join("|") === "○待处理：调研现有实现|○待处理：编写测试|○待处理：更新文档", "rows", rows);
		assert((await todoHeader().innerText()).includes("0/3"), "progress in the header", await todoHeader().innerText());
		// The tool card header summarizes the call instead of showing raw JSON.
		await messages().getByRole("group", { name: "工具 todo 3 项任务" }).waitFor();
		await shot("chat-todo-created");
	});

	await uiStep(S3c, "rpiv-todo: progress, and the task in progress in the collapsed header", async () => {
		await sendTodo({ action: "update", id: 1, status: "in_progress", activeForm: "调研中" });
		await waitUntil("task 1 in progress", async () => (await todoRows().first().innerText()).includes("(调研中)"), { timeoutMs: 10_000 });
		await messages().getByRole("group", { name: "工具 todo #1 → 进行中" }).waitFor();
		await todoHeader().click();
		assert((await todoHeader().getAttribute("aria-expanded")) === "false", "the panel collapses");
		await todoPanel().getByText("进行中：调研中").waitFor();
		await shot("chat-todo-collapsed");
		await todoHeader().click();
		await sendTodo({ action: "update", id: 1, status: "completed" });
		await waitUntil("1/3 completed", async () => (await todoHeader().innerText()).includes("1/3"), { timeoutMs: 10_000 });
		assert((await todoRows().first().innerText()).includes("已完成"), "task 1 completed", await todoRows().first().innerText());
	});

	await uiStep(S3c, "rpiv-todo: tasks completed before the latest prompt are folded away, also after a reload", async () => {
		await composer().fill("继续下一项");
		await composer().press("Enter");
		await messages().getByText("收到：继续下一项").waitFor({ timeout: 60_000 });
		await waitUntil("task 1 folded away", async () => (await todoRows().count()) === 2, { timeoutMs: 10_000 });
		assert((await todoHeader().innerText()).includes("0/2"), "progress over the shown tasks", await todoHeader().innerText());
		await todoPanel().getByRole("button", { name: "显示此前已完成的 1 项" }).click();
		await waitUntil("all three shown", async () => (await todoRows().count()) === 3, { timeoutMs: 5000 });
		await shot("chat-todo-earlier-shown");
		await todoPanel().getByRole("button", { name: "隐藏此前已完成的 1 项" }).click();
		await page.reload();
		await messages().getByText("收到：继续下一项").waitFor({ timeout: 30_000 });
		await waitUntil("task list after the reload", async () => (await todoPanel().count()) === 1 && (await todoHeader().innerText()).includes("0/2"), {
			timeoutMs: 15_000,
		});
		assert((await todoRows().count()) === 2, "same rows after the reload", await todoRows().allInnerTexts());
	});

	// ---------------------------------------------------------------- archive
	const S3a = "archive";
	const archivedToggle = () => sidebar().getByRole("button", { name: /^已归档（\d+）$/ });
	const archivedGroup = () => sidebar().getByRole("group", { name: "已归档的会话" });
	/** Opacity of an element times its ancestors' (what is actually seen). */
	const seenOpacity = (locator) =>
		locator.evaluate((el) => {
			let opacity = 1;
			for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
			return opacity;
		});
	const focused = () =>
		page.evaluate(() => ({
			tag: document.activeElement?.tagName ?? null,
			label: document.activeElement?.getAttribute("aria-label") ?? null,
			archivedToggle: document.activeElement?.hasAttribute("data-archived-toggle") ?? false,
			sessionFile: document.activeElement?.getAttribute("data-session-file") ?? null,
		}));

	await uiStep(S3a, "归档 from the sidebar: the session leaves the list for the collapsed 已归档 group", async () => {
		// From another page, so the archived session is not the open one.
		await page.getByRole("navigation", { name: "位置" }).getByRole("link", { name: SERVER_NAME, exact: true }).click();
		await page.waitForURL(new RegExp(`/servers/${serverId}$`));
		const row = sidebar().getByRole("link", { name: /你好/ }).first();
		const archive = sidebar().getByRole("button", { name: "归档会话 你好" });
		await archive.waitFor({ state: "attached" });
		// At rest the row actions are hidden, a disabled one too (while the session runs it must not
		// cover the title or the 未读 badge with a faded icon).
		const viewport = page.viewportSize();
		await page.mouse.move(viewport.width - 20, viewport.height - 20);
		assert((await seenOpacity(archive)) === 0, "archive button hidden at rest", await seenOpacity(archive));
		await archive.evaluate((el) => el.setAttribute("disabled", ""));
		assert((await seenOpacity(archive)) === 0, "a disabled archive button stays hidden at rest", await seenOpacity(archive));
		await row.hover();
		assert((await seenOpacity(archive)) === 0.5, "a disabled archive button shows faded on hover", await seenOpacity(archive));
		await archive.evaluate((el) => el.removeAttribute("disabled"));
		await archive.waitFor();
		await shot("sidebar-archive-button");
		await archive.click();
		await page.getByText("会话已归档，可在“已归档”中找回").waitFor();
		await waitUntil("session left the active list", async () => (await sidebar().getByRole("link", { name: /你好/ }).count()) === 0, { timeoutMs: 10_000 });
		assert((await archivedToggle().innerText()).trim() === "已归档（1）", "已归档 group with one session", await archivedToggle().innerText());
		assert((await archivedToggle().getAttribute("aria-expanded")) === "false", "the group starts collapsed");
		const { sessions } = await api.get(`/workspaces/${workspaceId}/sessions`);
		assert(sessions.length === 1 && typeof sessions[0].archivedAt === "number", "the host marks the session archived", sessions);
		await shot("sidebar-archived");
	});

	await uiStep(S3a, "已归档: open the archived session read-only with the 此会话已归档 banner", async () => {
		await archivedToggle().click();
		const row = archivedGroup().getByRole("link", { name: /你好/ });
		await row.getByText(/^归档于 /).waitFor();
		await archivedGroup().getByRole("button", { name: "恢复会话 你好" }).waitFor();
		await archivedGroup().getByRole("button", { name: "删除会话 你好" }).waitFor();
		await row.click();
		await page.waitForURL(new RegExp(`/w/${workspaceId}/chat/${sessionId}$`));
		await page.getByText("此会话已归档", { exact: true }).waitFor();
		await messages().getByText("收到：你好").waitFor({ timeout: 30_000 });
		await infoPanel().getByRole("button", { name: "恢复会话" }).waitFor();
		// Without a pi process the task list is replayed from the session file.
		await waitUntil("task list from the session file", async () => (await todoPanel().count()) === 1 && (await todoHeader().innerText()).includes("0/2"), {
			timeoutMs: 10_000,
		});
		await shot("chat-archived");
		// The tree mounts again on the open archived session (as the mobile drawer does): the group is open.
		await sidebar().getByRole("button", { name: `收起 ${SERVER_NAME}` }).click();
		await sidebar().getByRole("button", { name: `展开 ${SERVER_NAME}` }).click();
		await archivedGroup().getByRole("link", { name: /你好/ }).waitFor();
		assert((await archivedToggle().getAttribute("aria-expanded")) === "true", "已归档 group open on the archived session after a remount");
	});

	await uiStep(S3a, "sending in the archived session restores it first, then the reply arrives", async () => {
		await composer().fill("归档后继续");
		await composer().press("Enter");
		await messages().getByText("收到：归档后继续").waitFor({ timeout: 60_000 });
		await page.getByText("此会话已归档", { exact: true }).waitFor({ state: "detached", timeout: 10_000 });
		await sidebar().getByRole("link", { name: /你好/ }).first().waitFor();
		await waitUntil("已归档 group gone", async () => (await archivedToggle().count()) === 0, { timeoutMs: 10_000 });
		await infoPanel().getByRole("button", { name: "归档会话" }).waitFor();
		const { sessions } = await api.get(`/workspaces/${workspaceId}/sessions`);
		assert(sessions.every((s) => s.archivedAt === undefined), "the host no longer marks the session", sessions);
		await shot("chat-unarchived");
	});

	await uiStep(S3a, "keyboard: archive and restore from the sidebar keep the focus; 已归档 comes back collapsed", async () => {
		await page.getByRole("navigation", { name: "位置" }).getByRole("link", { name: SERVER_NAME, exact: true }).click();
		await page.waitForURL(new RegExp(`/servers/${serverId}$`));
		const { sessions } = await api.get(`/workspaces/${workspaceId}/sessions`);
		const file = sessions[0]?.file;
		const archive = sidebar().getByRole("button", { name: "归档会话 你好" });
		await archive.focus();
		await page.keyboard.press("Enter");
		await archivedToggle().waitFor();
		// The group was expanded before its last session was restored; it reappears collapsed.
		assert((await archivedToggle().getAttribute("aria-expanded")) === "false", "已归档 group collapsed again");
		await waitUntil("focus on the 已归档 toggle (the focused row left the list)", async () => (await focused()).archivedToggle, { timeoutMs: 5000 }).catch(
			async (err) => {
				throw new Error(`${err.message}; focused: ${JSON.stringify(await focused())}`);
			},
		);
		await page.keyboard.press("Enter");
		const restore = archivedGroup().getByRole("button", { name: "恢复会话 你好" });
		await restore.focus();
		await page.keyboard.press("Enter");
		await waitUntil("已归档 group gone", async () => (await archivedToggle().count()) === 0, { timeoutMs: 10_000 });
		await waitUntil("focus on the restored row", async () => ((await focused()).sessionFile === file ? true : null), { timeoutMs: 5000 });
		const row = sidebar().getByRole("link", { name: /你好/ }).first();
		await row.click();
		await page.waitForURL(new RegExp(`/w/${workspaceId}/chat/${sessionId}$`));
		await infoPanel().getByRole("button", { name: "归档会话" }).waitFor();
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

	await uiStep(S6, "server settings: change 空闲回收, add a server-level env variable, save", async () => {
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

		// 环境变量: add a variable (a Pi-Web managed name is refused first), save, reload.
		const envValue = "hello 'ui' $HOME";
		const multiValue = "line 1\nline 2";
		const focusedLabel = () => page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.getAttribute("aria-label")}`);
		const envNav = page.getByRole("navigation", { name: "设置分区" }).getByRole("link", { name: /环境变量/ });
		const envSection = page.getByRole("region", { name: "环境变量" });
		// The short section cannot reach the top of the page: the clicked entry stays current once the scroll settles.
		const showEnvSection = async () => {
			await envNav.click();
			await envSection.getByText("工作区中设置的同名变量优先").waitFor();
			let lastTop = NaN;
			await waitUntil(
				"scroll settled",
				async () => {
					const top = await envSection.evaluate((el) => Math.round(el.getBoundingClientRect().top));
					const settled = top === lastTop;
					lastTop = top;
					return settled;
				},
				{ timeoutMs: 5000, intervalMs: 300 },
			);
			assert((await envNav.getAttribute("aria-current")) === "location", "nav keeps 环境变量 current after the click", await envNav.getAttribute("aria-current"));
		};
		await showEnvSection();
		await envSection.getByRole("button", { name: "添加变量" }).click();
		await waitUntil("new row's name field focused", async () => (await focusedLabel()) === "INPUT:第 1 个变量名", { timeoutMs: 3000 });
		await page.keyboard.type("https_proxy");
		await envSection.getByLabel("第 1 个变量值").fill(envValue);
		await page.getByText("有 1 项未保存的更改").waitFor();
		await page.getByRole("button", { name: "保存更改" }).click();
		await envSection.getByText("https_proxy 由 Pi-Web 管理，请在服务器设置的“LLM 代理”中配置").waitFor({ timeout: 5000 });
		const invalid = async () => [await envSection.getByLabel("第 1 个变量名").getAttribute("aria-invalid"), await envSection.getByLabel("第 1 个变量值").getAttribute("aria-invalid")].join(",");
		assert((await invalid()) === "true,", "a name error marks the name field", await invalid());
		await envSection.getByLabel("第 1 个变量名").fill("UI_E2E_VAR");
		await envSection.getByLabel("第 1 个变量值").fill("x".repeat(33 * 1024));
		await envSection.getByText("变量值不能超过 32 KiB").waitFor({ timeout: 5000 });
		assert((await invalid()) === ",true", "a value error marks the value field", await invalid());
		await envSection.getByLabel("第 1 个变量值").fill(envValue);
		// A multi-line paste keeps its line breaks: the value field becomes a textarea and keeps the focus.
		await envSection.getByRole("button", { name: "添加变量" }).click();
		await page.keyboard.type("UI_E2E_MULTI");
		await envSection.getByLabel("第 2 个变量值").evaluate((el, text) => {
			el.focus();
			const data = new DataTransfer();
			data.setData("text/plain", text);
			el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
		}, "line 1\r\nline 2");
		await waitUntil("multi-line value in a focused textarea", async () => (await focusedLabel()) === "TEXTAREA:第 2 个变量值", { timeoutMs: 3000 });
		assert((await envSection.getByLabel("第 2 个变量值").inputValue()) === multiValue, "pasted line breaks kept", await envSection.getByLabel("第 2 个变量值").inputValue());
		await showEnvSection();
		await shot("server-settings-env");
		await page.getByRole("button", { name: "保存更改" }).click();
		await page.getByText("所有更改已保存").waitFor({ timeout: 15_000 });
		const saved = await api.get(`/servers/${serverId}`);
		assert(saved.config.env?.UI_E2E_VAR === envValue && saved.config.env?.UI_E2E_MULTI === multiValue, "server env saved", saved.config.env);
		const remote = runAsTestUser(`. ~/.pi-web/run/env.sh; printf '%s|%s' "$UI_E2E_VAR" "$UI_E2E_MULTI"`).stdout;
		assert(remote === `${envValue}|${multiValue}`, "run/env.sh on the server carries the variables", remote);
		await page.reload();
		await waitUntil(
			"saved env variables after reload",
			async () =>
				(await envSection.getByLabel("第 1 个变量名").inputValue().catch(() => "")) === "UI_E2E_VAR" &&
				(await envSection.getByLabel("第 1 个变量值").inputValue()) === envValue &&
				(await envSection.getByLabel("第 2 个变量值").inputValue().catch(() => "")) === multiValue,
			{ timeoutMs: 10_000 },
		);
		await page.getByText("所有更改已保存").waitFor();
		// Removing a row with the keyboard moves the focus to the remaining row instead of <body>.
		await envSection.getByRole("button", { name: "删除变量 UI_E2E_MULTI" }).focus();
		await page.keyboard.press("Enter");
		await waitUntil("focus moved to the remaining row", async () => (await focusedLabel()) === "INPUT:第 1 个变量名", { timeoutMs: 3000 });
		await page.getByRole("button", { name: "保存更改" }).click();
		await page.getByText("所有更改已保存").waitFor({ timeout: 15_000 });
		const pruned = await api.get(`/servers/${serverId}`);
		assert(JSON.stringify(pruned.config.env) === JSON.stringify({ UI_E2E_VAR: envValue }), "removed variable saved", pruned.config.env);
		await showEnvSection();
		await shot("server-settings-env-saved");
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
