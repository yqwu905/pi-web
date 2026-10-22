import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, proxyEnvFile, validateAgentConfig } from "../src/daemon/config.js";
import { joinInside, resolveUserPath, safeRelativePath } from "../src/daemon/fsutil.js";
import { JsonlLineDecoder } from "../src/daemon/jsonl.js";
import { AgentLogger, type LogEntry } from "../src/daemon/logger.js";
import { ensureRemoteDirs, remotePaths } from "../src/daemon/paths.js";
import { RingBuffer } from "../src/daemon/ring.js";
import { LinkServer } from "../src/daemon/server.js";
import { cleanupTempDirs, makeConfig, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

describe("JsonlLineDecoder", () => {
	it("splits on LF only, strips CR and keeps U+2028 inside records", () => {
		const d = new JsonlLineDecoder();
		const text = '{"a":"x y"}\r\n{"b":1}\n{"c":';
		const bytes = Buffer.from(text, "utf8");
		const lines: string[] = [];
		for (const byte of bytes) lines.push(...d.push(Buffer.from([byte])));
		expect(lines).toEqual(['{"a":"x y"}', '{"b":1}']);
		expect(d.push(Buffer.from("2}\n"))).toEqual(['{"c":2}']);
		expect(d.push("tail")).toEqual([]);
		expect(d.end()).toEqual(["tail"]);
	});

	it("decodes a very long line in linear time", () => {
		const d = new JsonlLineDecoder();
		const chunk = Buffer.alloc(64 * 1024, "a");
		const started = Date.now();
		let lines: string[] = [];
		for (let i = 0; i < 512; i++) lines = lines.concat(d.push(chunk)); // 32 MiB in one line
		lines = lines.concat(d.push(Buffer.from("\r\nnext\n")));
		expect(Date.now() - started).toBeLessThan(3000);
		expect(lines).toHaveLength(2);
		expect(lines[0].length).toBe(32 * 1024 * 1024);
		expect(lines[1]).toBe("next");
	});

	it("keeps multi-byte characters split across chunks", () => {
		const d = new JsonlLineDecoder();
		const bytes = Buffer.from("名字\n", "utf8");
		expect(d.push(bytes.subarray(0, 2))).toEqual([]);
		expect(d.push(bytes.subarray(2))).toEqual(["名字"]);
	});
});

describe("RingBuffer", () => {
	it("drops the oldest items by count and by byte budget", () => {
		const r = new RingBuffer<number>(3);
		for (let i = 1; i <= 5; i++) r.push(i);
		expect(r.toArray()).toEqual([3, 4, 5]);
		expect(r.first()).toBe(3);
		expect(r.tailWhile((n) => n > 3)).toEqual([4, 5]);

		const b = new RingBuffer<string>(10, 100);
		b.push("a", 60);
		b.push("b", 30);
		expect(b.toArray()).toEqual(["a", "b"]);
		b.push("c", 20);
		expect(b.toArray()).toEqual(["b", "c"]);
		expect(b.totalBytes).toBe(50);
		b.push("huge", 500);
		expect(b.toArray()).toEqual(["huge"]);
	});
});

describe("AgentLogger", () => {
	it("rotates, tails across files, redacts secret fields and reports info+", async () => {
		const dir = await tempDir();
		const file = join(dir, "agent.log");
		const entries: LogEntry[] = [];
		const log = new AgentLogger(file, { maxBytes: 200, keep: 2, onEntry: (e) => entries.push(e) });
		for (let i = 0; i < 20; i++) log.info(`message number ${i}`, { token: "s3cret", n: i });
		log.debug("quiet");
		expect(entries).toHaveLength(20);
		expect((await stat(file)).size).toBeLessThanOrEqual(200);
		await expect(stat(`${file}.1`)).resolves.toBeTruthy();
		await expect(stat(`${file}.3`)).rejects.toThrow();
		const tail = log.tail(3);
		expect(tail).toHaveLength(3);
		expect(tail[2]).toContain("DEBUG quiet");
		expect(tail[1]).toContain("message number 19");
		const all = log.tail(1000).join("\n");
		expect(all).not.toContain("s3cret");
		expect(all).toContain('"token":"[redacted]"');
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});
});

describe("config", () => {
	it("validates and normalizes AgentConfig", () => {
		const config = validateAgentConfig({ ...makeConfig("/r"), extraEnv: { A: "1", B: 2 }, idleTimeoutMin: undefined });
		expect(config.extraEnv).toEqual({ A: "1" });
		expect(config.idleTimeoutMin).toBe(30);
		expect(() => validateAgentConfig({ ...makeConfig("/r"), agentDir: "relative" })).toThrow(/agentDir/);
		expect(() =>
			validateAgentConfig({ ...makeConfig("/r"), proxy: { enabled: true, port: 0, token: "x", scope: "llm", noProxy: [] } }),
		).toThrow(/端口/);
	});

	it("writes proxy.env with shell-quoted values, only on request, and removes it", async () => {
		const root = await tempDir();
		const paths = remotePaths(root);
		await ensureRemoteDirs(paths);
		const text = proxyEnvFile({ enabled: true, port: 31000, token: "abc'def0123", scope: "llm", noProxy: ["localhost", "*.corp"] });
		expect(text).toContain(`export HTTPS_PROXY='http://pw:abc'\\''def0123@127.0.0.1:31000'`);
		expect(text).toContain(`export no_proxy='localhost,*.corp'`);
		expect(text.match(/^export /gm)).toHaveLength(8);

		const store = new ConfigStore(paths);
		const config = makeConfig(root, { proxy: { enabled: true, port: 31000, token: "0123456789abcdef", scope: "tools", noProxy: [] } });
		await store.save(config);
		// Saving the config does not publish proxy.env: the daemon does that once the port is bound.
		await expect(stat(paths.proxyEnv)).rejects.toThrow();
		expect(JSON.parse(await readFile(paths.configFile, "utf8")).proxy.port).toBe(31000);
		const reloaded = new ConfigStore(paths);
		expect((await reloaded.load())?.proxy.scope).toBe("tools");
		await store.writeProxyEnv(config.proxy, { pid: process.pid, commandMatch: "node" });
		expect((await stat(paths.proxyEnv)).mode & 0o777).toBe(0o600);
		await store.removeProxyEnv();
		await expect(stat(paths.proxyEnv)).rejects.toThrow();
	});

	it("exports the proxy variables only while the owning daemon runs", async () => {
		const proxy = { enabled: true, port: 31000, token: "0123456789abcdef", scope: "llm" as const, noProxy: [] };
		const run = async (pid: number, match: string) => {
			const script = `${proxyEnvFile(proxy, { pid, commandMatch: match })}\nprintf '%s' "\${HTTPS_PROXY:-none}"`;
			const child = spawn("sh", ["-c", script], { env: { PATH: process.env.PATH ?? "" } });
			let out = "";
			child.stdout.on("data", (d: Buffer) => (out += d.toString()));
			await once(child, "exit");
			return out;
		};
		expect(await run(process.pid, process.argv[1] ?? "node")).toBe("http://pw:0123456789abcdef@127.0.0.1:31000");
		// A dead daemon (another user may hold the port now) or a different process: no proxy.
		const dead = spawn(process.execPath, ["-e", ""]);
		await once(dead, "exit");
		expect(await run(dead.pid!, "node")).toBe("none");
		expect(await run(process.pid, "definitely-not-in-the-command-line")).toBe("none");
	});
});

describe("fsutil", () => {
	it("validates relative paths and expands ~", () => {
		expect(safeRelativePath("a/./b/")).toBe("a/b");
		for (const bad of ["", "..", "../x", "a/../../x", "a/b/../c", "/abs", "a\\b", "a\0b", "."]) {
			expect(() => safeRelativePath(bad)).toThrow();
		}
		expect(joinInside("/base", "x/y")).toBe("/base/x/y");
		expect(resolveUserPath("~")).toBe(homedir());
		expect(resolveUserPath("~/x")).toBe(join(homedir(), "x"));
		expect(resolveUserPath("/a/../b")).toBe("/b");
	});
});

describe("LinkServer", () => {
	it("detects a live instance and replaces stale sockets", async () => {
		const dir = await tempDir();
		const socket = join(dir, "agent.sock");
		const a = new LinkServer(() => {});
		expect(await a.listen(socket)).toBe("listening");
		expect((await stat(socket)).mode & 0o777).toBe(0o600);
		const b = new LinkServer(() => {});
		expect(await b.listen(socket)).toBe("already-running");
		await a.close();

		// A socket file left behind by a killed process is stale.
		const staleSock = join(dir, "stale.sock");
		const child = spawn(
			process.execPath,
			["-e", `require("net").createServer().listen(${JSON.stringify(staleSock)}, () => console.log("up"))`],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		await once(child.stdout, "data");
		child.kill("SIGKILL");
		await once(child, "exit");
		await expect(stat(staleSock)).resolves.toBeTruthy();
		const c = new LinkServer(() => {});
		expect(await c.listen(staleSock)).toBe("listening");
		await c.close();
	});
});
