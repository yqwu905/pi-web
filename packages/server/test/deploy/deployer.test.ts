import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerConfig } from "@pi-web/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNullLogger } from "../../src/core/log.js";
import { createHostPaths } from "../../src/core/paths.js";
import { createSecrets } from "../../src/core/secrets.js";
import { createServerConfig, createStore, type JsonStore } from "../../src/core/store.js";
import type { ConnectionManager } from "../../src/core/types.js";
import { createDeployer, type PiWebDeployer } from "../../src/deploy/deployer.js";
import { MIN_PI_VERSION } from "../../src/deploy/scripts.js";
import serverPackage from "../../package.json" with { type: "json" };

let dir: string;
let store: JsonStore;
let deployer: PiWebDeployer;
let secrets: ReturnType<typeof createSecrets>;
const statusPatches: unknown[] = [];

const deployed: ServerConfig["deployed"] = {
	nodeVersion: "22.20.0",
	piVersion: "1.4.0",
	agentVersion: "0.1.0",
	arch: "x64",
	home: "/home/dev",
	remoteRoot: "/home/dev/.pi-web",
	agentDir: "/home/dev/.pi-web/agent",
	at: 1,
};

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-web-deployer-"));
	const agentDist = path.join(dir, "agent-dist");
	await mkdir(agentDist, { recursive: true });
	await writeFile(path.join(agentDist, "VERSION"), "0.1.0\n");
	const paths = createHostPaths({ dataDir: dir, agentDistDir: agentDist, webDistDir: null, env: {} });
	store = createStore(paths);
	secrets = createSecrets(paths);
	const server = createServerConfig(
		{ name: "s", host: "h", username: "dev", auth: { method: "agent" }, proxy: { port: 34567, noProxy: ["10.0.0.0/8", "localhost"] } },
		{ id: "s" },
	);
	server.deployed = deployed;
	await store.saveServer(server);
	const connections = {
		updateStatus: (id: string, patch: unknown) => statusPatches.push([id, patch]),
		get: () => {
			throw new Error("no ssh in unit tests");
		},
	} as unknown as ConnectionManager;
	deployer = createDeployer({ version: "test", paths, log: createNullLogger(), store, secrets, connections });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("Deployer (no SSH)", () => {
	it("reads the agent version from the dist dir", async () => {
		expect(deployer.agentVersion).toBe("0.1.0");
		await writeFile(path.join(dir, "agent-dist", "VERSION"), "0.2.0\n");
		await new Promise((r) => setTimeout(r, 20));
		await writeFile(path.join(dir, "agent-dist", "VERSION"), "0.2.0\n");
		expect(deployer.agentVersion).toBe("0.2.0");
	});

	it("builds the agent config and persists a generated proxy token", async () => {
		const config = await deployer.buildAgentConfig("s");
		expect(config).toMatchObject({
			remoteRoot: "/home/dev/.pi-web",
			agentDir: "/home/dev/.pi-web/agent",
			nodePath: "/home/dev/.pi-web/runtime/current/bin/node",
			piCliPath: "/home/dev/.pi-web/pi/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
			piPackageDir: "/home/dev/.pi-web/pi/current/node_modules/@earendil-works/pi-coding-agent",
			piVersion: "1.4.0",
			companionExtPath: "/home/dev/.pi-web/daemon/pi-web-ext.mjs",
			proxy: { enabled: true, port: 34567, scope: "llm", noProxy: ["localhost", "127.0.0.1", "::1", "10.0.0.0/8"] },
			idleTimeoutMin: 30,
			extraEnv: {},
		});
		expect(config.proxy.token).toMatch(/^[0-9a-f]{64}$/);
		const [a, b] = await Promise.all([deployer.buildAgentConfig("s"), deployer.buildAgentConfig("s")]);
		expect(a.proxy.token).toBe(config.proxy.token);
		expect(b.proxy.token).toBe(config.proxy.token);
		expect(await secrets.get("server:s:proxyToken")).toBe(config.proxy.token);

		const server = store.getServer("s")!;
		server.agentDirMode = "shared";
		server.proxy.mode = "off";
		await store.saveServer(server);
		const shared = await deployer.buildAgentConfig("s");
		expect(shared.agentDir).toBe("/home/dev/.pi/agent");
		expect(shared.proxy.enabled).toBe(false);
	});

	it("refuses to build a config for undeployed servers", async () => {
		const server = store.getServer("s")!;
		delete server.deployed;
		await store.saveServer(server);
		await expect(deployer.buildAgentConfig("s")).rejects.toMatchObject({ code: "NOT_DEPLOYED" });
		await expect(deployer.buildAgentConfig("missing")).rejects.toMatchObject({ status: 404 });
	});

	it("resolves the target pi version", async () => {
		expect(await deployer.targetPiVersion()).toMatch(/^\d+\.\d+\.\d+/);
		await store.updateSettings({ piVersionPolicy: "pinned", piPinnedVersion: "1.3.9" });
		expect(await deployer.targetPiVersion()).toBe("1.3.9");
	});

	it("deploys the bundled pi instead of an unsupported host pi", async () => {
		let hostVersion = "0.73.1"; // e.g. the deprecated @mariozechner/pi-coding-agent on PATH
		const withHost = createDeployer({
			version: "test",
			paths: createHostPaths({ dataDir: dir, agentDistDir: path.join(dir, "agent-dist"), webDistDir: null, env: {} }),
			log: createNullLogger(),
			store,
			secrets,
			connections: {} as ConnectionManager,
			hostPi: { version: async () => hostVersion },
		});
		const { VERSION: bundled } = await import("@earendil-works/pi-coding-agent");
		expect(await withHost.targetPiVersion()).toBe(bundled);
		hostVersion = "99.0.0";
		expect(await withHost.targetPiVersion()).toBe("99.0.0");
		expect(MIN_PI_VERSION).toBe(serverPackage.dependencies["@earendil-works/pi-coding-agent"].replace(/^[\^~]/, ""));
	});

	it("runs the pi CLI recorded at install time", async () => {
		const server = store.getServer("s")!;
		server.deployed = { ...deployed!, piCli: "node_modules/@earendil-works/pi-coding-agent/dist/cli.js" };
		await store.saveServer(server);
		expect((await deployer.buildAgentConfig("s")).piCliPath).toBe("/home/dev/.pi-web/pi/current/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
	});

	it("lists cache entries with their users", async () => {
		const cache = path.join(dir, "cache");
		await mkdir(path.join(cache, "node"), { recursive: true });
		await mkdir(path.join(cache, "pi"), { recursive: true });
		await writeFile(path.join(cache, "node", "node-v22.20.0-linux-x64.tar.gz"), "x");
		await writeFile(path.join(cache, "node", "node-v22.20.0-linux-arm64.tar.gz"), "xy");
		await writeFile(path.join(cache, "pi", "pi-1.4.0-linux.tar.gz"), "xyz");
		await writeFile(path.join(cache, "pi", "garbage.txt"), "x");
		const listing = await deployer.listCache();
		expect(listing.totalBytes).toBe(6);
		expect(listing.entries.map((e) => [e.name, e.usedBy])).toEqual([
			["node-v22.20.0-linux-arm64.tar.gz", []],
			["node-v22.20.0-linux-x64.tar.gz", ["s"]],
			["pi-1.4.0-linux.tar.gz", ["s"]],
		]);
		await deployer.deleteCache("pi-1.4.0-linux.tar.gz");
		expect((await deployer.listCache()).entries).toHaveLength(2);
	});

	it("reports deploy failures through progress events", async () => {
		const events: string[] = [];
		deployer.on("progress", (p) => events.push(p.state));
		const job = deployer.deploy("s", {});
		expect(job.steps).toHaveLength(9);
		expect(job.steps[0]).toMatchObject({ id: "probe", label: "探测服务器", status: "pending" });
		await new Promise<void>((resolve) => {
			deployer.on("progress", (p) => {
				if (p.state !== "running") resolve();
			});
		});
		const final = deployer.getJob("s")!;
		expect(final.state).toBe("error");
		expect(final.steps[0].status).toBe("error");
		expect(final.error).toContain("no ssh in unit tests");
		expect(final.log.at(-1)).toContain("部署失败");
		expect(statusPatches).toContainEqual(["s", { deployState: "deploying" }]);
		expect(statusPatches).toContainEqual(["s", { deployState: undefined }]);
		expect(events[0]).toBe("running");
	});
});
