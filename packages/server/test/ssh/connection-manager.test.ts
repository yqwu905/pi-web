import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerRuntimeStatus } from "@pi-web/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNullLogger } from "../../src/core/log.js";
import { createSecrets } from "../../src/core/secrets.js";
import { createServerConfig, createStore, type JsonStore } from "../../src/core/store.js";
import { createConnectionManager } from "../../src/ssh/connection-manager.js";

let dir: string;
let store: JsonStore;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-web-cm-"));
	store = createStore({ dataDir: dir });
	await store.saveServer(createServerConfig({ name: "s", host: "127.0.0.1", port: 1, username: "u", auth: { method: "agent" } }, { id: "s" }));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function manager(deployer?: { agentVersion: string; running?: boolean }) {
	return createConnectionManager({
		version: "test",
		log: createNullLogger(),
		store,
		secrets: createSecrets({ dataDir: dir }),
		deployer: deployer
			? {
					agentVersion: deployer.agentVersion,
					buildAgentConfig: async () => {
						throw new Error("unused");
					},
					getJob: () => (deployer.running ? ({ state: "running" } as never) : undefined),
				}
			: undefined,
	});
}

describe("ConnectionManager status", () => {
	it("starts disconnected and merges contributed fields", () => {
		const cm = manager();
		const events: ServerRuntimeStatus[] = [];
		cm.on("status", (s: ServerRuntimeStatus) => events.push(s));
		expect(cm.status("s")).toEqual({
			serverId: "s",
			connection: "disconnected",
			deployState: "not_deployed",
			conversationsRunning: 0,
			conversationsWaiting: 0,
			pendingSync: 0,
		});
		cm.updateStatus("s", { pendingSync: 3, conversationsRunning: 1, connection: "connected", serverId: "x" });
		expect(cm.status("s")).toMatchObject({ serverId: "s", connection: "disconnected", pendingSync: 3, conversationsRunning: 1 });
		cm.updateStatus("s", { pendingSync: 3 });
		expect(events).toHaveLength(1);
		cm.updateStatus("s", { deployState: "deploying", lastSyncAt: 5 });
		expect(cm.status("s").deployState).toBe("deploying");
		cm.updateStatus("s", { deployState: undefined });
		expect(cm.status("s").deployState).toBe("not_deployed");
		expect(cm.status("s").lastSyncAt).toBe(5);
		expect(events).toHaveLength(3);
		expect(cm.allStatuses().map((s) => s.serverId)).toEqual(["s"]);
	});

	it("derives deploy state from the deployer", async () => {
		const server = store.getServer("s")!;
		server.deployed = {
			nodeVersion: "22.20.0",
			piVersion: "1.4.0",
			agentVersion: "0.1.0",
			arch: "x64",
			home: "/h",
			remoteRoot: "/h/.pi-web",
			agentDir: "/h/.pi-web/agent",
			at: 1,
		};
		await store.saveServer(server);
		expect(manager({ agentVersion: "0.1.0" }).status("s").deployState).toBe("deployed");
		expect(manager({ agentVersion: "0.2.0" }).status("s").deployState).toBe("outdated");
		expect(manager({ agentVersion: "" }).status("s").deployState).toBe("deployed");
		expect(manager({ agentVersion: "0.1.0", running: true }).status("s").deployState).toBe("deploying");
	});

	it("rejects unknown servers and invalid fingerprints", async () => {
		const cm = manager();
		expect(() => cm.get("nope")).toThrow(/服务器不存在/);
		await expect(cm.trustHostKey("s", { algorithm: "ssh-ed25519", fingerprint: "md5:aa" })).rejects.toMatchObject({ status: 400 });
		await cm.trustHostKey("s", { algorithm: "ssh-ed25519", fingerprint: "SHA256:7vJbS8D1bF9ld7Nn0E9Gk1fT9o0VvBnS1hX1wJqZ0aQ" });
		expect(store.getServer("s")?.hostKey?.algorithm).toBe("ssh-ed25519");
	});

	it("reports connection failures without throwing from testConnection", async () => {
		const cm = manager();
		const result = await cm.testConnection({ host: "127.0.0.1", port: 1, username: "u", auth: { method: "key", keyPath: "/nonexistent/key" } });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("/nonexistent/key");
		const refused = await cm.testConnection({ host: "127.0.0.1", port: 1, username: "u", auth: { method: "password", secret: "x" } });
		expect(refused).toMatchObject({ ok: false, hostKeyStatus: "unknown" });
		expect(refused.error).toContain("ECONNREFUSED");
		await expect(cm.connect("s")).rejects.toBeDefined();
		expect(cm.status("s").connection).toBe("error");
		await cm.shutdown();
	});
});
