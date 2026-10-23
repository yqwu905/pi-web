import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentHelloResult, AgentStatus, ConvEvent, ConvStartResult, FsListResult } from "@pi-web/shared";
import { AGENT_PROTOCOL_VERSION } from "@pi-web/shared";
import { LINK_PREAMBLE, LinkPeer } from "@pi-web/shared/link";
import { cleanupTempDirs, distDir, makeConfig, tempDir, waitFor } from "./helpers.js";

interface BridgeConnection {
	child: ChildProcessWithoutNullStreams;
	peer: LinkPeer;
	events: Array<[string, unknown]>;
	stderr: () => string;
}

const children: ChildProcessWithoutNullStreams[] = [];
const daemonPids: number[] = [];

async function openBridge(root: string): Promise<BridgeConnection> {
	const child = spawn(process.execPath, [join(distDir, "bridge.mjs"), "--root", root], { stdio: ["pipe", "pipe", "pipe"] });
	children.push(child);
	let stderr = "";
	child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
	const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
	const peer = new LinkPeer(transport, { side: "host", preamble: LINK_PREAMBLE });
	const events: Array<[string, unknown]> = [];
	peer.on("event", (name: string, data: unknown) => events.push([name, data]));
	await Promise.race([
		peer.ready,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`bridge not ready: ${stderr}`)), 20_000)),
	]);
	return { child, peer, events, stderr: () => stderr };
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	await new Promise((r) => server.close(r));
	return port;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

afterAll(async () => {
	for (const child of children) child.kill("SIGKILL");
	for (const pid of daemonPids) if (alive(pid)) process.kill(pid, "SIGKILL");
	await cleanupTempDirs();
});

describe("bridge + daemon end to end", () => {
	it("starts the daemon on demand and serves Link requests", async () => {
		const root = await tempDir("pwa-e2e-");
		const first = await openBridge(root);
		const hello = await first.peer.request<AgentHelloResult>("hello", { hostVersion: "test", protocol: AGENT_PROTOCOL_VERSION });
		daemonPids.push(hello.pid);
		const version = (await readFile(join(distDir, "VERSION"), "utf8")).trim();
		expect(hello).toMatchObject({ agentVersion: version, protocol: AGENT_PROTOCOL_VERSION, remoteRoot: root, config: null });
		expect(hello.pid).not.toBe(first.child.pid);
		expect((await stat(join(root, "run", "agent.sock"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);

		const port = await freePort();
		const config = makeConfig(root, {
			proxy: { enabled: true, port, token: "feedfacefeedfacefeedface", scope: "llm", noProxy: ["localhost", "127.0.0.1"] },
			// fake pi ignores stdin EOF, so stopping it takes the 5s SIGTERM grace period
			extraEnv: { FAKE_PI_IGNORE_STDIN_END: "1" },
		});
		expect(await first.peer.request("agent.configure", config)).toEqual({ ok: true });
		expect((await stat(join(root, "state", "config.json"))).mode & 0o777).toBe(0o600);
		const proxyEnv = await readFile(join(root, "run", "proxy.env"), "utf8");
		// pi gets a per-daemon token (never the host's), and only while this daemon is alive.
		const sessionToken = /export HTTPS_PROXY=http:\/\/pw:([0-9a-f]{48})@127\.0\.0\.1:(\d+)/.exec(proxyEnv);
		expect(sessionToken?.[2]).toBe(String(port));
		expect(proxyEnv).not.toContain("feedfacefeedfacefeedface");
		expect(proxyEnv).toContain(`kill -0 ${hello.pid} `);
		expect(proxyEnv).toContain("export NO_PROXY=localhost,127.0.0.1");
		expect((await stat(join(root, "run", "proxy.env"))).mode & 0o777).toBe(0o600);
		// The server-level env (extraEnv) is published for R/bin/pi and the web terminal.
		expect(await readFile(join(root, "run", "env.sh"), "utf8")).toContain(" || export FAKE_PI_IGNORE_STDIN_END='1'\n");
		expect((await stat(join(root, "run", "env.sh"))).mode & 0o777).toBe(0o600);
		await waitFor(() => first.events.find(([name, data]) => name === "agent.log" && String((data as { msg: string }).msg).startsWith("configured")));
		const logLine = first.events.find(([name]) => name === "agent.log")?.[1] as { msg: string };
		expect(JSON.stringify(first.events)).not.toContain("feedfacefeedfacefeedface");
		expect(logLine.msg).toBeTruthy();

		const listing = await first.peer.request<FsListResult>("fs.list", { path: root });
		expect(listing.entries.map((e) => e.name)).toEqual(expect.arrayContaining(["logs", "run", "state", "agent"]));

		// A second bridge reuses the running daemon; events go to every peer.
		const second = await openBridge(root);
		const hello2 = await second.peer.request<AgentHelloResult>("hello", { hostVersion: "test", protocol: AGENT_PROTOCOL_VERSION });
		expect(hello2.pid).toBe(hello.pid);
		expect(hello2.config?.proxy.port).toBe(port);

		const status = await second.peer.request<AgentStatus>("agent.status", {});
		expect(status.proxy).toMatchObject({ listening: true, port });
		expect(status.loadavg).toHaveLength(3);

		const cwd = await tempDir("pwa-e2e-ws-");
		const started = await first.peer.request<ConvStartResult>("conv.start", { convId: "e2e", cwd, trust: "no-approve" });
		expect(started.conv.status).toBe("idle");
		await first.peer.request("conv.send", { convId: "e2e", command: { type: "prompt", message: "hello" } });
		const settled = (c: BridgeConnection) =>
			c.events.find(([name, data]) => name === "conv.event" && (data as ConvEvent).record.type === "agent_settled");
		await waitFor(() => settled(first) && settled(second));
		const logs = await second.peer.request<{ lines: string[] }>("agent.logs", { tail: 5 });
		expect(logs.lines.length).toBeGreaterThan(0);
		expect(logs.lines.join("\n")).not.toContain("feedfacefeedfacefeedface");

		// Graceful shutdown stops conversations, the daemon and both bridges.
		// The daemon stops accepting (socket and lock released, proxy port freed) before it answers,
		// so a bridge started right away reaches a fresh daemon that loads the persisted config.
		const firstExit = once(first.child, "exit");
		const secondExit = once(second.child, "exit");
		expect(await second.peer.request("agent.shutdown", {})).toEqual({ ok: true });
		await expect(stat(join(root, "run", "agent.sock"))).rejects.toThrow();
		await expect(stat(join(root, "run", "agent.pid"))).rejects.toThrow();
		// The proxy port is released: proxy.env must not point anyone at it any more.
		await expect(stat(join(root, "run", "proxy.env"))).rejects.toThrow();
		const third = await openBridge(root);
		const hello3 = await third.peer.request<AgentHelloResult>("hello", { hostVersion: "test", protocol: AGENT_PROTOCOL_VERSION });
		daemonPids.push(hello3.pid);
		expect(hello3.pid).not.toBe(hello.pid);
		expect(alive(hello.pid)).toBe(true);
		expect(hello3.config?.agentDir).toBe(config.agentDir);
		const status3 = await third.peer.request<AgentStatus>("agent.status", {});
		expect(status3.proxy).toMatchObject({ listening: true, port });
		const proxyEnv3 = await readFile(join(root, "run", "proxy.env"), "utf8");
		expect(proxyEnv3).toContain(`kill -0 ${hello3.pid} `);
		expect(proxyEnv3).not.toContain(sessionToken![1]);
		// Unlike proxy.env, env.sh holds no secret tied to the daemon: it survives the restart, and
		// goes away once the server has no variables left.
		expect(await readFile(join(root, "run", "env.sh"), "utf8")).toContain("export FAKE_PI_IGNORE_STDIN_END='1'");
		expect(await third.peer.request("agent.configure", { ...config, extraEnv: {} })).toEqual({ ok: true });
		await expect(stat(join(root, "run", "env.sh"))).rejects.toThrow();

		// The old daemon finishes stopping its conversation (SIGTERM after 5s) and exits with its bridges.
		await Promise.all([firstExit, secondExit]);
		await waitFor(() => !alive(hello.pid), 10_000);
		expect(first.events.some(([name, data]) => name === "conv.info" && (data as { status: string }).status === "exited")).toBe(true);
		third.peer.close();
		process.kill(hello3.pid, "SIGTERM");
		await waitFor(() => !alive(hello3.pid), 10_000);
	}, 60_000);

	it("starts a single daemon when bridges race", async () => {
		const root = await tempDir("pwa-race-");
		const bridges = await Promise.all([openBridge(root), openBridge(root), openBridge(root)]);
		const pids = await Promise.all(
			bridges.map((b) => b.peer.request<AgentHelloResult>("hello", { hostVersion: "test", protocol: AGENT_PROTOCOL_VERSION }).then((h) => h.pid)),
		);
		daemonPids.push(...pids);
		expect(new Set(pids).size).toBe(1);
		expect((await readFile(join(root, "run", "agent.pid"), "utf8")).trim()).toBe(String(pids[0]));
		await bridges[0].peer.request("agent.shutdown", {});
		await waitFor(() => !alive(pids[0]), 10_000);
	});

	it("fails with a message on stderr when the daemon cannot start", async () => {
		const child = spawn(process.execPath, [join(distDir, "bridge.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
		children.push(child);
		let stderr = "";
		let stdout = "";
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
		const [code] = await once(child, "exit");
		expect(code).toBe(1);
		expect(stderr).toContain("usage");
		expect(stdout).toBe("");
	});
});
