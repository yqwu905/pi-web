import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, redact } from "../../src/core/log.js";
import { createHostPaths, ensureHostDirs, expandHome, resolveAgentDistDir } from "../../src/core/paths.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-web-paths-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("paths", () => {
	it("resolves the data dir from options, env and default", () => {
		expect(createHostPaths({ dataDir: dir, env: {} }).dataDir).toBe(dir);
		expect(createHostPaths({ env: { PI_WEB_DATA_DIR: dir } }).dataDir).toBe(dir);
		expect(createHostPaths({ env: {} }).dataDir).toBe(path.join(homedir(), ".pi-web-host"));
		const paths = createHostPaths({ dataDir: dir, env: {} });
		expect(paths.cacheDir).toBe(path.join(dir, "cache"));
		expect(paths.tmpDir).toBe(path.join(dir, "cache", "tmp"));
		expect(paths.logsDir).toBe(path.join(dir, "logs"));
	});

	it("resolves the host agent dir: settings > env > default, live when given a getter", () => {
		expect(createHostPaths({ dataDir: dir, env: {} }).hostAgentDir).toBe(path.join(homedir(), ".pi", "agent"));
		expect(createHostPaths({ dataDir: dir, env: { PI_CODING_AGENT_DIR: "/a" } }).hostAgentDir).toBe("/a");
		let current = "/b";
		const paths = createHostPaths({ dataDir: dir, env: { PI_CODING_AGENT_DIR: "/a" }, settings: () => ({ hostAgentDir: current }) });
		expect(paths.hostAgentDir).toBe("/b");
		current = "~/c";
		expect(paths.hostAgentDir).toBe(path.join(homedir(), "c"));
	});

	it("finds the agent dist dir (packages/agent/dist in development)", () => {
		expect(resolveAgentDistDir()).toMatch(/packages\/agent\/dist$/);
		expect(createHostPaths({ dataDir: dir, agentDistDir: "/x", webDistDir: null }).agentDistDir).toBe("/x");
	});

	it("creates directories with 0700", async () => {
		const paths = createHostPaths({ dataDir: path.join(dir, "data"), env: {} });
		ensureHostDirs(paths);
		expect((await stat(paths.dataDir)).mode & 0o777).toBe(0o700);
		expect(existsSync(path.join(paths.cacheDir, "node"))).toBe(true);
		expect(existsSync(paths.tmpDir)).toBe(true);
	});

	it("expands ~", () => {
		expect(expandHome("~/x", "/h")).toBe("/h/x");
		expect(expandHome("~", "/h")).toBe("/h");
		expect(expandHome("/abs", "/h")).toBe("/abs");
	});
});

describe("logger", () => {
	it("writes scoped lines, filters by level and redacts secrets", () => {
		const log = createLogger({ logsDir: dir }, { console: false, level: "info" });
		const child = log.child("ssh").child("srv");
		child.debug("hidden");
		child.info("hello", { password: "p4ss", nested: { token: "t0k", keep: 1 }, list: [{ secret: "s" }] });
		const text = readFileSync(path.join(dir, "pi-web.log"), "utf8");
		expect(text).not.toContain("hidden");
		expect(text).toContain("[ssh:srv] hello");
		expect(text).not.toContain("p4ss");
		expect(text).not.toContain("t0k");
		expect(text).toContain('"keep":1');
		expect(redact({ authorization: "Bearer x" })).toEqual({ authorization: "***" });
	});

	it("rotates files", async () => {
		await mkdir(dir, { recursive: true });
		const log = createLogger({ logsDir: dir }, { console: false, maxBytes: 300, keep: 2 });
		for (let i = 0; i < 40; i++) log.info(`line ${i} ${"x".repeat(20)}`);
		const files = (await readdir(dir)).sort();
		expect(files).toEqual(["pi-web.log", "pi-web.log.1", "pi-web.log.2"]);
		expect((await stat(path.join(dir, "pi-web.log"))).size).toBeLessThanOrEqual(300);
		expect(readFileSync(path.join(dir, "pi-web.log"), "utf8")).toContain("line 39");
	});

	it("never throws when the log dir is unusable", async () => {
		const file = path.join(dir, "blocker");
		await writeFile(file, "x");
		const log = createLogger({ logsDir: path.join(file, "logs") }, { console: false });
		expect(() => log.error("boom")).not.toThrow();
	});
});
