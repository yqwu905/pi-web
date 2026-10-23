import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_HOST_SETTINGS, SYNC_ITEMS, type ServerConfig, type SyncRecord } from "@pi-web/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	JsonStore,
	createServerConfig,
	createStore,
	mergeServerConfig,
	pickProxyPort,
	secretChange,
	writeFileAtomic,
} from "../../src/core/store.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-web-store-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function server(id: string, extra: Partial<ServerConfig> = {}): ServerConfig {
	return { ...createServerConfig({ name: id, host: "h", username: "u", auth: { method: "agent" } }, { id, now: 1 }), ...extra };
}

describe("writeFileAtomic", () => {
	it("writes with the requested mode and leaves no temp files", async () => {
		const file = path.join(dir, "sub", "a.json");
		await writeFileAtomic(file, "hello", 0o600);
		expect(await readFile(file, "utf8")).toBe("hello");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		await writeFileAtomic(file, "again");
		expect(await readFile(file, "utf8")).toBe("again");
		const { readdir } = await import("node:fs/promises");
		expect(await readdir(path.dirname(file))).toEqual(["a.json"]);
	});
});

describe("JsonStore", () => {
	it("returns default settings and persists patches", async () => {
		const store = createStore({ dataDir: dir });
		expect(store.getSettings()).toEqual(DEFAULT_HOST_SETTINGS);
		const updated = await store.updateSettings({ nodeSource: "npmmirror", upstreamProxy: "http://p:3128" });
		expect(updated.nodeSource).toBe("npmmirror");
		const reloaded = new JsonStore(dir);
		expect(reloaded.getSettings().upstreamProxy).toBe("http://p:3128");
		await reloaded.updateSettings({ upstreamProxy: undefined });
		expect(new JsonStore(dir).getSettings().upstreamProxy).toBeUndefined();
	});

	it("validates settings", async () => {
		const store = createStore({ dataDir: dir });
		await expect(store.updateSettings({ proxyPortRange: [5000, 100] })).rejects.toMatchObject({ status: 400 });
		await expect(store.updateSettings({ piVersionPolicy: "pinned" })).rejects.toMatchObject({ status: 400 });
		expect(store.getSettings().proxyPortRange).toEqual(DEFAULT_HOST_SETTINGS.proxyPortRange);
	});

	it("stores servers and workspaces, cascades workspace deletion and returns copies", async () => {
		const store = createStore({ dataDir: dir });
		await store.saveServer(server("a"));
		await store.saveServer(server("b", { createdAt: 0 }));
		await store.saveWorkspace({ id: "w1", serverId: "a", path: "/x", alias: "x", trust: "approve", defaults: {}, env: {}, createdAt: 1 });
		await store.saveWorkspace({ id: "w2", serverId: "b", path: "/y", alias: "y", trust: "approve", defaults: {}, env: {}, createdAt: 2 });
		expect(store.listServers().map((s) => s.id)).toEqual(["b", "a"]);
		const copy = store.getServer("a")!;
		copy.name = "mutated";
		expect(store.getServer("a")!.name).toBe("a");
		expect(store.listWorkspaces("a").map((w) => w.id)).toEqual(["w1"]);
		await store.deleteServer("a");
		const reloaded = new JsonStore(dir);
		expect(reloaded.listServers().map((s) => s.id)).toEqual(["b"]);
		expect(reloaded.listWorkspaces().map((w) => w.id)).toEqual(["w2"]);
	});

	it("keeps the newest 1000 sync records, newest first", async () => {
		const store = createStore({ dataDir: dir });
		const record = (i: number): SyncRecord => ({
			id: String(i),
			serverId: "s",
			at: i,
			trigger: "manual",
			added: 0,
			updated: 0,
			deleted: 0,
			conflicts: 0,
			backedUp: [],
			status: "ok",
			durationMs: 1,
		});
		const writes: Promise<void>[] = [];
		for (let i = 0; i < 1005; i++) writes.push(store.appendSyncRecord(record(i)));
		await Promise.all(writes);
		expect(store.listSyncRecords().length).toBe(1000);
		expect(store.listSyncRecords(2).map((r) => r.id)).toEqual(["1004", "1003"]);
		expect(new JsonStore(dir).listSyncRecords(1)[0].id).toBe("1004");
	});

	it("serializes concurrent writes so the last state wins", async () => {
		const store = createStore({ dataDir: dir });
		await Promise.all(Array.from({ length: 30 }, (_, i) => store.setState("counter", i)));
		await store.flush();
		const onDisk = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
		expect(onDisk.counter).toBe(29);
		await store.setState("counter", undefined);
		expect(new JsonStore(dir).getState("counter")).toBeUndefined();
	});

	it("loads servers saved before the env field existed with an empty env", async () => {
		const legacy: Partial<ServerConfig> = { ...server("old") };
		delete legacy.env;
		await writeFile(path.join(dir, "servers.json"), JSON.stringify({ version: 1, servers: [legacy, server("new", { env: { A: "1" } })] }));
		const store = new JsonStore(dir);
		expect(store.getServer("old")!.env).toEqual({});
		expect(store.getServer("new")!.env).toEqual({ A: "1" });
	});

	it("survives a corrupt file", async () => {
		await writeFile(path.join(dir, "servers.json"), "{not json");
		const store = new JsonStore(dir);
		expect(store.listServers()).toEqual([]);
	});
});

describe("ServerConfig helpers", () => {
	it("fills every default", () => {
		const config = createServerConfig(
			{ name: "", host: " example.com ", username: "dev", auth: { method: "password", secret: "pw" } },
			{ settings: { ...DEFAULT_HOST_SETTINGS, proxyPortRange: [31000, 31010] }, id: "id1", now: 5 },
		);
		expect(config).toMatchObject({
			id: "id1",
			name: "dev@example.com",
			host: "example.com",
			port: 22,
			auth: { method: "password", hasSecret: true },
			jumpServerIds: [],
			remoteRoot: "~/.pi-web",
			agentDirMode: "isolated",
			proxy: { mode: "tunnel", scope: "llm", toolsPolicy: "allowlist", extraDomains: [], noProxy: [] },
			sync: { auto: true, settingsOverride: {} },
			idleTimeoutMin: 30,
			defaultTrust: "approve",
			env: {},
			createdAt: 5,
		});
		expect(config.proxy.port).toBeGreaterThanOrEqual(31000);
		expect(config.proxy.port).toBeLessThanOrEqual(31010);
		for (const item of SYNC_ITEMS) expect(config.sync.items[item.key]).toBe(item.defaultEnabled);
		expect("secret" in config.auth).toBe(false);
	});

	it("rejects missing host", () => {
		expect(() => createServerConfig({ name: "x", host: "", username: "u", auth: { method: "agent" } })).toThrow();
	});

	it("avoids used proxy ports", () => {
		for (let i = 0; i < 20; i++) expect(pickProxyPort([40000, 40001], [40000])).toBe(40001);
	});

	it("merges updates and drops the trusted key when the endpoint changes", () => {
		const base = { ...server("a"), hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:x", trustedAt: 1 } };
		const sameHost = mergeServerConfig(base, { name: "renamed", proxy: { scope: "tools" }, sync: { items: { keybindings: true } } }, 9);
		expect(sameHost.name).toBe("renamed");
		expect(sameHost.proxy.scope).toBe("tools");
		expect(sameHost.proxy.port).toBe(base.proxy.port);
		expect(sameHost.sync.items.keybindings).toBe(true);
		expect(sameHost.sync.items.settings).toBe(true);
		expect(sameHost.hostKey).toBeDefined();
		expect(sameHost.updatedAt).toBe(9);
		expect(mergeServerConfig(base, { host: "other" }).hostKey).toBeUndefined();
	});

	it("takes the env from a create request and replaces the whole map on update", () => {
		const created = createServerConfig({ name: "e", host: "h", username: "u", auth: { method: "agent" }, env: { A: "1", B: "2" } });
		expect(created.env).toEqual({ A: "1", B: "2" });
		expect(mergeServerConfig(created, { name: "renamed" }).env).toEqual({ A: "1", B: "2" });
		expect(mergeServerConfig(created, { env: { C: "3" } }).env).toEqual({ C: "3" });
		expect(mergeServerConfig(created, { env: {} }).env).toEqual({});
	});

	it("derives secret actions", () => {
		expect(secretChange(undefined)).toEqual({ action: "keep" });
		expect(secretChange({ method: "password", secret: "x" })).toEqual({ action: "set", value: "x" });
		expect(secretChange({ method: "password", secret: null })).toEqual({ action: "clear" });
		expect(secretChange({ method: "key" }, { method: "password", hasSecret: true })).toEqual({ action: "clear" });
		expect(secretChange({ method: "key" }, { method: "key", hasSecret: true })).toEqual({ action: "keep" });
	});
});
