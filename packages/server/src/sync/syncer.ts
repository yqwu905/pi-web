/** Syncer: host agent dir → server agent dirs (one-way, incremental), with auto-sync. */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import {
	isPlainObject,
	SYNC_ITEM_KEYS,
	SYNC_ITEMS,
	type HostInventory,
	type ServerConfig,
	type SyncApplyResult,
	type SyncCellState,
	type SyncItemKey,
	type SyncPlan,
	type SyncRecord,
	type SyncServerStatus,
	type SyncStatusResponse,
	type SyncTopicEvent,
} from "@pi-web/shared";
import { type AgentClient, ApiError, type AppContext, type ServerConnection, type Syncer } from "../core/types.js";
import { buildDesiredTree, type DesiredTree } from "./desired.js";
import { executePlan } from "./executor.js";
import { HashCache, type HashCacheEntry } from "./hash-cache.js";
import { scanInventory } from "./inventory.js";
import { enabledItems, itemForPath } from "./items.js";
import { type ComputedPlan, computePlan } from "./planner.js";
import { transformSettings } from "./transform.js";
import { isWithin } from "./walk.js";

export type SyncerContext = Pick<AppContext, "paths" | "log" | "store" | "hub" | "connections">;

export interface SyncerOptions {
	/** Delay between the last host change and the auto-sync (default 2000ms). */
	debounceMs?: number;
	/** chokidar awaitWriteFinish stability threshold (default 500ms). */
	writeFinishMs?: number;
	/** Host home directory ("~" in settings paths); default os.homedir(). */
	homeDir?: string;
	/** Host Agent Skills directory; default <homeDir>/.agents/skills. */
	agentsSkillsDir?: string;
	usePolling?: boolean;
}

/** Persisted per-server sync state (store key `sync:<serverId>`). */
interface ServerSyncState {
	pending?: boolean;
	pendingItems?: SyncItemKey[];
	lastSyncAt?: number;
	lastChangeAt?: number;
}

interface CachedPlan {
	at: number;
	/** Items whose state this plan describes. */
	known: Set<SyncItemKey>;
	byItem: Map<SyncItemKey, { count: number; conflict: boolean }>;
}

interface Prepared {
	server: ServerConfig;
	connection: ServerConnection;
	client: AgentClient;
	remoteRoot: string;
	items: SyncItemKey[];
	desired: DesiredTree;
	computed: ComputedPlan;
}

const HASH_CACHE_KEY = "syncHashCache";
const MANIFEST_TIMEOUT_MS = 5 * 60_000;
const ALWAYS_RECORDED: ReadonlySet<SyncRecord["trigger"]> = new Set(["manual", "deploy"]);
const WATCH_IGNORED_TOP = new Set(["sessions", "trust.json", "bin", "tools", "external-cache"]);
const SYNCED_TOP = new Set(SYNC_ITEMS.filter((item) => item.key !== "agentsSkills").flatMap((item) => item.paths));

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function backupLabel(now: number, runId: string): string {
	const iso = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `${iso}-${runId.slice(0, 8)}`;
}

function isWatchNoise(name: string): boolean {
	return name === ".DS_Store" || name.endsWith(".log") || name.endsWith(".lock") || name === ".git" || name === "node_modules";
}

class SyncerImpl extends EventEmitter implements Syncer {
	private readonly debounceMs: number;
	private readonly writeFinishMs: number;
	private readonly homeDir: string;
	private readonly agentsSkillsDir: string;
	private readonly hashCache: HashCache;
	private readonly chains = new Map<string, Promise<unknown>>();
	private readonly queued = new Map<string, Promise<SyncRecord>>();
	private readonly running = new Map<string, number>();
	private readonly plans = new Map<string, CachedPlan>();
	private readonly states = new Map<string, ServerSyncState>();
	private readonly planRefreshTimers = new Map<string, NodeJS.Timeout>();
	private readonly lastPublishedStatus = new Map<string, string>();
	private watcher: FSWatcher | undefined;
	private readonly watchedExtra = new Set<string>();
	private changedItems = new Set<SyncItemKey>();
	private debounceTimer: NodeJS.Timeout | undefined;
	private statusTimer: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(
		private readonly ctx: SyncerContext,
		private readonly options: SyncerOptions,
	) {
		super();
		this.debounceMs = options.debounceMs ?? 2000;
		this.writeFinishMs = options.writeFinishMs ?? 500;
		this.homeDir = options.homeDir ?? homedir();
		this.agentsSkillsDir = options.agentsSkillsDir ?? join(this.homeDir, ".agents", "skills");
		this.hashCache = new HashCache({
			load: () => this.ctx.store.getState<Record<string, HashCacheEntry>>(HASH_CACHE_KEY),
			save: (data) => this.ctx.store.setState(HASH_CACHE_KEY, data),
		});
	}

	private get agentDir(): string {
		return this.ctx.paths.hostAgentDir;
	}

	private get log() {
		return this.ctx.log;
	}

	// ---------------------------------------------------------------- public API

	inventory(): Promise<HostInventory> {
		return scanInventory(this.agentDir, this.agentsSkillsDir);
	}

	async status(): Promise<SyncStatusResponse> {
		return this.buildStatus();
	}

	preview(serverId: string): Promise<SyncPlan> {
		if (!this.ctx.store.getServer(serverId)) return Promise.reject(this.notFound());
		return this.serialize(serverId, async () => {
			const prepared = await this.prepare(serverId);
			this.cachePlan(serverId, prepared.items, prepared.computed.plan);
			this.scheduleStatus();
			return prepared.computed.plan;
		});
	}

	run(serverId: string, trigger: SyncRecord["trigger"]): Promise<SyncRecord> {
		if (!this.ctx.store.getServer(serverId)) return Promise.reject(this.notFound());
		const coalesce = trigger === "auto" || trigger === "connect";
		if (coalesce) {
			const queued = this.queued.get(serverId);
			if (queued) return queued;
		}
		const promise = this.serialize(serverId, () => {
			if (this.queued.get(serverId) === promise) this.queued.delete(serverId);
			return this.runNow(serverId, trigger);
		});
		if (coalesce) this.queued.set(serverId, promise);
		return promise;
	}

	async runMany(serverIds: string[] | undefined, trigger: SyncRecord["trigger"]): Promise<SyncRecord[]> {
		const ids = serverIds ?? this.syncableServers().filter((s) => this.isOnline(s.id)).map((s) => s.id);
		return Promise.all(
			ids.map((id) => this.run(id, trigger).catch((err: unknown) => this.errorRecord(id, trigger, Date.now(), err))),
		);
	}

	async pushAuth(serverIds?: string[]): Promise<Array<{ serverId: string; ok: boolean; error?: string }>> {
		const ids = serverIds ?? this.syncableServers().filter((s) => s.sync.items.auth && this.isOnline(s.id)).map((s) => s.id);
		return Promise.all(
			ids.map(async (serverId) => {
				const server = this.ctx.store.getServer(serverId);
				if (!server) return { serverId, ok: false, error: "服务器不存在" };
				if (!server.sync.items.auth) return { serverId, ok: false, error: "该服务器未启用 auth.json 同步" };
				try {
					const record = await this.serialize(serverId, () => this.runNow(serverId, "oauth", ["auth"]));
					return record.status === "ok" ? { serverId, ok: true } : { serverId, ok: false, error: record.error };
				} catch (err) {
					return { serverId, ok: false, error: errorMessage(err) };
				}
			}),
		);
	}

	async start(): Promise<void> {
		this.stopped = false;
		if (this.watcher) return;
		const extra = await this.discoverExtraWatchPaths();
		for (const path of extra) this.watchedExtra.add(path);
		const watcher = watch([this.agentDir, ...this.watchedExtra], {
			ignoreInitial: true,
			persistent: true,
			usePolling: this.options.usePolling,
			awaitWriteFinish: { stabilityThreshold: this.writeFinishMs, pollInterval: 100 },
			ignored: (path: string) => this.isIgnoredWatchPath(path),
		});
		this.watcher = watcher;
		watcher.on("all", (_event, path) => this.onHostChange(path));
		watcher.on("error", (err) => this.log.warn("sync watcher error", { error: errorMessage(err) }));
		await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
		for (const server of this.syncableServers()) {
			const state = this.state(server.id);
			if (state.pending) this.pushRuntimeStatus(server.id);
		}
		this.scheduleStatus();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = undefined;
		if (this.statusTimer) clearTimeout(this.statusTimer);
		this.statusTimer = undefined;
		for (const timer of this.planRefreshTimers.values()) clearTimeout(timer);
		this.planRefreshTimers.clear();
		const watcher = this.watcher;
		this.watcher = undefined;
		this.watchedExtra.clear();
		await watcher?.close();
		await Promise.allSettled([...this.chains.values()]);
		await this.hashCache.flush();
	}

	onAgentConnected(serverId: string): void {
		const server = this.ctx.store.getServer(serverId);
		if (!server || server.jumpOnly) return;
		if (this.state(serverId).pending || server.sync.auto) {
			this.run(serverId, "connect").catch((err: unknown) =>
				this.log.warn("sync on connect failed", { serverId, error: errorMessage(err) }),
			);
		} else {
			// OAuth access tokens may have been refreshed while the server was offline.
			if (server.sync.items.auth) void this.pushAuth([serverId]);
			this.schedulePlanRefresh(serverId, 0);
		}
		this.scheduleStatus();
	}

	lastChangeAt(serverId: string): number | undefined {
		return this.state(serverId).lastChangeAt;
	}

	// ---------------------------------------------------------------- core

	private notFound(): ApiError {
		return new ApiError(404, "SERVER_NOT_FOUND", "服务器不存在");
	}

	private requireServer(serverId: string): ServerConfig {
		const server = this.ctx.store.getServer(serverId);
		if (!server) throw this.notFound();
		return server;
	}

	private serialize<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(serverId) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.chains.set(serverId, settled);
		void settled.then(() => {
			if (this.chains.get(serverId) === settled) this.chains.delete(serverId);
		});
		return next;
	}

	private async agentClient(serverId: string): Promise<{ connection: ServerConnection; client: AgentClient }> {
		try {
			const connection = this.ctx.connections.get(serverId);
			const client = connection.agentClient ?? (await connection.agent());
			return { connection, client };
		} catch (err) {
			if (err instanceof ApiError) throw err;
			throw new ApiError(503, "AGENT_UNAVAILABLE", `无法连接服务器上的 pi-web-agent：${errorMessage(err)}`);
		}
	}

	private async prepare(serverId: string, itemsOverride?: SyncItemKey[]): Promise<Prepared> {
		const server = this.requireServer(serverId);
		const { connection, client } = await this.agentClient(serverId);
		const remoteRoot = client.hello?.remoteRoot || server.deployed?.remoteRoot;
		if (!remoteRoot) throw new ApiError(409, "NOT_DEPLOYED", "服务器尚未部署 pi-web-agent");
		const items = itemsOverride ?? enabledItems(server.sync);
		const settings = this.ctx.store.getSettings();
		const desired = await buildDesiredTree({
			hostAgentDir: this.agentDir,
			homeDir: this.homeDir,
			agentsSkillsDir: this.agentsSkillsDir,
			server,
			items,
			arch: server.deployed?.arch ?? client.hello?.arch,
			noProxy: [...(settings.defaultNoProxy ?? []), ...server.proxy.noProxy],
			hashCache: this.hashCache,
		});
		void this.hashCache.flush();
		this.watchExtra(desired.externalPaths);
		const manifest =
			desired.roots.length > 0
				? await client.call("sync.manifest", { roots: desired.roots }, { timeoutMs: MANIFEST_TIMEOUT_MS })
				: { agentDir: "", files: {}, managed: {} };
		const computed = computePlan(serverId, desired, manifest);
		return { server, connection, client, remoteRoot, items, desired, computed };
	}

	private async runNow(serverId: string, trigger: SyncRecord["trigger"], itemsOverride?: SyncItemKey[]): Promise<SyncRecord> {
		const startedAt = Date.now();
		const runId = randomUUID();
		this.setRunning(serverId, 1);
		let record: SyncRecord;
		let scope: SyncItemKey[] | undefined = itemsOverride;
		try {
			const prepared = await this.prepare(serverId, itemsOverride);
			scope = prepared.items;
			const { computed } = prepared;
			let result: SyncApplyResult = { written: 0, deleted: 0, backedUp: [], errors: [] };
			if (computed.writes.length > 0 || computed.deletes.length > 0) {
				result = await executePlan({
					computed,
					connection: prepared.connection,
					client: prepared.client,
					remoteRoot: prepared.remoteRoot,
					tmpDir: this.ctx.paths.tmpDir,
					runId,
					backupLabel: backupLabel(startedAt, runId),
				});
			}
			record = this.recordFrom(serverId, trigger, runId, startedAt, computed, result);
			this.cachePlan(serverId, prepared.items, {
				...computed.plan,
				entries: computed.plan.entries.filter((entry) => result.errors.some((e) => e.path === entry.path)),
			});
			const now = Date.now();
			const state = this.state(serverId);
			const next: ServerSyncState = { ...state, lastSyncAt: now };
			if (result.written + result.deleted > 0) next.lastChangeAt = now;
			if (record.status === "ok") {
				const remaining = (state.pendingItems ?? []).filter((item) => !prepared.items.includes(item));
				next.pendingItems = remaining;
				next.pending = remaining.length > 0;
			}
			await this.saveState(serverId, next);
			if (result.written + result.deleted > 0) {
				this.emitEvent({ kind: "configUpdated", serverId, at: now });
			}
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) {
				this.setRunning(serverId, -1);
				throw err;
			}
			record = this.errorRecord(serverId, trigger, startedAt, err, runId);
			const server = this.ctx.store.getServer(serverId);
			if (trigger !== "manual" && server) await this.markPending(serverId, scope ?? enabledItems(server.sync));
		}
		this.setRunning(serverId, -1);
		const changed = record.added + record.updated + record.deleted > 0;
		if (ALWAYS_RECORDED.has(trigger) || changed || record.status === "error") {
			await this.ctx.store.appendSyncRecord(record).catch((err: unknown) =>
				this.log.warn("failed to store sync record", { serverId, error: errorMessage(err) }),
			);
			this.emitEvent({ kind: "record", record });
		}
		if (record.status === "error") this.log.warn("sync failed", { serverId, trigger, error: record.error });
		else if (changed) this.log.info("sync applied", { serverId, trigger, added: record.added, updated: record.updated, deleted: record.deleted });
		this.pushRuntimeStatus(serverId);
		this.scheduleStatus();
		return record;
	}

	private recordFrom(
		serverId: string,
		trigger: SyncRecord["trigger"],
		id: string,
		startedAt: number,
		computed: ComputedPlan,
		result: SyncApplyResult,
	): SyncRecord {
		const failed = new Set(result.errors.map((e) => e.path));
		const ok = computed.plan.entries.filter((entry) => !failed.has(entry.path));
		const record: SyncRecord = {
			id,
			serverId,
			at: startedAt,
			trigger,
			added: ok.filter((e) => e.action === "add").length,
			updated: ok.filter((e) => e.action === "update").length,
			deleted: ok.filter((e) => e.action === "delete").length,
			conflicts: ok.filter((e) => e.conflict).length,
			backedUp: result.backedUp ?? [],
			status: result.errors.length > 0 ? "error" : "ok",
			durationMs: Date.now() - startedAt,
		};
		if (result.errors.length > 0) {
			const first = result.errors[0];
			record.error = `${result.errors.length} 个文件同步失败（${first.path}：${first.error}）`;
		}
		return record;
	}

	private errorRecord(serverId: string, trigger: SyncRecord["trigger"], startedAt: number, err: unknown, id = randomUUID()): SyncRecord {
		return {
			id,
			serverId,
			at: startedAt,
			trigger,
			added: 0,
			updated: 0,
			deleted: 0,
			conflicts: 0,
			backedUp: [],
			status: "error",
			error: err instanceof ApiError ? err.message : `同步失败：${errorMessage(err)}`,
			durationMs: Date.now() - startedAt,
		};
	}

	// ---------------------------------------------------------------- state & status

	private syncableServers(): ServerConfig[] {
		return this.ctx.store.listServers().filter((server) => !server.jumpOnly);
	}

	private isOnline(serverId: string): boolean {
		try {
			return Boolean(this.ctx.connections.get(serverId).agentClient);
		} catch {
			return false;
		}
	}

	private state(serverId: string): ServerSyncState {
		let state = this.states.get(serverId);
		if (!state) {
			state = this.ctx.store.getState<ServerSyncState>(`sync:${serverId}`) ?? {};
			this.states.set(serverId, state);
		}
		return state;
	}

	private async saveState(serverId: string, state: ServerSyncState): Promise<void> {
		this.states.set(serverId, state);
		await this.ctx.store.setState(`sync:${serverId}`, state).catch((err: unknown) =>
			this.log.warn("failed to persist sync state", { serverId, error: errorMessage(err) }),
		);
	}

	private async markPending(serverId: string, items: readonly SyncItemKey[]): Promise<void> {
		const state = this.state(serverId);
		const pendingItems = [...new Set([...(state.pendingItems ?? []), ...items])];
		await this.saveState(serverId, { ...state, pending: true, pendingItems });
		this.pushRuntimeStatus(serverId);
	}

	private setRunning(serverId: string, delta: number): void {
		const before = this.running.get(serverId) ?? 0;
		const after = Math.max(0, before + delta);
		if (after === 0) this.running.delete(serverId);
		else this.running.set(serverId, after);
		if ((before > 0) !== (after > 0)) {
			this.emitEvent({ kind: "running", serverId, running: after > 0 });
		}
	}

	private cachePlan(serverId: string, items: readonly SyncItemKey[], plan: SyncPlan): void {
		const previous = this.plans.get(serverId);
		const known = new Set(previous?.known ?? []);
		const byItem = new Map(previous?.byItem ?? []);
		for (const item of items) {
			known.add(item);
			byItem.delete(item);
		}
		for (const entry of plan.entries) {
			const info = byItem.get(entry.item) ?? { count: 0, conflict: false };
			info.count++;
			info.conflict ||= entry.conflict;
			byItem.set(entry.item, info);
		}
		this.plans.set(serverId, { at: plan.generatedAt, known, byItem });
	}

	private invalidatePlan(serverId: string, items: Iterable<SyncItemKey>): void {
		const plan = this.plans.get(serverId);
		if (!plan) return;
		for (const item of items) {
			plan.known.delete(item);
			plan.byItem.delete(item);
		}
	}

	private serverStatus(server: ServerConfig): SyncServerStatus {
		const state = this.state(server.id);
		const plan = this.plans.get(server.id);
		const pendingItems = new Set(state.pending ? (state.pendingItems ?? []) : []);
		const items = {} as Record<SyncItemKey, SyncCellState>;
		let pendingCount = 0;
		for (const key of SYNC_ITEM_KEYS) {
			let cell: SyncCellState;
			if (!server.sync.items[key]) {
				cell = "disabled";
			} else if (plan?.known.has(key)) {
				const info = plan.byItem.get(key);
				cell = info ? (info.conflict ? "conflict" : "pending") : "synced";
				pendingCount += info?.count ?? 0;
				if (!info && pendingItems.has(key)) cell = "pending";
			} else {
				cell = pendingItems.has(key) ? "pending" : "unknown";
			}
			if (cell === "pending" && !plan?.byItem.has(key)) pendingCount++;
			items[key] = cell;
		}
		const status: SyncServerStatus = {
			serverId: server.id,
			online: this.isOnline(server.id),
			auto: server.sync.auto,
			running: this.running.has(server.id),
			items,
			pendingCount,
		};
		if (state.lastSyncAt) status.lastSyncAt = state.lastSyncAt;
		return status;
	}

	private buildStatus(): SyncStatusResponse {
		return {
			hostAgentDir: this.agentDir,
			watching: Boolean(this.watcher),
			servers: this.syncableServers().map((server) => this.serverStatus(server)),
		};
	}

	private pushRuntimeStatus(serverId: string): void {
		const server = this.ctx.store.getServer(serverId);
		if (!server) return;
		const status = this.serverStatus(server);
		const patch = { pendingSync: status.pendingCount, lastSyncAt: status.lastSyncAt };
		const key = JSON.stringify(patch);
		if (this.lastPublishedStatus.get(serverId) === key) return;
		this.lastPublishedStatus.set(serverId, key);
		try {
			this.ctx.connections.updateStatus(serverId, patch);
		} catch (err) {
			this.log.debug("updateStatus failed", { serverId, error: errorMessage(err) });
		}
	}

	private scheduleStatus(): void {
		if (this.statusTimer) return;
		this.statusTimer = setTimeout(() => {
			this.statusTimer = undefined;
			const status = this.buildStatus();
			for (const server of status.servers) this.pushRuntimeStatus(server.serverId);
			this.emitEvent({ kind: "status", status });
		}, 50);
		this.statusTimer.unref?.();
	}

	private emitEvent(event: SyncTopicEvent): void {
		switch (event.kind) {
			case "status":
				this.emit("status", event.status);
				break;
			case "record":
				this.emit("record", event.record);
				break;
			case "running":
				this.emit("running", { serverId: event.serverId, running: event.running });
				break;
			case "configUpdated":
				this.emit("configUpdated", { serverId: event.serverId, at: event.at });
				break;
		}
		try {
			this.ctx.hub.publish("sync", event);
		} catch (err) {
			this.log.debug("hub publish failed", { error: errorMessage(err) });
		}
	}

	private schedulePlanRefresh(serverId: string, delayMs = 500): void {
		if (this.stopped || this.planRefreshTimers.has(serverId)) return;
		const timer = setTimeout(() => {
			this.planRefreshTimers.delete(serverId);
			if (this.stopped || !this.isOnline(serverId)) return;
			this.preview(serverId).catch((err: unknown) =>
				this.log.debug("background sync plan failed", { serverId, error: errorMessage(err) }),
			);
		}, delayMs);
		timer.unref?.();
		this.planRefreshTimers.set(serverId, timer);
	}

	// ---------------------------------------------------------------- watcher

	private isIgnoredWatchPath(path: string): boolean {
		if (isWithin(this.agentDir, path)) {
			const rel = relative(this.agentDir, path);
			if (rel === "") return false;
			const parts = rel.split("/");
			if (WATCH_IGNORED_TOP.has(parts[0]) || !SYNCED_TOP.has(parts[0])) return true;
			return parts.some((part) => isWatchNoise(part));
		}
		for (const root of this.watchedExtra) {
			if (!isWithin(root, path)) continue;
			const rel = relative(root, path);
			return rel !== "" && rel.split("/").some((part) => isWatchNoise(part));
		}
		return isWatchNoise(basename(path));
	}

	private itemForHostPath(path: string): SyncItemKey | undefined {
		if (isWithin(this.agentDir, path)) return itemForPath(relative(this.agentDir, path));
		if (isWithin(this.agentsSkillsDir, path)) return "agentsSkills";
		for (const root of this.watchedExtra) if (isWithin(root, path)) return "settings";
		return undefined;
	}

	private onHostChange(path: string): void {
		if (this.stopped) return;
		const item = this.itemForHostPath(path);
		if (!item) return;
		this.changedItems.add(item);
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			void this.flushHostChanges();
		}, this.debounceMs);
		this.debounceTimer.unref?.();
	}

	private async flushHostChanges(): Promise<void> {
		const changed = this.changedItems;
		this.changedItems = new Set();
		if (changed.size === 0 || this.stopped) return;
		if (changed.has("settings")) this.watchExtra(await this.discoverExtraWatchPaths());
		for (const server of this.syncableServers()) {
			const relevant = enabledItems(server.sync).filter((item) => changed.has(item));
			if (relevant.length === 0) continue;
			const online = this.isOnline(server.id);
			if (!online && !server.deployed) continue;
			this.invalidatePlan(server.id, relevant);
			if (server.sync.auto) {
				if (online) {
					this.run(server.id, "auto").catch((err: unknown) =>
						this.log.warn("auto sync failed", { serverId: server.id, error: errorMessage(err) }),
					);
				} else {
					await this.markPending(server.id, relevant);
				}
			} else if (online) {
				this.schedulePlanRefresh(server.id);
			}
		}
		this.scheduleStatus();
	}

	private watchExtra(paths: readonly string[]): void {
		const added = paths.filter((path) => !this.watchedExtra.has(path) && !isWithin(this.agentDir, path));
		if (added.length === 0) return;
		for (const path of added) this.watchedExtra.add(path);
		this.watcher?.add(added);
	}

	/** External settings paths and ~/.agents/skills, computed from the host settings alone. */
	private async discoverExtraWatchPaths(): Promise<string[]> {
		const paths: string[] = [];
		if (this.syncableServers().some((server) => server.sync.items.agentsSkills)) paths.push(this.agentsSkillsDir);
		try {
			const raw = JSON.parse(await readFile(join(this.agentDir, "settings.json"), "utf8")) as unknown;
			if (isPlainObject(raw)) {
				const { externals } = transformSettings(raw, {
					hostAgentDir: this.agentDir,
					homeDir: this.homeDir,
					server: {
						proxy: { mode: "off", port: 0, scope: "llm", toolsPolicy: "allowlist", extraDomains: [], noProxy: [] },
						sync: { items: {} as Record<SyncItemKey, boolean>, auto: false, settingsOverride: {} },
					},
				});
				for (const ref of externals) paths.push(ref.abs);
			}
		} catch {
			// no or invalid settings.json: nothing external to watch
		}
		return paths;
	}
}

export function createSyncer(ctx: SyncerContext, options: SyncerOptions = {}): Syncer {
	return new SyncerImpl(ctx, options);
}
