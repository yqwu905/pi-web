/** In-memory fakes of the host services the sync/proxy/oauth modules depend on. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	DEFAULT_HOST_SETTINGS,
	SYNC_ITEMS,
	type AgentHelloResult,
	type HostSettings,
	type ServerConfig,
	type ServerRuntimeStatus,
	type SyncApplyParams,
	type SyncApplyResult,
	type SyncFileInfo,
	type SyncItemKey,
	type SyncManifestParams,
	type SyncManifestResult,
	type SyncRecord,
	type WorkspaceConfig,
} from "@pi-web/shared";
import type { EventHub, HostPaths, Logger, Store } from "../../src/core/types.js";

const execFileAsync = promisify(execFile);

export const noopLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	child() {
		return noopLogger;
	},
};

export async function tempDir(prefix = "piweb-test-"): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
	const items = Object.fromEntries(SYNC_ITEMS.map((item) => [item.key, item.defaultEnabled])) as Record<SyncItemKey, boolean>;
	return {
		id: "s1",
		name: "server-1",
		host: "example.test",
		port: 22,
		username: "dev",
		auth: { method: "agent" },
		jumpServerIds: [],
		remoteRoot: "~/.pi-web",
		agentDirMode: "isolated",
		proxy: { mode: "tunnel", port: 38412, scope: "llm", toolsPolicy: "allowlist", extraDomains: [], noProxy: [] },
		sync: { items, auto: true, settingsOverride: {} },
		idleTimeoutMin: 30,
		defaultTrust: "no-approve",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

export class MemoryStore implements Store {
	settings: HostSettings = { ...DEFAULT_HOST_SETTINGS };
	servers = new Map<string, ServerConfig>();
	records: SyncRecord[] = [];
	state = new Map<string, unknown>();

	constructor(servers: ServerConfig[] = []) {
		for (const server of servers) this.servers.set(server.id, server);
	}
	getSettings(): HostSettings {
		return this.settings;
	}
	async updateSettings(patch: Partial<HostSettings>): Promise<HostSettings> {
		this.settings = { ...this.settings, ...patch };
		return this.settings;
	}
	listServers(): ServerConfig[] {
		return [...this.servers.values()];
	}
	getServer(id: string): ServerConfig | undefined {
		return this.servers.get(id);
	}
	async saveServer(server: ServerConfig): Promise<void> {
		this.servers.set(server.id, structuredClone(server));
	}
	async deleteServer(id: string): Promise<void> {
		this.servers.delete(id);
	}
	listWorkspaces(): WorkspaceConfig[] {
		return [];
	}
	getWorkspace(): WorkspaceConfig | undefined {
		return undefined;
	}
	async saveWorkspace(): Promise<void> {}
	async deleteWorkspace(): Promise<void> {}
	async appendSyncRecord(record: SyncRecord): Promise<void> {
		this.records.unshift(record);
	}
	listSyncRecords(limit = 100): SyncRecord[] {
		return this.records.slice(0, limit);
	}
	getState<T>(key: string): T | undefined {
		return this.state.get(key) as T | undefined;
	}
	async setState<T>(key: string, value: T): Promise<void> {
		this.state.set(key, structuredClone(value));
	}
}

export class FakeHub implements EventHub {
	published: Array<{ topic: string; data: unknown }> = [];
	publish(topic: string, data: unknown): void {
		this.published.push({ topic, data: structuredClone(data) });
	}
	subscriberCount(): number {
		return 1;
	}
	topic(topic: string): unknown[] {
		return this.published.filter((p) => p.topic === topic).map((p) => p.data);
	}
}

export function makePaths(hostAgentDir: string, dataDir: string): HostPaths {
	return {
		dataDir,
		cacheDir: join(dataDir, "cache"),
		tmpDir: join(dataDir, "cache", "tmp"),
		logsDir: join(dataDir, "logs"),
		hostAgentDir,
		agentDistDir: join(dataDir, "agent"),
		webDistDir: null,
	};
}

// ---------------------------------------------------------------------------
// Fake remote agent: implements sync.manifest / sync.apply on a local directory.
// ---------------------------------------------------------------------------

const MANIFEST_SKIP_TOP = new Set(["sessions", "trust.json", "bin", "tools", "external-cache"]);

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function within(root: string, path: string): boolean {
	return path === root || path.startsWith(root + sep);
}

export class FakeRemote {
	readonly agentDir: string;
	calls: Array<{ method: string; params: unknown }> = [];
	applyDelayMs = 0;
	/** Number of upcoming sync.apply calls that fail (e.g. a full remote disk). */
	failApplies = 0;

	constructor(readonly root: string) {
		this.agentDir = join(root, "agent");
	}

	static async create(): Promise<FakeRemote> {
		const remote = new FakeRemote(await tempDir("piweb-remote-"));
		await mkdir(remote.agentDir, { recursive: true });
		await mkdir(join(remote.root, "state"), { recursive: true });
		return remote;
	}

	private get managedPath(): string {
		return join(this.root, "state", "sync-manifest.json");
	}

	async managed(): Promise<Record<string, string>> {
		try {
			return JSON.parse(await readFile(this.managedPath, "utf8")) as Record<string, string>;
		} catch {
			return {};
		}
	}

	async read(rel: string): Promise<string> {
		return readFile(join(this.agentDir, rel), "utf8");
	}

	async exists(rel: string): Promise<boolean> {
		return lstat(join(this.agentDir, rel)).then(
			() => true,
			() => false,
		);
	}

	async handle(method: string, params: unknown): Promise<unknown> {
		this.calls.push({ method, params: structuredClone(params) });
		if (method === "sync.manifest") return this.manifest(params as SyncManifestParams);
		if (method === "sync.apply") return this.apply(params as SyncApplyParams);
		throw Object.assign(new Error(`unknown method ${method}`), { code: "METHOD_NOT_FOUND" });
	}

	async manifest(params: SyncManifestParams): Promise<SyncManifestResult> {
		const files: Record<string, SyncFileInfo> = {};
		const visit = async (rel: string): Promise<void> => {
			const abs = join(this.agentDir, rel);
			let st;
			try {
				st = await lstat(abs);
			} catch {
				return;
			}
			const name = rel.slice(rel.lastIndexOf("/") + 1);
			if (name.endsWith(".log")) return;
			if (st.isSymbolicLink()) {
				const link = await readlink(abs);
				files[rel] = { size: 0, mtimeMs: st.mtimeMs, sha256: sha256(`symlink:${link}`), link };
			} else if (st.isFile()) {
				files[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha256(await readFile(abs)) };
			} else if (st.isDirectory()) {
				for (const child of (await readdir(abs)).sort()) await visit(`${rel}/${child}`);
			}
		};
		for (const root of params.roots) if (!MANIFEST_SKIP_TOP.has(root)) await visit(root);
		return { agentDir: this.agentDir, files, managed: await this.managed() };
	}

	private async currentSha(abs: string): Promise<string | undefined> {
		try {
			const st = await lstat(abs);
			if (st.isSymbolicLink()) return sha256(`symlink:${await readlink(abs)}`);
			if (st.isFile()) return sha256(await readFile(abs));
		} catch {
			// missing
		}
		return undefined;
	}

	async apply(params: SyncApplyParams): Promise<SyncApplyResult> {
		if (this.applyDelayMs) await new Promise((r) => setTimeout(r, this.applyDelayMs));
		if (this.failApplies > 0) {
			this.failApplies--;
			throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		}
		const managed = await this.managed();
		const staging = join(this.root, "state", "incoming", params.backupLabel);
		const backupDir = join(this.root, "state", "backup", params.backupLabel);
		const result: SyncApplyResult = { written: 0, deleted: 0, backedUp: [], errors: [] };
		if (params.archivePath) {
			await mkdir(staging, { recursive: true });
			await execFileAsync("tar", ["-xzf", params.archivePath, "-C", staging]);
		}
		const backup = async (rel: string, abs: string): Promise<void> => {
			const current = await this.currentSha(abs);
			if (current === undefined || managed[rel] === current) return;
			const target = join(backupDir, rel);
			await mkdir(dirname(target), { recursive: true });
			const st = await lstat(abs);
			if (st.isSymbolicLink()) await symlink(await readlink(abs), target);
			else await copyFile(abs, target);
			result.backedUp.push(rel);
		};
		for (const write of params.writes) {
			const target = resolve(this.agentDir, write.path);
			const staged = resolve(staging, write.path);
			if (!within(this.agentDir, target) || !within(staging, staged)) {
				result.errors.push({ path: write.path, error: "path escapes agent dir" });
				continue;
			}
			const actual = await this.currentSha(staged);
			if (actual !== write.sha256) {
				result.errors.push({ path: write.path, error: "sha256 mismatch" });
				continue;
			}
			await backup(write.path, target);
			await mkdir(dirname(target), { recursive: true });
			await rm(target, { force: true });
			await rename(staged, target);
			if (write.mode !== undefined && write.link === undefined) await chmod(target, write.mode);
			managed[write.path] = write.sha256;
			result.written++;
		}
		for (const rel of params.deletes) {
			const target = resolve(this.agentDir, rel);
			if (!within(this.agentDir, target)) {
				result.errors.push({ path: rel, error: "path escapes agent dir" });
				continue;
			}
			await backup(rel, target);
			await unlink(target).catch(() => {});
			delete managed[rel];
			result.deleted++;
			let dir = dirname(target);
			while (dir !== this.agentDir && within(this.agentDir, dir)) {
				try {
					await rmdir(dir);
				} catch {
					break;
				}
				dir = dirname(dir);
			}
		}
		for (const entry of params.adopt ?? []) {
			if ((await this.currentSha(resolve(this.agentDir, entry.path))) === entry.sha256) managed[entry.path] = entry.sha256;
		}
		await writeFile(this.managedPath, JSON.stringify(managed, null, 2));
		await rm(staging, { recursive: true, force: true });
		if (params.archivePath) await rm(params.archivePath, { force: true });
		if (result.backedUp.length > 0) result.backupDir = backupDir;
		return result;
	}
}

export class FakeAgentClient extends EventEmitter {
	readonly hello: AgentHelloResult;
	readonly peer = new EventEmitter() as never;

	constructor(
		readonly serverId: string,
		readonly remote: FakeRemote,
	) {
		super();
		this.hello = {
			agentVersion: "0.1.0",
			protocol: 1,
			pid: 1,
			startedAt: 0,
			home: dirname(remote.root),
			platform: "linux",
			arch: "x64",
			nodeVersion: "v22.20.0",
			remoteRoot: remote.root,
			config: null,
		};
	}

	async call(method: string, params: unknown): Promise<any> {
		const result = await this.remote.handle(method, JSON.parse(JSON.stringify(params ?? null)));
		return JSON.parse(JSON.stringify(result));
	}

	close(): void {}
}

export class FakeConnection extends EventEmitter {
	state: "connected" | "disconnected" = "connected";
	agentClient: FakeAgentClient | null;
	uploads: Array<{ local: string; remote: string }> = [];

	constructor(
		readonly serverId: string,
		readonly client: FakeAgentClient,
		online = true,
	) {
		super();
		this.agentClient = online ? client : null;
	}

	setOnline(online: boolean): void {
		this.agentClient = online ? this.client : null;
		this.state = online ? "connected" : "disconnected";
	}

	async agent(): Promise<FakeAgentClient> {
		if (!this.agentClient) throw new Error("not connected");
		return this.agentClient;
	}

	async upload(localPath: string, remotePath: string): Promise<void> {
		this.uploads.push({ local: localPath, remote: remotePath });
		await mkdir(dirname(remotePath), { recursive: true });
		await copyFile(localPath, remotePath);
	}
}

export class FakeConnections extends EventEmitter {
	readonly connections = new Map<string, FakeConnection>();
	statusPatches: Array<{ serverId: string; patch: Partial<ServerRuntimeStatus> }> = [];

	add(connection: FakeConnection): void {
		this.connections.set(connection.serverId, connection);
	}
	get(serverId: string): FakeConnection {
		const connection = this.connections.get(serverId);
		if (!connection) throw new Error(`no connection ${serverId}`);
		return connection;
	}
	updateStatus(serverId: string, patch: Partial<ServerRuntimeStatus>): void {
		this.statusPatches.push({ serverId, patch: structuredClone(patch) });
	}
	lastPatch(serverId: string): Partial<ServerRuntimeStatus> | undefined {
		return this.statusPatches.filter((p) => p.serverId === serverId).at(-1)?.patch;
	}
}

/** Writes a file (creating parents). */
export async function put(path: string, content: string | Buffer, mode?: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
	if (mode !== undefined) await chmod(path, mode);
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 20): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	throw new Error("waitFor timed out");
}

export async function listFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		for (const name of await readdir(dir).catch(() => [] as string[])) {
			const abs = join(dir, name);
			const st = await lstat(abs);
			if (st.isDirectory()) await visit(abs);
			else out.push(relative(root, abs));
		}
	};
	await visit(root);
	return out.sort();
}

export { stat };
