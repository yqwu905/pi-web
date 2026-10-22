import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayUrl, parseCliArgs } from "../../src/cli.js";
import { createAppRuntime } from "../../src/context.js";
import type { AppRuntime } from "../../src/context.js";
import { FakeAgent, flush, makeServer, silentLog, until } from "./fakes.js";

describe("composition root", () => {
	let dir: string;
	let runtime: AppRuntime;

	beforeEach(async () => {
		dir = mkdtempSync(path.join(tmpdir(), "pi-web-ctx-"));
		runtime = await createAppRuntime({ dataDir: path.join(dir, "data"), version: "7.7.7", log: silentLog });
	});

	afterEach(async () => {
		await runtime.shutdown();
		rmSync(dir, { recursive: true, force: true });
	});

	it("builds every service on the shared context", () => {
		const { ctx } = runtime;
		expect(ctx.version).toBe("7.7.7");
		expect(ctx.paths.dataDir).toBe(path.join(dir, "data"));
		expect(ctx.hub).toBe(runtime.hub);
		for (const key of ["store", "secrets", "hostPi", "connections", "deployer", "proxy", "syncer", "oauth", "conversations"] as const) {
			expect(ctx[key], key).toBeDefined();
		}
	});

	it("publishes connection status and deploy progress to the hub", () => {
		const publish = vi.spyOn(runtime.hub, "publish");
		runtime.ctx.connections.emit("status", { serverId: "s1", connection: "connected" });
		runtime.ctx.deployer.emit("progress", { serverId: "s1", jobId: "j", state: "running", steps: [], log: [], startedAt: 1 });
		expect(publish).toHaveBeenCalledWith("servers", { serverId: "s1", connection: "connected" });
		expect(publish).toHaveBeenCalledWith("deploy:s1", expect.objectContaining({ jobId: "j" }));
	});

	it("attaches proxy, conversations and syncer when an agent connects, and detaches on disconnect", async () => {
		const { ctx } = runtime;
		await ctx.store.saveServer(makeServer());
		const agent = new FakeAgent();
		agent.addConv({ convId: "c1", cwd: "/x" });
		const client = agent.connect();
		(ctx.connections.get("srv1") as unknown as { agentClient: unknown }).agentClient = client;

		const proxyAttach = vi.spyOn(ctx.proxy, "attach");
		const proxyDetach = vi.spyOn(ctx.proxy, "detach");
		const syncerConnected = vi.spyOn(ctx.syncer, "onAgentConnected").mockImplementation(() => {});
		const convDetach = vi.spyOn(ctx.conversations, "detach");

		ctx.connections.emit("agent-connected", "srv1", client);
		await until(() => syncerConnected.mock.calls.length === 1);
		expect(proxyAttach).toHaveBeenCalledWith("srv1", client);
		expect(agent.callsOf("conv.list")).toHaveLength(1);
		expect(ctx.conversations.get("c1")?.serverId).toBe("srv1");
		// Order: proxy → conversations → syncer.
		expect(proxyAttach.mock.invocationCallOrder[0]).toBeLessThan(syncerConnected.mock.invocationCallOrder[0]);

		ctx.connections.emit("agent-disconnected", "srv1");
		expect(proxyDetach).toHaveBeenCalledWith("srv1");
		expect(convDetach).toHaveBeenCalledWith("srv1");
		client.close();
		await flush();
	});

	it("skips the attach sequence for a superseded link", async () => {
		const { ctx } = runtime;
		await ctx.store.saveServer(makeServer());
		const agent = new FakeAgent();
		const stale = agent.connect();
		const proxyAttach = vi.spyOn(ctx.proxy, "attach");
		ctx.connections.emit("agent-connected", "srv1", stale);
		await flush();
		expect(proxyAttach).not.toHaveBeenCalled();
		stale.close();
	});

	it("shuts down idempotently", async () => {
		await Promise.all([runtime.shutdown(), runtime.shutdown()]);
	});
});

describe("cli", () => {
	it("parses arguments", () => {
		expect(parseCliArgs([])).toEqual({ dev: false, help: false, version: false, host: undefined, port: undefined, dataDir: undefined });
		expect(parseCliArgs(["--host", "0.0.0.0", "--port", "8080", "--data-dir", "/d", "--dev"])).toEqual({
			host: "0.0.0.0",
			port: 8080,
			dataDir: "/d",
			dev: true,
			help: false,
			version: false,
		});
		expect(() => parseCliArgs(["--port", "x"])).toThrow("invalid --port: x");
		expect(() => parseCliArgs(["--bogus"])).toThrow();
	});

	it("formats the URL to open", () => {
		expect(displayUrl("127.0.0.1", 7878)).toBe("http://127.0.0.1:7878/");
		expect(displayUrl("0.0.0.0", 7878)).toBe("http://127.0.0.1:7878/");
		expect(displayUrl("::1", 7878)).toBe("http://[::1]:7878/");
	});
});
