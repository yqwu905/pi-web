import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
	DEFAULT_HOST_SETTINGS,
	SYNC_ITEMS,
	isPlainObject,
	type CreateServerRequest,
	type HostSettings,
	type ServerAuth,
	type ServerAuthInput,
	type ServerConfig,
	type SyncItemKey,
	type SyncRecord,
	type UpdateServerRequest,
	type WorkspaceConfig,
} from "@pi-web/shared";
import { badRequest } from "./errors.js";
import type { HostPaths, Logger, Store } from "./types.js";

const MAX_SYNC_RECORDS = 1000;

/** Writes `data` to a temp file in the same directory, fsyncs it and renames it over `file`. */
export async function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
	const dir = path.dirname(file);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	const handle = await open(tmp, "w", mode);
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(tmp, file);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

/** Fills fields added after a servers.json entry was written (older entries have no `env`). */
function withServerDefaults(server: ServerConfig): ServerConfig {
	return isPlainObject(server.env) ? server : { ...server, env: {} };
}

/** Serializes async tasks per key (one in-process write queue per file). */
export class KeyedQueue {
	private readonly tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		const next = prev.then(task, task);
		const tail = next.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return next;
	}

	async idle(): Promise<void> {
		while (this.tails.size > 0) {
			await Promise.all([...this.tails.values()]);
		}
	}
}

function readJsonFile<T>(file: string, fallback: T, log?: Logger): T {
	if (!existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch (err) {
		const backup = `${file}.corrupt-${Date.now()}`;
		try {
			renameSync(file, backup);
		} catch {
			// ignore
		}
		log?.error("store file is corrupt; starting empty", { file, backup, error: (err as Error).message });
		return fallback;
	}
}

type StoreFile = "settings" | "servers" | "workspaces" | "history" | "state";

const FILE_NAMES: Record<StoreFile, string> = {
	settings: "settings.json",
	servers: "servers.json",
	workspaces: "workspaces.json",
	history: "sync-history.json",
	state: "state.json",
};

function clone<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

function validateSettings(settings: HostSettings): void {
	const [lo, hi] = settings.proxyPortRange ?? [];
	if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1024 || hi > 65535 || lo > hi) {
		throw badRequest("代理端口范围无效（需在 1024-65535 之间且起始不大于结束）");
	}
	if (!Number.isInteger(settings.listenPort) || settings.listenPort < 1 || settings.listenPort > 65535) {
		throw badRequest("监听端口无效");
	}
	if (!["official", "npmmirror", "custom"].includes(settings.nodeSource)) {
		throw badRequest(`未知的 Node 下载源：${String(settings.nodeSource)}`);
	}
	if (settings.nodeSource === "custom" && !settings.nodeCustomBaseUrl) {
		throw badRequest("自定义下载源需要填写 URL");
	}
	if (settings.piVersionPolicy === "pinned" && !settings.piPinnedVersion) {
		throw badRequest("指定 pi 版本时需要填写版本号");
	}
}

/**
 * Emits "server" (ServerConfig) after a server was saved and "server-deleted" (id)
 * after it was removed, so connections can react to changed settings.
 */
export class JsonStore extends EventEmitter implements Store {
	private settings: Partial<HostSettings>;
	private readonly servers = new Map<string, ServerConfig>();
	private readonly workspaces = new Map<string, WorkspaceConfig>();
	private records: SyncRecord[];
	private readonly state: Record<string, unknown>;
	private readonly queue = new KeyedQueue();
	private readonly queued = new Map<StoreFile, Promise<void>>();

	constructor(
		private readonly dataDir: string,
		private readonly log?: Logger,
	) {
		super();
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		const settings = readJsonFile<unknown>(this.file("settings"), {}, log);
		this.settings = isPlainObject(settings) ? (settings as Partial<HostSettings>) : {};
		const servers = readJsonFile<{ servers?: ServerConfig[] }>(this.file("servers"), {}, log);
		for (const server of servers.servers ?? []) this.servers.set(server.id, withServerDefaults(server));
		const workspaces = readJsonFile<{ workspaces?: WorkspaceConfig[] }>(this.file("workspaces"), {}, log);
		for (const workspace of workspaces.workspaces ?? []) this.workspaces.set(workspace.id, workspace);
		const history = readJsonFile<{ records?: SyncRecord[] }>(this.file("history"), {}, log);
		this.records = Array.isArray(history.records) ? history.records : [];
		const state = readJsonFile<unknown>(this.file("state"), {}, log);
		this.state = isPlainObject(state) ? state : {};
	}

	getSettings(): HostSettings {
		return clone({ ...DEFAULT_HOST_SETTINGS, ...this.settings });
	}

	async updateSettings(patch: Partial<HostSettings>): Promise<HostSettings> {
		const next: Partial<HostSettings> = { ...this.settings };
		for (const [key, value] of Object.entries(patch) as Array<[keyof HostSettings, unknown]>) {
			if (value === undefined || value === null) delete next[key];
			else (next as Record<string, unknown>)[key] = clone(value);
		}
		validateSettings({ ...DEFAULT_HOST_SETTINGS, ...next });
		this.settings = next;
		await this.persist("settings");
		return this.getSettings();
	}

	listServers(): ServerConfig[] {
		return [...this.servers.values()].sort((a, b) => a.createdAt - b.createdAt).map(clone);
	}

	getServer(id: string): ServerConfig | undefined {
		return clone(this.servers.get(id));
	}

	async saveServer(server: ServerConfig): Promise<void> {
		this.servers.set(server.id, clone(server));
		const write = this.persist("servers");
		this.emit("server", clone(server));
		await write;
	}

	async deleteServer(id: string): Promise<void> {
		this.servers.delete(id);
		let workspacesChanged = false;
		for (const workspace of [...this.workspaces.values()]) {
			if (workspace.serverId === id) {
				this.workspaces.delete(workspace.id);
				workspacesChanged = true;
			}
		}
		const writes = Promise.all([this.persist("servers"), workspacesChanged ? this.persist("workspaces") : undefined]);
		this.emit("server-deleted", id);
		await writes;
	}

	listWorkspaces(serverId?: string): WorkspaceConfig[] {
		return [...this.workspaces.values()]
			.filter((w) => serverId === undefined || w.serverId === serverId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(clone);
	}

	getWorkspace(id: string): WorkspaceConfig | undefined {
		return clone(this.workspaces.get(id));
	}

	async saveWorkspace(workspace: WorkspaceConfig): Promise<void> {
		this.workspaces.set(workspace.id, clone(workspace));
		await this.persist("workspaces");
	}

	async deleteWorkspace(id: string): Promise<void> {
		this.workspaces.delete(id);
		await this.persist("workspaces");
	}

	async appendSyncRecord(record: SyncRecord): Promise<void> {
		this.records.push(clone(record));
		if (this.records.length > MAX_SYNC_RECORDS) this.records = this.records.slice(-MAX_SYNC_RECORDS);
		await this.persist("history");
	}

	listSyncRecords(limit?: number): SyncRecord[] {
		const newestFirst = [...this.records].reverse();
		return (limit !== undefined && limit >= 0 ? newestFirst.slice(0, limit) : newestFirst).map(clone);
	}

	getState<T>(key: string): T | undefined {
		return clone(this.state[key] as T | undefined);
	}

	async setState<T>(key: string, value: T): Promise<void> {
		if (value === undefined) delete this.state[key];
		else this.state[key] = clone(value);
		await this.persist("state");
	}

	/** Resolves once every queued write has hit the disk. */
	flush(): Promise<void> {
		return this.queue.idle();
	}

	private file(name: StoreFile): string {
		return path.join(this.dataDir, FILE_NAMES[name]);
	}

	private snapshot(name: StoreFile): unknown {
		switch (name) {
			case "settings":
				return this.settings;
			case "servers":
				return { version: 1, servers: [...this.servers.values()] };
			case "workspaces":
				return { version: 1, workspaces: [...this.workspaces.values()] };
			case "history":
				return { version: 1, records: this.records };
			case "state":
				return this.state;
		}
	}

	private persist(name: StoreFile): Promise<void> {
		// The snapshot is taken when the write starts, so a write that is still queued already
		// covers later changes: callers join it instead of queueing another one.
		const pending = this.queued.get(name);
		if (pending) return pending;
		const write: Promise<void> = this.queue.run(name, async () => {
			if (this.queued.get(name) === write) this.queued.delete(name);
			try {
				await writeFileAtomic(this.file(name), `${JSON.stringify(this.snapshot(name), null, "\t")}\n`);
			} catch (err) {
				this.log?.error("failed to write store file", { file: FILE_NAMES[name], error: (err as Error).message });
				throw err;
			}
		});
		this.queued.set(name, write);
		return write;
	}
}

export function createStore(paths: Pick<HostPaths, "dataDir">, options: { log?: Logger } = {}): JsonStore {
	return new JsonStore(paths.dataDir, options.log);
}

// ---------------------------------------------------------------------------
// ServerConfig helpers
// ---------------------------------------------------------------------------

export function defaultSyncItems(): Record<SyncItemKey, boolean> {
	return Object.fromEntries(SYNC_ITEMS.map((item) => [item.key, item.defaultEnabled])) as Record<SyncItemKey, boolean>;
}

/** Picks a random port in the settings range, avoiding ports already used by other servers. */
export function pickProxyPort(range: [number, number], used: Iterable<number> = []): number {
	const [lo, hi] = range;
	const taken = new Set(used);
	for (let i = 0; i < 64; i++) {
		const port = randomInt(lo, hi + 1);
		if (!taken.has(port)) return port;
	}
	return randomInt(lo, hi + 1);
}

export function normalizeAuth(input: ServerAuthInput, previous?: ServerAuth): ServerAuth {
	const auth: ServerAuth = { method: input.method };
	if (input.method === "key" && input.keyPath?.trim()) auth.keyPath = input.keyPath.trim();
	let hasSecret: boolean;
	if (typeof input.secret === "string") hasSecret = input.secret.length > 0;
	else if (input.secret === null) hasSecret = false;
	else hasSecret = previous ? previous.method === input.method && !!previous.hasSecret : !!input.hasSecret;
	if (input.method !== "agent" && hasSecret) auth.hasSecret = true;
	return auth;
}

/**
 * What to do with the stored secret (`server:<id>:secret`) for an auth input:
 * a string sets it, null clears it, undefined keeps it (cleared when the method changes).
 */
export function secretChange(
	input: ServerAuthInput | undefined,
	previous?: ServerAuth,
): { action: "keep" } | { action: "set"; value: string } | { action: "clear" } {
	if (!input) return { action: "keep" };
	if (input.method === "agent") return previous?.hasSecret ? { action: "clear" } : { action: "keep" };
	if (typeof input.secret === "string") return input.secret ? { action: "set", value: input.secret } : { action: "clear" };
	if (input.secret === null) return { action: "clear" };
	if (previous && previous.method !== input.method && previous.hasSecret) return { action: "clear" };
	return { action: "keep" };
}

export interface CreateServerConfigOptions {
	settings?: HostSettings;
	id?: string;
	now?: number;
	/** Used to avoid handing out a proxy port twice. */
	existingServers?: ServerConfig[];
}

/** Builds a complete ServerConfig from a create request, filling every default. */
export function createServerConfig(input: CreateServerRequest, options: CreateServerConfigOptions = {}): ServerConfig {
	const settings = options.settings ?? DEFAULT_HOST_SETTINGS;
	const now = options.now ?? Date.now();
	if (!input.host?.trim()) throw badRequest("主机地址不能为空");
	if (!input.username?.trim()) throw badRequest("用户名不能为空");
	const port = input.port ?? 22;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest("SSH 端口无效");
	const proxyPort =
		input.proxy?.port ??
		pickProxyPort(
			settings.proxyPortRange,
			(options.existingServers ?? []).map((s) => s.proxy.port),
		);
	const server: ServerConfig = {
		id: options.id ?? randomUUID(),
		name: input.name?.trim() || `${input.username.trim()}@${input.host.trim()}`,
		host: input.host.trim(),
		port,
		username: input.username.trim(),
		auth: normalizeAuth(input.auth),
		jumpServerIds: [...(input.jumpServerIds ?? [])],
		remoteRoot: input.remoteRoot?.trim() || "~/.pi-web",
		agentDirMode: input.agentDirMode ?? "isolated",
		proxy: {
			mode: input.proxy?.mode ?? "tunnel",
			port: proxyPort,
			scope: input.proxy?.scope ?? "llm",
			toolsPolicy: input.proxy?.toolsPolicy ?? "allowlist",
			extraDomains: [...(input.proxy?.extraDomains ?? [])],
			noProxy: [...(input.proxy?.noProxy ?? [])],
		},
		sync: {
			items: { ...defaultSyncItems(), ...(input.sync?.items ?? {}) } as Record<SyncItemKey, boolean>,
			auto: input.sync?.auto ?? true,
			settingsOverride: clone(input.sync?.settingsOverride ?? {}),
		},
		idleTimeoutMin: input.idleTimeoutMin ?? 30,
		defaultTrust: input.defaultTrust ?? "approve",
		env: { ...(input.env ?? {}) },
		createdAt: now,
		updatedAt: now,
	};
	if (input.group?.trim()) server.group = input.group.trim();
	if (input.jumpOnly) server.jumpOnly = true;
	return server;
}

/** Applies an update request to an existing config (nested proxy/sync objects are merged). */
export function mergeServerConfig(existing: ServerConfig, patch: UpdateServerRequest, now = Date.now()): ServerConfig {
	const next: ServerConfig = clone(existing);
	if (patch.name !== undefined) next.name = patch.name.trim() || next.name;
	if (patch.group !== undefined) {
		if (patch.group.trim()) next.group = patch.group.trim();
		else delete next.group;
	}
	if (patch.host !== undefined) next.host = patch.host.trim();
	if (patch.port !== undefined) next.port = patch.port;
	if (patch.username !== undefined) next.username = patch.username.trim();
	if (patch.auth !== undefined) next.auth = normalizeAuth(patch.auth, existing.auth);
	if (patch.jumpServerIds !== undefined) next.jumpServerIds = [...patch.jumpServerIds];
	if (patch.remoteRoot !== undefined) next.remoteRoot = patch.remoteRoot.trim() || "~/.pi-web";
	if (patch.agentDirMode !== undefined) next.agentDirMode = patch.agentDirMode;
	if (patch.proxy !== undefined) next.proxy = { ...next.proxy, ...clone(patch.proxy) };
	if (patch.sync !== undefined) {
		next.sync = {
			items: { ...next.sync.items, ...(patch.sync.items ?? {}) } as Record<SyncItemKey, boolean>,
			auto: patch.sync.auto ?? next.sync.auto,
			settingsOverride: patch.sync.settingsOverride !== undefined ? clone(patch.sync.settingsOverride) : next.sync.settingsOverride,
		};
	}
	if (patch.idleTimeoutMin !== undefined) next.idleTimeoutMin = patch.idleTimeoutMin;
	if (patch.defaultTrust !== undefined) next.defaultTrust = patch.defaultTrust;
	if (patch.env !== undefined) next.env = { ...patch.env };
	if (patch.jumpOnly !== undefined) {
		if (patch.jumpOnly) next.jumpOnly = true;
		else delete next.jumpOnly;
	}
	// A different endpoint has a different host key that must be confirmed again (TOFU).
	if (next.host !== existing.host || next.port !== existing.port) delete next.hostKey;
	next.updatedAt = now;
	return next;
}
