import { lstat, readdir, readlink, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncRecord } from "@pi-web/shared";
import { ApiError, type ConnectionManager, type Syncer } from "../../src/core/types.js";
import { createSyncer, type SyncerOptions } from "../../src/sync/syncer.js";
import {
	FakeAgentClient,
	FakeConnection,
	FakeConnections,
	FakeHub,
	FakeRemote,
	MemoryStore,
	makePaths,
	makeServer,
	noopLogger,
	put,
	tempDir,
	waitFor,
} from "./fakes.js";

interface Env {
	home: string;
	agentDir: string;
	dataDir: string;
	store: MemoryStore;
	hub: FakeHub;
	connections: FakeConnections;
	remote: FakeRemote;
	connection: FakeConnection;
	syncer: Syncer;
	events: Array<{ name: string; data: unknown }>;
}

const syncers: Syncer[] = [];
afterEach(async () => {
	await Promise.all(syncers.splice(0).map((s) => s.stop()));
});

async function setup(options: SyncerOptions = {}, serverOverrides: Parameters<typeof makeServer>[0] = {}): Promise<Env> {
	const home = await tempDir("piweb-home-");
	const agentDir = join(home, ".pi", "agent");
	const dataDir = join(home, "data");
	await put(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "m", shellPath: "/bin/zsh" }));
	await put(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "acc-1", refresh: "host-refresh", expires: 1 }, openai: { type: "api_key", key: "sk-1" } }));
	await put(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
	await put(join(agentDir, "extensions", "a.ts"), "export default function () {}", 0o644);
	await put(join(agentDir, "extensions", "bin", "run.sh"), "#!/bin/sh\necho hi\n", 0o755);
	await symlink("a.ts", join(agentDir, "extensions", "alias.ts"));
	await put(join(agentDir, "prompts", "review.md"), "Review this");
	await put(join(agentDir, "sessions", "s.jsonl"), "{}");

	const server = makeServer({
		deployed: { nodeVersion: "22.20.0", piVersion: "1.4.0", agentVersion: "0.1.0", arch: "x64", home, remoteRoot: "/unused", agentDir: "/unused/agent", at: 1 },
		...serverOverrides,
	});
	const store = new MemoryStore([server]);
	const hub = new FakeHub();
	const connections = new FakeConnections();
	const remote = await FakeRemote.create();
	const connection = new FakeConnection(server.id, new FakeAgentClient(server.id, remote));
	connections.add(connection);
	const syncer = createSyncer(
		{
			paths: makePaths(agentDir, dataDir),
			log: noopLogger,
			store,
			hub,
			connections: connections as unknown as ConnectionManager,
		},
		{ homeDir: home, debounceMs: 150, writeFinishMs: 50, ...options },
	);
	syncers.push(syncer);
	const events: Env["events"] = [];
	for (const name of ["status", "record", "running", "configUpdated"]) syncer.on(name, (data: unknown) => events.push({ name, data }));
	return { home, agentDir, dataDir, store, hub, connections, remote, connection, syncer, events };
}

function applyCalls(env: Env) {
	return env.remote.calls.filter((c) => c.method === "sync.apply");
}

describe("Syncer run", () => {
	it("syncs the host agent dir to the server and records the run", async () => {
		const env = await setup();
		const record = await env.syncer.run("s1", "manual");
		expect(record).toMatchObject({ serverId: "s1", trigger: "manual", status: "ok", updated: 0, deleted: 0, conflicts: 0 });
		expect(record.added).toBe(7);

		const settings = JSON.parse(await env.remote.read("settings.json"));
		expect(settings).toMatchObject({ defaultModel: "m", transport: "sse" });
		expect(settings).not.toHaveProperty("shellPath");
		const auth = JSON.parse(await env.remote.read("auth.json"));
		expect(auth.anthropic).toEqual({ type: "oauth", access: "acc-1", refresh: "pi-web-managed", expires: 1 });
		expect(auth.openai.key).toBe("sk-1");
		expect((await stat(join(env.remote.agentDir, "auth.json"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(env.remote.agentDir, "extensions/bin/run.sh"))).mode & 0o777).toBe(0o755);
		expect(await readlink(join(env.remote.agentDir, "extensions/alias.ts"))).toBe("a.ts");
		expect(await env.remote.read("prompts/review.md")).toBe("Review this");
		expect(await env.remote.exists("sessions")).toBe(false);

		expect(env.connection.uploads).toHaveLength(1);
		expect(env.connection.uploads[0].remote).toBe(join(env.remote.root, "state", "incoming", `${record.id}.tar.gz`));
		expect(await readdir(join(env.dataDir, "cache", "tmp"))).toEqual([]);

		expect(env.store.records[0]).toEqual(record);
		expect(env.syncer.lastChangeAt("s1")).toBeGreaterThanOrEqual(record.at);
		const names = env.events.map((e) => e.name);
		expect(names).toContain("record");
		expect(names).toContain("configUpdated");
		expect(env.events.filter((e) => e.name === "running").map((e) => (e.data as { running: boolean }).running)).toEqual([true, false]);
		expect(env.hub.topic("sync").some((e) => (e as { kind: string }).kind === "record")).toBe(true);
		await waitFor(() => env.connections.lastPatch("s1")?.lastSyncAt !== undefined);
		expect(env.connections.lastPatch("s1")).toMatchObject({ pendingSync: 0 });
	});

	it("is a no-op when nothing changed", async () => {
		const env = await setup();
		await env.syncer.run("s1", "manual");
		const changedAt = env.syncer.lastChangeAt("s1");
		env.events.length = 0;
		const second = await env.syncer.run("s1", "manual");
		expect(second).toMatchObject({ status: "ok", added: 0, updated: 0, deleted: 0 });
		expect(env.connection.uploads).toHaveLength(1);
		expect(applyCalls(env)).toHaveLength(1);
		expect(env.syncer.lastChangeAt("s1")).toBe(changedAt);
		expect(env.events.some((e) => e.name === "configUpdated")).toBe(false);
		// auto runs without changes are not recorded in the history
		await env.syncer.run("s1", "auto");
		expect(env.store.records).toHaveLength(2);
	});

	it("deletes host-deleted files, backs up remote edits and keeps server-local files", async () => {
		const env = await setup();
		await env.syncer.run("s1", "manual");
		await unlink(join(env.agentDir, "extensions", "bin", "run.sh"));
		await writeFile(join(env.agentDir, "extensions", "a.ts"), "export default 2;");
		await writeFile(join(env.remote.agentDir, "extensions", "a.ts"), "edited on server");
		await writeFile(join(env.remote.agentDir, "extensions", "server-only.ts"), "mine");

		const plan = await env.syncer.preview("s1");
		expect(plan.entries).toEqual([
			expect.objectContaining({ path: "extensions/a.ts", action: "update", conflict: true }),
			expect.objectContaining({ path: "extensions/bin/run.sh", action: "delete", conflict: false }),
		]);
		const record = await env.syncer.run("s1", "manual");
		expect(record).toMatchObject({ updated: 1, deleted: 1, conflicts: 1, backedUp: ["extensions/a.ts"] });
		expect(await env.remote.read("extensions/a.ts")).toBe("export default 2;");
		expect(await env.remote.exists("extensions/bin")).toBe(false);
		expect(await env.remote.read("extensions/server-only.ts")).toBe("mine");
		const backups = await readdir(join(env.remote.root, "state", "backup"));
		expect(backups).toHaveLength(1);
	});

	it("never deletes files of disabled items", async () => {
		const env = await setup();
		await env.syncer.run("s1", "manual");
		const server = env.store.getServer("s1")!;
		server.sync.items.prompts = false;
		await unlink(join(env.agentDir, "prompts", "review.md"));
		const record = await env.syncer.run("s1", "manual");
		expect(record.deleted).toBe(0);
		expect(await env.remote.read("prompts/review.md")).toBe("Review this");
		const status = await env.syncer.status();
		expect(status.servers[0].items.prompts).toBe("disabled");
	});

	it("reports plan state in the status matrix", async () => {
		const env = await setup();
		const before = await env.syncer.status();
		expect(before.servers[0].items.settings).toBe("unknown");
		expect(before.servers[0].items.agentsSkills).toBe("disabled");
		const plan = await env.syncer.preview("s1");
		expect(plan.summary.add).toBe(7);
		const status = await env.syncer.status();
		expect(status.servers[0]).toMatchObject({ serverId: "s1", online: true, auto: true, running: false });
		expect(status.servers[0].items).toMatchObject({ settings: "pending", extensions: "pending", mcp: "synced", keybindings: "disabled" });
		expect(status.servers[0].pendingCount).toBe(7);
		await env.syncer.run("s1", "manual");
		const after = await env.syncer.status();
		expect(after.servers[0].items).toMatchObject({ settings: "synced", extensions: "synced" });
		expect(after.servers[0].pendingCount).toBe(0);
		expect(after.servers[0].lastSyncAt).toBeGreaterThan(0);
	});

	it("serializes runs per server", async () => {
		const env = await setup();
		env.remote.applyDelayMs = 150;
		await writeFile(join(env.agentDir, "prompts", "two.md"), "2");
		const [a, b] = await Promise.all([env.syncer.run("s1", "manual"), env.syncer.run("s1", "manual")]);
		expect(a.added).toBe(8);
		expect(b.added).toBe(0);
		expect(env.remote.calls.map((c) => c.method)).toEqual(["sync.manifest", "sync.apply", "sync.manifest"]);
	});

	it("pushes only auth.json with the oauth trigger", async () => {
		const env = await setup();
		await env.syncer.run("s1", "manual");
		await writeFile(join(env.agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "acc-2", refresh: "host-refresh-2", expires: 2 } }));
		await writeFile(join(env.agentDir, "prompts", "new.md"), "not pushed");
		const results = await env.syncer.pushAuth();
		expect(results).toEqual([{ serverId: "s1", ok: true }]);
		const auth = JSON.parse(await env.remote.read("auth.json"));
		expect(auth).toEqual({ anthropic: { type: "oauth", access: "acc-2", refresh: "pi-web-managed", expires: 2 } });
		expect(await env.remote.exists("prompts/new.md")).toBe(false);
		const manifest = env.remote.calls.filter((c) => c.method === "sync.manifest").at(-1)!;
		expect(manifest.params).toEqual({ roots: ["auth.json"] });
		expect(env.store.records[0]).toMatchObject({ trigger: "oauth", updated: 1, status: "ok" });

		env.store.getServer("s1")!.sync.items.auth = false;
		expect(await env.syncer.pushAuth()).toEqual([]);
		expect(await env.syncer.pushAuth(["s1"])).toEqual([{ serverId: "s1", ok: false, error: expect.any(String) }]);
	});

	it("rejects unknown servers and records agent failures", async () => {
		const env = await setup();
		await expect(env.syncer.run("nope", "manual")).rejects.toBeInstanceOf(ApiError);
		env.connection.setOnline(false);
		const record = await env.syncer.run("s1", "manual");
		expect(record.status).toBe("error");
		expect(record.error).toContain("pi-web-agent");
		expect(env.store.records[0]).toEqual(record);
		const [many] = await env.syncer.runMany(["s1"], "manual");
		expect(many.status).toBe("error");
		expect(await env.syncer.runMany(undefined, "manual")).toEqual([]);
	});
});

describe("Syncer auto-sync", { timeout: 20_000 }, () => {
	it("debounces host changes into a single auto run", async () => {
		const env = await setup();
		await env.syncer.run("s1", "manual");
		await env.syncer.start();
		expect((await env.syncer.status()).watching).toBe(true);
		const applies = applyCalls(env).length;
		for (let i = 0; i < 4; i++) {
			await writeFile(join(env.agentDir, "prompts", `p${i}.md`), `prompt ${i}`);
			await new Promise((r) => setTimeout(r, 40));
		}
		// Ignored paths never trigger a sync.
		await put(join(env.agentDir, "sessions", "other.jsonl"), "{}");
		await waitFor(() => env.store.records.some((r: SyncRecord) => r.trigger === "auto"), 8000);
		await new Promise((r) => setTimeout(r, 400));
		const autos = env.store.records.filter((r) => r.trigger === "auto");
		expect(autos).toHaveLength(1);
		expect(autos[0].added).toBe(4);
		expect(applyCalls(env).length).toBe(applies + 1);
		expect(await env.remote.read("prompts/p3.md")).toBe("prompt 3");
	});

	it("marks offline servers pending and catches up on connect", async () => {
		const env = await setup();
		await env.syncer.run("s1", "manual");
		env.connection.setOnline(false);
		await env.syncer.start();
		await writeFile(join(env.agentDir, "prompts", "offline.md"), "queued");
		await waitFor(async () => (await env.syncer.status()).servers[0].items.prompts === "pending", 8000);
		expect(env.store.getState<{ pending: boolean; pendingItems: string[] }>("sync:s1")).toMatchObject({ pending: true, pendingItems: ["prompts"] });
		await waitFor(() => (env.connections.lastPatch("s1")?.pendingSync ?? 0) > 0);

		env.connection.setOnline(true);
		env.syncer.onAgentConnected("s1");
		await waitFor(() => env.store.records.some((r) => r.trigger === "connect"), 8000);
		expect(env.store.records[0]).toMatchObject({ trigger: "connect", added: 1, status: "ok" });
		expect(await env.remote.read("prompts/offline.md")).toBe("queued");
		expect(env.store.getState<{ pending: boolean }>("sync:s1")?.pending).toBe(false);
		await waitFor(async () => (await env.syncer.status()).servers[0].items.prompts === "synced");
	});

	it("pushes auth.json on connect for servers without auto-sync", async () => {
		const env = await setup();
		env.store.getServer("s1")!.sync.auto = false;
		await env.syncer.run("s1", "manual");
		await writeFile(join(env.agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "fresh", refresh: "r", expires: 9 } }));
		await writeFile(join(env.agentDir, "prompts", "later.md"), "not yet");
		env.syncer.onAgentConnected("s1");
		await waitFor(() => env.store.records.some((r) => r.trigger === "oauth"));
		expect(JSON.parse(await env.remote.read("auth.json")).anthropic.access).toBe("fresh");
		expect(await env.remote.exists("prompts/later.md")).toBe(false);
		await waitFor(async () => (await env.syncer.status()).servers[0].items.prompts === "pending");
	});

	it("only refreshes the plan for servers without auto-sync", async () => {
		const env = await setup();
		env.store.getServer("s1")!.sync.auto = false;
		await env.syncer.run("s1", "manual");
		env.syncer.onAgentConnected("s1");
		await env.syncer.start();
		await writeFile(join(env.agentDir, "prompts", "manual.md"), "x");
		await waitFor(async () => (await env.syncer.status()).servers[0].items.prompts === "pending", 8000);
		expect(env.store.records.filter((r) => r.trigger !== "manual")).toEqual([]);
		expect(await env.remote.exists("prompts/manual.md")).toBe(false);
		await lstat(join(env.agentDir, "prompts", "manual.md"));
	});
});
