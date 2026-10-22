/**
 * Shared environment for the Pi-Web end-to-end tests (e2e/api-e2e.mjs, e2e/ui-e2e.mjs):
 * step runner + reporting, child processes, and the test environment itself — a temp host
 * agent dir (models/settings/extension/skill/prompt/auth), the mock LLM on mock-llm.test,
 * the sshd fixture (pitest@127.0.0.1:2222) and the built pi-web CLI with a seeded bundle cache.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import WebSocket from "ws";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI = path.join(ROOT, "packages/server/dist/cli.mjs");
export const MOCK_LLM = path.join(ROOT, "e2e/mock-llm.mjs");
export const SSHD_FIXTURE = path.join(ROOT, "packages/server/test/ssh/fixtures/sshd.ts");
export const CACHE_SEED = "/tmp/pi-web-test-cache/cache";
export const MOCK_HOST = "mock-llm.test";
export const MOCK_IP = "127.0.0.2";
export const MOCK_PORT = 18080;
export const VERBOSE = process.env.E2E_VERBOSE === "1";
export const KEEP = process.env.E2E_KEEP === "1";

// ------------------------------------------------------------------ logging / assertions

export function ts() {
	return new Date().toISOString().slice(11, 23);
}
export function info(msg) {
	console.log(`[${ts()}] ${msg}`);
}
export function debug(msg) {
	if (VERBOSE) console.log(`[${ts()}]   · ${msg}`);
}

export class AssertionError extends Error {}

export function assert(cond, message, details) {
	if (!cond) {
		const extra = details === undefined ? "" : `\n      ${typeof details === "string" ? details : JSON.stringify(details).slice(0, 2000)}`;
		throw new AssertionError(`${message}${extra}`);
	}
}

/**
 * Step runner: a failing step skips the rest of its section; a failing critical step
 * (setup, deploy) skips everything after it.
 */
export class Runner {
	constructor() {
		this.results = [];
		this.failedSections = new Set();
		this.fatal = false;
		/** Called once right after the first failure (e.g. to collect remote diagnostics). */
		this.onFirstFailure = async () => {};
		this.firstFailureHandled = false;
	}

	async step(section, name, fn, { critical = false } = {}) {
		const label = `${section} › ${name}`;
		if (this.fatal || this.failedSections.has(section)) {
			this.results.push({ label, status: "SKIP" });
			info(`SKIP  ${label}`);
			return undefined;
		}
		const started = Date.now();
		info(`RUN   ${label}`);
		try {
			const value = await fn();
			const ms = Date.now() - started;
			this.results.push({ label, status: "PASS", ms });
			info(`PASS  ${label} (${ms} ms)`);
			return value;
		} catch (err) {
			const ms = Date.now() - started;
			const message = err instanceof Error ? (err instanceof AssertionError ? err.message : (err.stack ?? err.message)) : String(err);
			this.results.push({ label, status: "FAIL", ms, error: message });
			info(`FAIL  ${label} (${ms} ms)\n      ${message}`);
			this.failedSections.add(section);
			if (critical) this.fatal = true;
			if (!this.firstFailureHandled) {
				this.firstFailureHandled = true;
				try {
					await this.onFirstFailure(label);
				} catch (e) {
					info(`(first-failure hook failed: ${e.message})`);
				}
			}
			return undefined;
		}
	}

	get failed() {
		return this.results.some((r) => r.status === "FAIL");
	}

	/** Prints the summary and returns the process exit code. */
	summary(title) {
		const pass = this.results.filter((r) => r.status === "PASS").length;
		const fail = this.results.filter((r) => r.status === "FAIL").length;
		const skip = this.results.filter((r) => r.status === "SKIP").length;
		console.log(`\n================ ${title} ================`);
		for (const r of this.results) console.log(`${r.status.padEnd(4)}  ${r.label}${r.ms !== undefined ? `  (${r.ms} ms)` : ""}`);
		console.log(`--------------------------------------------------------\n${pass} passed, ${fail} failed, ${skip} skipped`);
		return fail > 0 || skip > 0 || this.results.length === 0 ? 1 : 0;
	}
}

// ------------------------------------------------------------------ helpers

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(what, fn, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	for (;;) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (err) {
			last = err;
		}
		if (Date.now() > deadline) {
			throw new AssertionError(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${last.message}` : ""}`);
		}
		await sleep(intervalMs);
	}
}

export function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

export function portOpen(host, port) {
	return new Promise((resolve) => {
		const socket = net.connect(port, host);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

export function tailFile(file, lines = 60) {
	try {
		return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
	} catch {
		return "(unavailable)";
	}
}

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text")
		.map((c) => c.text)
		.join("");
}

/** Extends a comma separated NO_PROXY list. */
export function extendNoProxy(current, extra) {
	const items = (current ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	for (const e of extra) if (!items.includes(e)) items.push(e);
	return items.join(",");
}

// ------------------------------------------------------------------ child processes + cleanup

const children = [];
const cleanups = [];

/** Registers a cleanup; cleanups run in reverse order after the children are stopped. */
export function onCleanup(fn) {
	cleanups.push(fn);
}

export function startChild(name, command, args, { env, logFile, onLine } = {}) {
	const child = spawn(command, args, { env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
	children.push({ name, child });
	let pending = "";
	const onData = (chunk) => {
		const text = chunk.toString("utf8");
		if (logFile) void appendFile(logFile, text).catch(() => {});
		pending += text;
		let nl;
		while ((nl = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, nl);
			pending = pending.slice(nl + 1);
			onLine?.(line);
			if (VERBOSE) console.log(`[${ts()}]   ${name}| ${line}`);
		}
	};
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	child.on("exit", (code, signal) => debug(`${name} exited (code=${code}, signal=${signal})`));
	return child;
}

export async function stopChild(child, timeoutMs = 8000) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((r) => child.once("exit", r));
	child.kill("SIGTERM");
	const done = await Promise.race([exited.then(() => true), sleep(timeoutMs).then(() => false)]);
	if (!done) {
		child.kill("SIGKILL");
		await Promise.race([exited, sleep(2000)]);
	}
}

let cleanedUp = false;
export async function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	for (const { child } of [...children].reverse()) await stopChild(child).catch(() => {});
	for (const fn of cleanups.reverse()) {
		try {
			await fn();
		} catch (err) {
			console.error(`cleanup failed: ${err.message}`);
		}
	}
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		console.error(`\nreceived ${signal}, cleaning up…`);
		void cleanup().finally(() => process.exit(130));
	});
}

// ------------------------------------------------------------------ HTTP / WS clients

export class Api {
	constructor(port) {
		this.base = `http://127.0.0.1:${port}`;
		this.origin = this.base;
	}

	async raw(method, url, body) {
		const headers = { accept: "application/json" };
		if (method !== "GET" && method !== "HEAD") headers.origin = this.origin;
		if (body !== undefined) headers["content-type"] = "application/json";
		return fetch(`${this.base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	}

	async call(method, url, body, { expectStatus } = {}) {
		const response = await this.raw(method, url, body);
		const text = await response.text();
		let json;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			json = undefined;
		}
		const ok = expectStatus === undefined ? response.ok : response.status === expectStatus;
		if (!ok) {
			throw new AssertionError(`${method} /api${url} → HTTP ${response.status}: ${text.slice(0, 1500)}`);
		}
		return json;
	}

	get(url) {
		return this.call("GET", url);
	}
	post(url, body = {}) {
		return this.call("POST", url, body);
	}
	put(url, body = {}) {
		return this.call("PUT", url, body);
	}
}

/** The browser's /ws connection: topic subscriptions with an event log per topic. */
export class EventSocket {
	constructor(port) {
		this.url = `ws://127.0.0.1:${port}/ws`;
		this.origin = `http://127.0.0.1:${port}`;
		this.events = new Map();
		this.waiters = new Set();
		this.hello = null;
	}

	async open() {
		this.socket = new WebSocket(this.url, { origin: this.origin });
		this.socket.on("message", (raw) => this.onMessage(raw.toString("utf8")));
		await new Promise((resolve, reject) => {
			this.socket.once("open", resolve);
			this.socket.once("error", reject);
		});
		await waitUntil("ws hello", () => this.hello, { timeoutMs: 5000, intervalMs: 20 });
		return this;
	}

	onMessage(text) {
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (msg.type === "hello") this.hello = msg;
		if (msg.type === "error") info(`ws error message: ${msg.message}`);
		if (msg.type !== "event") return;
		if (!this.events.has(msg.topic)) this.events.set(msg.topic, []);
		this.events.get(msg.topic).push(msg.data);
		for (const waiter of [...this.waiters]) waiter();
	}

	subscribe(...topics) {
		this.socket.send(JSON.stringify({ type: "subscribe", topics }));
	}

	unsubscribe(...topics) {
		this.socket.send(JSON.stringify({ type: "unsubscribe", topics }));
	}

	list(topic) {
		return this.events.get(topic) ?? [];
	}

	/** Resolves with the first event on `topic` at index ≥ fromIndex matching `predicate`. */
	waitFor(topic, predicate, { fromIndex = 0, timeoutMs = 30_000, what = topic } = {}) {
		return new Promise((resolve, reject) => {
			let index = fromIndex;
			const check = () => {
				const list = this.list(topic);
				for (; index < list.length; index++) {
					if (predicate(list[index])) {
						cleanupWaiter();
						resolve(list[index]);
						return;
					}
				}
			};
			const timer = setTimeout(() => {
				cleanupWaiter();
				reject(new AssertionError(`timed out after ${timeoutMs} ms waiting for ${what}`));
			}, timeoutMs);
			const cleanupWaiter = () => {
				clearTimeout(timer);
				this.waiters.delete(check);
			};
			this.waiters.add(check);
			check();
		});
	}

	close() {
		try {
			this.socket?.close();
		} catch {
			// ignore
		}
	}
}

// ------------------------------------------------------------------ environment

/** Fails unless the build output exists and we run as root on Linux with OpenSSH installed. */
export function preflight() {
	for (const f of [CLI, path.join(ROOT, "packages/server/dist/agent/VERSION"), path.join(ROOT, "packages/server/dist/agent/pi-web-agent.mjs")]) {
		assert(existsSync(f), `missing ${path.relative(ROOT, f)} — run \`npm run build\` first`);
	}
	assert(process.platform === "linux" && process.getuid?.() === 0, "the E2E test must run as root on Linux");
	assert(existsSync("/usr/sbin/sshd"), "OpenSSH server (/usr/sbin/sshd) is not installed");
}

/**
 * Creates the temp dir with the host agent dir (the host's ~/.pi/agent stand-in: mock provider,
 * default model, an extension with two commands, a skill, a prompt template and auth.json).
 */
export async function prepareHostAgentDir(prefix = "pi-web-e2e-") {
	const tmp = await mkdtemp(path.join(os.tmpdir(), prefix));
	const hostAgentDir = path.join(tmp, "host-agent");
	const dataDir = path.join(tmp, "data");
	info(`temp dir: ${tmp}`);
	if (!KEEP) onCleanup(() => rm(tmp, { recursive: true, force: true }));
	await mkdir(path.join(hostAgentDir, "extensions"), { recursive: true });
	await mkdir(path.join(hostAgentDir, "skills", "demo"), { recursive: true });
	await mkdir(path.join(hostAgentDir, "prompts"), { recursive: true });
	const json = (file, value) => writeFile(path.join(hostAgentDir, file), `${JSON.stringify(value, null, 2)}\n`);
	await json("models.json", {
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://${MOCK_HOST}:${MOCK_PORT}/v1`,
				apiKey: "test-key",
				models: [{ id: "mock-1", name: "Mock 1", contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	});
	await json("settings.json", { defaultProvider: "mock", defaultModel: "mock-1" });
	await writeFile(
		path.join(hostAgentDir, "extensions", "e2e-ext.ts"),
		[
			"// Pi-Web E2E test extension",
			"export default function (pi: any) {",
			'\tpi.registerCommand("e2e-hello", {',
			'\t\tdescription: "E2E greeting command",',
			"\t\thandler: async (args: string, ctx: any) => {",
			'\t\t\tctx.ui.notify(`e2e hello ${args || "world"}`, "info");',
			"\t\t},",
			"\t});",
			'\tpi.registerCommand("e2e-ask", {',
			'\t\tdescription: "E2E confirm dialog",',
			"\t\thandler: async (_args: string, ctx: any) => {",
			'\t\t\tconst ok = await ctx.ui.confirm("E2E 确认", "继续吗？");',
			'\t\t\tctx.ui.notify(`e2e confirmed: ${ok}`, "info");',
			"\t\t},",
			"\t});",
			"}",
			"",
		].join("\n"),
	);
	await writeFile(
		path.join(hostAgentDir, "skills", "demo", "SKILL.md"),
		"---\nname: demo\ndescription: Demo skill used by the Pi-Web E2E test. Use when asked about the demo.\n---\n\nAnswer with the word DEMO.\n",
	);
	await writeFile(
		path.join(hostAgentDir, "prompts", "e2e-review.md"),
		'---\ndescription: E2E review prompt\nargument-hint: "[focus]"\n---\nReview the workspace. Focus on ${1:-correctness}.\n',
	);
	await json("auth.json", {
		"e2e-apikey": { type: "api_key", key: "sk-e2e-test" },
		"e2e-oauth": { type: "oauth", refresh: "host-refresh-token", access: "acc", expires: Date.now() + 365 * 24 * 3600_000 },
	});
	await mkdir(dataDir, { recursive: true });
	return { tmp, hostAgentDir, dataDir };
}

/** Maps mock-llm.test → 127.0.0.2 in /etc/hosts and starts e2e/mock-llm.mjs; `requests` collects its JSON log. */
export async function startMockLlm(tmp) {
	const hosts = readFileSync("/etc/hosts", "utf8");
	const mapped = hosts.split("\n").some((l) => l.trim().split(/\s+/)[0] === MOCK_IP && l.split(/\s+/).includes(MOCK_HOST));
	if (!mapped) {
		writeFileSync("/etc/hosts", `${hosts.replace(/\n?$/, "\n")}${MOCK_IP} ${MOCK_HOST}\n`);
		info(`added "${MOCK_IP} ${MOCK_HOST}" to /etc/hosts`);
	}
	assert(!(await portOpen(MOCK_IP, MOCK_PORT)), `port ${MOCK_IP}:${MOCK_PORT} is already in use (stale mock LLM?)`);
	const requests = [];
	startChild("mock", process.execPath, [MOCK_LLM, "--host", MOCK_IP, "--port", String(MOCK_PORT)], {
		logFile: path.join(tmp, "mock-llm.log"),
		onLine: (line) => {
			try {
				const entry = JSON.parse(line);
				if (entry.method) requests.push(entry);
			} catch {
				// not JSON
			}
		},
	});
	await waitUntil("mock LLM listening", () => portOpen(MOCK_IP, MOCK_PORT), { timeoutMs: 10_000 });
	const res = await fetch(`http://${MOCK_HOST}:${MOCK_PORT}/v1/models`);
	assert(res.ok, `mock LLM /v1/models via ${MOCK_HOST} → ${res.status}`);
	requests.length = 0;
	return { requests };
}

/**
 * Starts the sshd fixture with a clean pitest home (agent install, session backups and the
 * given extra paths removed before and after the run). Returns the fixture, runAsTestUser
 * and a diagnostics function reading the remote agent logs.
 */
export async function startSshdFixture({ cleanPaths = [] } = {}) {
	const mod = await tsImport(pathToFileURL(SSHD_FIXTURE).href, import.meta.url);
	const reason = mod.integrationSkipReason();
	assert(!reason, `sshd fixture unavailable: ${reason}`);
	const tidy = () =>
		spawnSync("sh", ["-c", `rm -rf ${mod.TEST_HOME}/.pi-web ${mod.TEST_HOME}/pi-web-sessions-backup-* ${cleanPaths.map((p) => `${mod.TEST_HOME}/${p}`).join(" ")}`]);
	// A previous run may have left the agent daemon or pi processes behind.
	spawnSync("pkill", ["-KILL", "-u", mod.TEST_USER]);
	tidy();
	// Cleanups run in reverse order: stop sshd (kills pitest's processes), then tidy the home.
	if (!KEEP) onCleanup(() => tidy());
	const fixture = await mod.startSshd();
	onCleanup(() => fixture.stop());
	const runAsTestUser = mod.runAsTestUser;
	assert(runAsTestUser("echo ok").stdout.trim() === "ok", "cannot run commands as the test user");
	const remoteDiagnostics = () =>
		runAsTestUser("tail -n 80 ~/.pi-web/logs/agent.log 2>/dev/null; echo '-- daemon.out --'; tail -n 30 ~/.pi-web/logs/daemon.out 2>/dev/null").stdout;
	return { fixture, runAsTestUser, remoteDiagnostics };
}

/** Copies the cached Node.js / pi bundles into <dataDir>/cache. */
export async function seedBundleCache(dataDir) {
	if (!existsSync(CACHE_SEED)) {
		info(`no bundle cache at ${CACHE_SEED}; pi-web will download through the proxy`);
		return;
	}
	for (const kind of ["node", "pi"]) {
		if (existsSync(path.join(CACHE_SEED, kind))) {
			await cp(path.join(CACHE_SEED, kind), path.join(dataDir, "cache", kind), { recursive: true });
		}
	}
	info(`seeded ${path.join(dataDir, "cache")} from ${CACHE_SEED}`);
}

/**
 * Starts the built CLI on `port` with PI_CODING_AGENT_DIR=hostAgentDir and the mock LLM /
 * loopback in NO_PROXY; waits for /api/meta. Returns { child, api }.
 */
export async function startPiWebProcess({ hostAgentDir, dataDir, port, logFile }) {
	const noProxyExtra = [MOCK_HOST, MOCK_IP, "localhost", "127.0.0.1"];
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: hostAgentDir,
		NO_PROXY: extendNoProxy(process.env.NO_PROXY, noProxyExtra),
		no_proxy: extendNoProxy(process.env.no_proxy, noProxyExtra),
	};
	delete env.PI_WEB_DATA_DIR;
	const child = startChild("pi-web", process.execPath, [CLI, "--data-dir", dataDir, "--port", String(port)], { env, logFile });
	const api = new Api(port);
	await waitUntil("pi-web /api/meta", async () => (await fetch(`${api.base}/api/meta`)).ok, { timeoutMs: 20_000 });
	const meta = await api.get("/meta");
	assert(meta.hostAgentDir === hostAgentDir, "meta.hostAgentDir should be PI_CODING_AGENT_DIR", meta);
	assert(meta.dataDir === dataDir, "meta.dataDir should be --data-dir", meta);
	return { child, api };
}

/** Pins settings.nodeVersion to the cached Node.js 22 runtime so deploys do not need nodejs.org. */
export async function pinCachedNodeVersion(api, dataDir) {
	const nodeDir = path.join(dataDir, "cache", "node");
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const cached = existsSync(nodeDir)
		? readdirSync(nodeDir)
				.map((f) => f.match(new RegExp(`^node-v(22\\.\\d+\\.\\d+)-linux-${arch}\\.tar\\.gz$`))?.[1])
				.filter(Boolean)
		: [];
	const settings = await api.get("/settings");
	assert(settings.nodeVersion, "settings.nodeVersion missing", settings);
	if (cached.length > 0) {
		const updated = await api.put("/settings", { nodeVersion: cached[0] });
		assert(updated.nodeVersion === cached[0], "nodeVersion not updated", updated);
		info(`nodeVersion pinned to ${cached[0]}`);
		return cached[0];
	}
	return settings.nodeVersion;
}
