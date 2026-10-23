/**
 * Hand-written fakes of the AppContext services for route, conversation and terminal
 * tests, plus an in-memory agent served over a real LinkPeer pair.
 */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { duplexPair } from "node:stream";
import {
	DEFAULT_HOST_SETTINGS,
	SYNC_ITEMS,
} from "@pi-web/shared";
import type {
	AgentConfig,
	AgentHelloResult,
	AgentMethod,
	AgentParams,
	AgentResult,
	CacheEntry,
	CacheResponse,
	ConnectionState,
	ConvEvent,
	ConvInfo,
	ConvRecord,
	ConvSnapshot,
	DeployProgress,
	DeployRequest,
	HostInventory,
	HostKeyInfo,
	HostSettings,
	OAuthStatusResponse,
	ProbeResult,
	ProxyStats,
	RpcSessionState,
	ServerConfig,
	ServerRuntimeStatus,
	SyncItemKey,
	SyncPlan,
	SyncRecord,
	SyncStatusResponse,
	TestConnectionResult,
	UninstallRequest,
	WorkspaceConfig,
} from "@pi-web/shared";
import { LinkPeer } from "@pi-web/shared/link";
import type {
	AgentClient,
	AppContext,
	ConnectionManager,
	Deployer,
	EventHub,
	ExecOptions,
	ExecResult,
	HostPaths,
	HostPi,
	Logger,
	OAuthKeeper,
	Secrets,
	ServerConnection,
	Store,
	Syncer,
	TunnelProxy,
} from "../../src/core/types.js";
import { createConversationService } from "../../src/conv/index.js";
import type { ConversationServiceOptions } from "../../src/conv/index.js";

export const silentLog: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	child: () => silentLog,
};

// ---------------------------------------------------------------- store & secrets

export class MemoryStore implements Store {
	settings: HostSettings = structuredClone(DEFAULT_HOST_SETTINGS);
	servers = new Map<string, ServerConfig>();
	workspaces = new Map<string, WorkspaceConfig>();
	records: SyncRecord[] = [];
	state = new Map<string, unknown>();

	getSettings(): HostSettings {
		return structuredClone(this.settings);
	}
	async updateSettings(patch: Partial<HostSettings>): Promise<HostSettings> {
		const next = { ...this.settings } as Record<string, unknown>;
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined || value === null) delete next[key];
			else next[key] = structuredClone(value);
		}
		this.settings = next as unknown as HostSettings;
		return this.getSettings();
	}
	listServers(): ServerConfig[] {
		return [...this.servers.values()].map((s) => structuredClone(s));
	}
	getServer(id: string): ServerConfig | undefined {
		const s = this.servers.get(id);
		return s ? structuredClone(s) : undefined;
	}
	async saveServer(server: ServerConfig): Promise<void> {
		this.servers.set(server.id, structuredClone(server));
	}
	async deleteServer(id: string): Promise<void> {
		this.servers.delete(id);
	}
	listWorkspaces(serverId?: string): WorkspaceConfig[] {
		return [...this.workspaces.values()].filter((w) => !serverId || w.serverId === serverId).map((w) => structuredClone(w));
	}
	getWorkspace(id: string): WorkspaceConfig | undefined {
		const w = this.workspaces.get(id);
		return w ? structuredClone(w) : undefined;
	}
	async saveWorkspace(workspace: WorkspaceConfig): Promise<void> {
		this.workspaces.set(workspace.id, structuredClone(workspace));
	}
	async deleteWorkspace(id: string): Promise<void> {
		this.workspaces.delete(id);
	}
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
		this.state.set(key, value);
	}
}

export class MemorySecrets implements Secrets {
	values = new Map<string, string>();
	async get(key: string): Promise<string | undefined> {
		return this.values.get(key);
	}
	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.values.delete(key);
	}
}

export class RecordingHub implements EventHub {
	published: Array<{ topic: string; data: unknown }> = [];
	publish(topic: string, data: unknown): void {
		this.published.push({ topic, data: structuredClone(data) });
	}
	subscriberCount(): number {
		return 0;
	}
	topic<T = unknown>(topic: string): T[] {
		return this.published.filter((p) => p.topic === topic).map((p) => p.data as T);
	}
	clear(): void {
		this.published = [];
	}
}

// ---------------------------------------------------------------- agent over a LinkPeer pair

export function helloFor(overrides: Partial<AgentHelloResult> = {}): AgentHelloResult {
	return {
		agentVersion: "0.1.0",
		protocol: 1,
		pid: 4242,
		startedAt: Date.now(),
		home: "/home/dev",
		platform: "linux",
		arch: "x64",
		nodeVersion: "v22.20.0",
		remoteRoot: "/home/dev/.pi-web",
		config: null,
		...overrides,
	};
}

/** Minimal AgentClient over the host side of a LinkPeer pair. */
export class FakeAgentClient extends EventEmitter implements AgentClient {
	constructor(
		readonly serverId: string,
		readonly peer: LinkPeer,
		readonly hello: AgentHelloResult,
	) {
		super();
		peer.on("event", (name: string, data: unknown) => this.emit("event", name, data));
		peer.once("close", (err?: Error) => this.emit("close", err));
	}
	call<M extends AgentMethod>(method: M, params: AgentParams<M>, options?: { timeoutMs?: number }): Promise<AgentResult<M>> {
		return this.peer.request<AgentResult<M>>(method, params, options);
	}
	close(): void {
		this.peer.close();
	}
}

export function defaultState(overrides: Partial<RpcSessionState> = {}): RpcSessionState {
	return {
		thinkingLevel: "medium",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "sess-1",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		...overrides,
	};
}

type Handler = (params: any) => unknown;

/**
 * In-memory pi-web-agent: keeps conversations and their event log, answers the
 * conversation methods, and lets tests register any other method.
 */
export class FakeAgent {
	readonly calls: Array<{ method: string; params: any }> = [];
	readonly convs = new Map<string, ConvInfo>();
	readonly events = new Map<string, ConvEvent[]>();
	/** Oldest seq still in the "ring buffer" per conversation (replay is incomplete below it). */
	readonly ringStart = new Map<string, number>();
	readonly handlers = new Map<string, Handler>();
	peers: LinkPeer[] = [];
	now = () => Date.now();

	constructor(readonly serverId = "srv1", readonly helloOverrides: Partial<AgentHelloResult> = {}) {
		this.handle("conv.list", () => ({ conversations: [...this.convs.values()] }));
		this.handle("conv.start", (p) => {
			const existing = p.sessionFile ? [...this.convs.values()].find((c) => c.sessionFile === p.sessionFile && c.status !== "exited") : undefined;
			if (existing) return { conv: existing, state: defaultState(), attached: true };
			const info: ConvInfo = {
				convId: p.convId,
				cwd: p.cwd,
				sessionFile: p.sessionFile ?? `/home/dev/.pi-web/agent/sessions/x/${p.convId}.jsonl`,
				sessionId: `sid-${p.convId.slice(0, 8)}`,
				status: "idle",
				startedAt: this.now(),
				lastActivityAt: this.now(),
				lastSeq: 0,
				pendingUi: [],
				statuses: {},
				widgets: {},
			};
			this.convs.set(info.convId, info);
			this.events.set(info.convId, []);
			this.broadcast("conv.info", info);
			return { conv: info, state: defaultState(), attached: false };
		});
		this.handle("conv.replay", (p) => {
			const events = (this.events.get(p.convId) ?? []).filter((e) => e.seq > p.afterSeq);
			const info = this.convs.get(p.convId);
			const start = this.ringStart.get(p.convId) ?? 1;
			return { events, complete: start <= p.afterSeq + 1, lastSeq: info?.lastSeq ?? 0 };
		});
		this.handle("conv.snapshot", (p): ConvSnapshot => {
			const info = this.requireConv(p.convId);
			return {
				info,
				state: defaultState(),
				messages: [],
				streaming: null,
				streamingToolArgs: {},
				runningTools: [],
				queue: { steering: [], followUp: [] },
				ui: { pending: [], statuses: {}, widgets: {}, notifications: [] },
				isRunning: info.status === "running",
				isCompacting: false,
				seq: info.lastSeq,
			};
		});
		this.handle("conv.send", (p) => {
			const info = this.requireConv(p.convId);
			const data = p.command.type === "export_html" ? { path: p.command.outputPath } : { ok: true };
			return { type: "response", command: p.command.type, success: true, data, seq: info.lastSeq };
		});
		this.handle("conv.uiResponse", () => ({ ok: true }));
		this.handle("conv.stop", () => ({ ok: true }));
		this.handle("conv.companion", () => ({ ok: true }));
		this.handle("fs.mkdir", () => ({ ok: true }));
	}

	handle(method: string, handler: Handler): this {
		this.handlers.set(method, handler);
		for (const peer of this.peers) this.register(peer, method, handler);
		return this;
	}

	private register(peer: LinkPeer, method: string, handler: Handler): void {
		peer.handle(method, (params: unknown) => {
			this.calls.push({ method, params });
			return handler(params);
		});
	}

	/** A fresh link to this agent (one per host connection). */
	connect(): FakeAgentClient {
		const [hostSide, agentSide] = duplexPair();
		const hostPeer = new LinkPeer(hostSide, { side: "host" });
		const agentPeer = new LinkPeer(agentSide, { side: "agent" });
		for (const [method, handler] of this.handlers) this.register(agentPeer, method, handler);
		this.peers.push(agentPeer);
		agentPeer.once("close", () => {
			this.peers = this.peers.filter((p) => p !== agentPeer);
		});
		return new FakeAgentClient(this.serverId, hostPeer, helloFor(this.helloOverrides));
	}

	requireConv(convId: string): ConvInfo {
		const info = this.convs.get(convId);
		if (!info) throw Object.assign(new Error(`unknown conversation ${convId}`), { code: "NOT_FOUND" });
		return info;
	}

	addConv(info: Partial<ConvInfo> & { convId: string; cwd: string }): ConvInfo {
		const full: ConvInfo = {
			status: "idle",
			startedAt: this.now(),
			lastActivityAt: this.now(),
			lastSeq: 0,
			pendingUi: [],
			statuses: {},
			widgets: {},
			...info,
		};
		this.convs.set(full.convId, full);
		if (!this.events.has(full.convId)) this.events.set(full.convId, []);
		return full;
	}

	/** Appends a record to a conversation and pushes conv.event to every connected peer. */
	emitRecord(convId: string, record: ConvRecord): ConvEvent {
		const info = this.requireConv(convId);
		info.lastSeq += 1;
		info.lastActivityAt = this.now();
		const event: ConvEvent = { convId, seq: info.lastSeq, ts: this.now(), record };
		this.events.get(convId)!.push(event);
		this.broadcast("conv.event", event);
		return event;
	}

	setStatus(convId: string, status: ConvInfo["status"]): void {
		const info = this.requireConv(convId);
		info.status = status;
		this.emitRecord(convId, { type: "pi_web_status", status });
		this.broadcast("conv.info", { ...info });
	}

	broadcast(event: string, data: unknown): void {
		for (const peer of this.peers) peer.emitEvent(event, data);
	}

	callsOf(method: string): any[] {
		return this.calls.filter((c) => c.method === method).map((c) => c.params);
	}
}

// ---------------------------------------------------------------- connections

export class FakePtyChannel extends EventEmitter {
	readonly written: Buffer[] = [];
	readonly windows: Array<[number, number, number, number]> = [];
	readonly stderr = new EventEmitter();
	closed = false;
	paused = false;
	write(data: Buffer | string): boolean {
		this.written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
		return true;
	}
	setWindow(rows: number, cols: number, height: number, width: number): void {
		this.windows.push([rows, cols, height, width]);
	}
	pause(): this {
		this.paused = true;
		return this;
	}
	resume(): this {
		this.paused = false;
		return this;
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		setImmediate(() => this.emit("close"));
	}
	/** Simulates the remote shell exiting. */
	exit(code: number | null): void {
		this.emit("exit", code);
		this.closed = true;
		this.emit("close");
	}
}

export class FakeServerConnection extends EventEmitter implements ServerConnection {
	state: ConnectionState = "disconnected";
	lastError?: string;
	latencyMs?: number;
	agentClient: AgentClient | null = null;
	readonly execs: string[] = [];
	readonly files = new Map<string, Buffer>();
	readonly ptyRequests: Array<{ command: string; cols: number; rows: number; term?: string }> = [];
	ptyChannel: FakePtyChannel | null = null;
	ptyError: Error | null = null;
	ensureSshCalls = 0;

	constructor(
		readonly serverId: string,
		private readonly manager: FakeConnectionManager,
	) {
		super();
	}
	async ensureSsh(): Promise<void> {
		this.ensureSshCalls++;
		if (this.state !== "connected") this.state = "connected";
	}
	async exec(command: string, _options?: ExecOptions): Promise<ExecResult> {
		this.execs.push(command);
		return { stdout: "", stderr: "", code: 0 };
	}
	async upload(): Promise<void> {}
	async writeFile(remotePath: string, content: string | Buffer): Promise<void> {
		this.files.set(remotePath, Buffer.from(content));
	}
	async readFile(remotePath: string): Promise<Buffer> {
		const data = this.files.get(remotePath);
		if (!data) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
		return data;
	}
	async createReadStream(remotePath: string): Promise<{ stream: Readable; size: number }> {
		const data = this.files.get(remotePath);
		if (!data) throw Object.assign(new Error(`no such file: ${remotePath}`), { code: "ENOENT" });
		return { stream: Readable.from([data]), size: data.length };
	}
	async openPty(options: { command: string; cols: number; rows: number; term?: string }): Promise<any> {
		this.ptyRequests.push(options);
		if (this.ptyError) throw this.ptyError;
		this.ptyChannel = new FakePtyChannel();
		return this.ptyChannel;
	}
	async agent(): Promise<AgentClient> {
		if (this.agentClient) return this.agentClient;
		const client = this.manager.agentFactory?.(this.serverId);
		if (!client) throw Object.assign(new Error("not deployed"), { code: "NOT_DEPLOYED" });
		this.setAgent(client);
		return client;
	}
	setAgent(client: AgentClient | null): void {
		this.agentClient = client;
		if (client) {
			this.state = "connected";
			this.manager.emit("agent-connected", this.serverId, client);
		} else {
			this.manager.emit("agent-disconnected", this.serverId);
		}
	}
	disconnectAgent(): void {
		this.agentClient?.close();
		this.setAgent(null);
	}
	async disconnect(): Promise<void> {
		this.state = "disconnected";
		if (this.agentClient) this.disconnectAgent();
	}
}

export class FakeConnectionManager extends EventEmitter implements ConnectionManager {
	readonly conns = new Map<string, FakeServerConnection>();
	readonly statusPatches = new Map<string, Partial<ServerRuntimeStatus>>();
	readonly calls: Array<{ method: string; args: unknown[] }> = [];
	agentFactory?: (serverId: string) => AgentClient;
	testResult: TestConnectionResult = { ok: true, hostKeyStatus: "trusted", latencyMs: 5 };

	constructor(private readonly store: MemoryStore) {
		super();
	}
	get(serverId: string): FakeServerConnection {
		let conn = this.conns.get(serverId);
		if (!conn) {
			conn = new FakeServerConnection(serverId, this);
			this.conns.set(serverId, conn);
		}
		return conn;
	}
	async connect(serverId: string): Promise<void> {
		this.calls.push({ method: "connect", args: [serverId] });
		const conn = this.get(serverId);
		await conn.ensureSsh();
		if (this.store.getServer(serverId)?.deployed || this.agentFactory) await conn.agent();
	}
	async disconnect(serverId: string): Promise<void> {
		this.calls.push({ method: "disconnect", args: [serverId] });
		await this.get(serverId).disconnect();
	}
	async remove(serverId: string): Promise<void> {
		this.calls.push({ method: "remove", args: [serverId] });
		this.conns.delete(serverId);
	}
	status(serverId: string): ServerRuntimeStatus {
		const conn = this.conns.get(serverId);
		return {
			serverId,
			connection: conn?.state ?? "disconnected",
			deployState: "deployed",
			conversationsRunning: 0,
			conversationsWaiting: 0,
			pendingSync: 0,
			...this.statusPatches.get(serverId),
		};
	}
	allStatuses(): ServerRuntimeStatus[] {
		return this.store.listServers().map((s) => this.status(s.id));
	}
	updateStatus(serverId: string, patch: Partial<ServerRuntimeStatus>): void {
		this.statusPatches.set(serverId, { ...this.statusPatches.get(serverId), ...patch });
	}
	async testConnection(input: unknown): Promise<TestConnectionResult> {
		this.calls.push({ method: "testConnection", args: [input] });
		return this.testResult;
	}
	async trustHostKey(serverId: string, key: HostKeyInfo): Promise<void> {
		this.calls.push({ method: "trustHostKey", args: [serverId, key] });
		const server = this.store.getServer(serverId)!;
		server.hostKey = { ...key, trustedAt: 1 };
		await this.store.saveServer(server);
	}
	async autoConnectAll(): Promise<void> {}
	async shutdown(): Promise<void> {}
}

// ---------------------------------------------------------------- other services

export class FakeDeployer extends EventEmitter implements Deployer {
	agentVersion = "0.1.0";
	jobs = new Map<string, DeployProgress>();
	readonly calls: Array<{ method: string; args: unknown[] }> = [];
	imported: { fileName: string; bytes: number } | null = null;

	async probe(serverId: string): Promise<ProbeResult> {
		this.calls.push({ method: "probe", args: [serverId] });
		return {
			os: "Linux",
			arch: "x64",
			supportedArch: true,
			glibcOk: true,
			home: "/home/dev",
			hasTar: true,
			hasGzip: true,
			sftp: true,
			internet: { reachable: false },
			issues: [],
			warnings: [],
		};
	}
	deploy(serverId: string, request: DeployRequest): DeployProgress {
		this.calls.push({ method: "deploy", args: [serverId, request] });
		const job: DeployProgress = { serverId, jobId: "job1", state: "running", steps: [], log: [], startedAt: 1 };
		this.jobs.set(serverId, job);
		return job;
	}
	getJob(serverId: string): DeployProgress | undefined {
		return this.jobs.get(serverId);
	}
	cancel(serverId: string): void {
		this.calls.push({ method: "cancel", args: [serverId] });
	}
	async uninstall(serverId: string, request: UninstallRequest): Promise<void> {
		this.calls.push({ method: "uninstall", args: [serverId, request] });
	}
	async restartAgent(serverId: string): Promise<void> {
		this.calls.push({ method: "restartAgent", args: [serverId] });
	}
	async syncAgentDir(serverId: string): Promise<void> {
		this.calls.push({ method: "syncAgentDir", args: [serverId] });
	}
	async buildAgentConfig(serverId: string): Promise<AgentConfig> {
		this.calls.push({ method: "buildAgentConfig", args: [serverId] });
		return {
			remoteRoot: "/home/dev/.pi-web",
			agentDir: "/home/dev/.pi-web/agent",
			nodePath: "/n",
			piCliPath: "/p",
			piPackageDir: "/pp",
			piVersion: "1.4.0",
			companionExtPath: "/e",
			proxy: { enabled: false, port: 30001, token: "t", scope: "llm", noProxy: [] },
			idleTimeoutMin: 30,
			extraEnv: {},
		};
	}
	async targetPiVersion(): Promise<string> {
		return "1.4.0";
	}
	async listCache(): Promise<CacheResponse> {
		return { entries: [], totalBytes: 0 };
	}
	async deleteCache(name: string): Promise<void> {
		this.calls.push({ method: "deleteCache", args: [name] });
	}
	async importNodeTarball(fileName: string, data: Readable): Promise<CacheEntry> {
		let bytes = 0;
		for await (const chunk of data) bytes += (chunk as Buffer).length;
		this.imported = { fileName, bytes };
		return { name: fileName, kind: "node", version: "22.20.0", arch: "x64", bytes, createdAt: 1, usedBy: [] };
	}
}

export class FakeProxy implements TunnelProxy {
	attached = new Map<string, AgentClient>();
	constructor(private readonly store: MemoryStore) {}
	attach(serverId: string, client: AgentClient): void {
		this.attached.set(serverId, client);
	}
	detach(serverId: string): void {
		this.attached.delete(serverId);
	}
	stats(): ProxyStats {
		return { active: 1, byHost: [], denied: [] };
	}
	async allowDomain(serverId: string, domain: string): Promise<ServerConfig> {
		const server = this.store.getServer(serverId)!;
		server.proxy.extraDomains = [...server.proxy.extraDomains, domain];
		await this.store.saveServer(server);
		return server;
	}
	async providerDomains(): Promise<string[]> {
		return ["api.anthropic.com:443"];
	}
	protectLocalPort(): void {}
}

export class FakeSyncer extends EventEmitter implements Syncer {
	lastChange = new Map<string, number>();
	readonly calls: Array<{ method: string; args: unknown[] }> = [];
	async inventory(): Promise<HostInventory> {
		return { agentDir: "/host/.pi/agent", items: [], scannedAt: 1 };
	}
	async status(): Promise<SyncStatusResponse> {
		return { hostAgentDir: "/host/.pi/agent", watching: true, servers: [] };
	}
	async preview(serverId: string): Promise<SyncPlan> {
		return { serverId, entries: [], summary: { add: 0, update: 0, delete: 0, conflict: 0 }, warnings: [], generatedAt: 1 };
	}
	async run(serverId: string, trigger: SyncRecord["trigger"]): Promise<SyncRecord> {
		return record(serverId, trigger);
	}
	async runMany(serverIds: string[] | undefined, trigger: SyncRecord["trigger"]): Promise<SyncRecord[]> {
		this.calls.push({ method: "runMany", args: [serverIds, trigger] });
		return (serverIds ?? ["all"]).map((id) => record(id, trigger));
	}
	async pushAuth(): Promise<Array<{ serverId: string; ok: boolean }>> {
		return [];
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async rewatch(): Promise<void> {
		this.calls.push({ method: "rewatch", args: [] });
	}
	onAgentConnected(serverId: string): void {
		this.calls.push({ method: "onAgentConnected", args: [serverId] });
	}
	lastChangeAt(serverId: string): number | undefined {
		return this.lastChange.get(serverId);
	}
}

function record(serverId: string, trigger: SyncRecord["trigger"]): SyncRecord {
	return {
		id: `rec-${serverId}`,
		serverId,
		at: 1,
		trigger,
		added: 0,
		updated: 0,
		deleted: 0,
		conflicts: 0,
		backedUp: [],
		status: "ok",
		durationMs: 1,
	};
}

export class FakeOAuth implements OAuthKeeper {
	refreshed: string[] = [];
	rewatched = 0;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async rewatch(): Promise<void> {
		this.rewatched++;
	}
	async status(): Promise<OAuthStatusResponse> {
		return { providers: [] };
	}
	async refresh(provider: string): Promise<OAuthStatusResponse> {
		this.refreshed.push(provider);
		return { providers: [{ provider, expiresAt: 2, refreshAt: 1, pushed: [] }] };
	}
}

export class FakeHostPi implements HostPi {
	agentDir = "/host/.pi/agent";
	invalidations = 0;
	async version(): Promise<string | null> {
		return "1.4.2";
	}
	async modelRuntime(): Promise<never> {
		throw new Error("not available in tests");
	}
	invalidate(): void {
		this.invalidations++;
	}
}

// ---------------------------------------------------------------- context

export interface FakeContext {
	ctx: AppContext;
	store: MemoryStore;
	secrets: MemorySecrets;
	hub: RecordingHub;
	connections: FakeConnectionManager;
	deployer: FakeDeployer;
	proxy: FakeProxy;
	syncer: FakeSyncer;
	oauth: FakeOAuth;
	hostPi: FakeHostPi;
	paths: HostPaths;
}

export function createFakeContext(
	options: { webDistDir?: string | null; hub?: EventHub; conversations?: ConversationServiceOptions } = {},
): FakeContext {
	const store = new MemoryStore();
	const secrets = new MemorySecrets();
	const hub = new RecordingHub();
	const connections = new FakeConnectionManager(store);
	const deployer = new FakeDeployer();
	const proxy = new FakeProxy(store);
	const syncer = new FakeSyncer();
	const oauth = new FakeOAuth();
	const hostPi = new FakeHostPi();
	const paths: HostPaths = {
		dataDir: "/data",
		cacheDir: "/data/cache",
		tmpDir: "/data/cache/tmp",
		logsDir: "/data/logs",
		hostAgentDir: "/host/.pi/agent",
		agentDistDir: "/agent-dist",
		webDistDir: options.webDistDir ?? null,
	};
	const partial = {
		version: "9.9.9",
		paths,
		log: silentLog,
		store,
		secrets,
		hub: options.hub ?? hub,
		hostPi,
		connections,
		deployer,
		proxy,
		syncer,
		oauth,
	};
	const ctx = { ...partial, conversations: undefined as unknown } as unknown as AppContext;
	(ctx as { conversations: unknown }).conversations = createConversationService(ctx, {
		attachWaitMs: 2000,
		...options.conversations,
	});
	return { ctx, store, secrets, hub, connections, deployer, proxy, syncer, oauth, hostPi, paths };
}

export function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		id: "srv1",
		name: "dev box",
		host: "10.0.0.5",
		port: 22,
		username: "dev",
		auth: { method: "agent" },
		jumpServerIds: [],
		remoteRoot: "~/.pi-web",
		agentDirMode: "isolated",
		proxy: { mode: "tunnel", port: 31000, scope: "llm", toolsPolicy: "allowlist", extraDomains: [], noProxy: [] },
		sync: {
			items: Object.fromEntries(SYNC_ITEMS.map((i) => [i.key, i.defaultEnabled])) as Record<SyncItemKey, boolean>,
			auto: true,
			settingsOverride: {},
		},
		idleTimeoutMin: 30,
		defaultTrust: "approve",
		env: {},
		createdAt: 1,
		updatedAt: 1,
		deployed: {
			nodeVersion: "22.20.0",
			piVersion: "1.4.0",
			agentVersion: "0.1.0",
			arch: "x64",
			home: "/home/dev",
			remoteRoot: "/home/dev/.pi-web",
			agentDir: "/home/dev/.pi-web/agent",
			at: 1,
		},
		...overrides,
	};
}

export function makeWorkspace(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
	return {
		id: "ws1",
		serverId: "srv1",
		path: "/home/dev/project",
		alias: "project",
		trust: "approve",
		defaults: {},
		env: {},
		createdAt: 1,
		...overrides,
	};
}

/** Wait until `predicate` holds (polling), failing after `timeoutMs`. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** Let pending Link messages (in-memory duplex) be delivered. */
export function flush(): Promise<void> {
	return new Promise((r) => setTimeout(r, 20));
}
