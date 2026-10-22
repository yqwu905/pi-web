/**
 * Internal service contracts of the Pi-Web host server. Each service is implemented in
 * its own module (see docs/IMPLEMENTATION.md for ownership) and reaches the others only
 * through these interfaces on AppContext, so modules can be built and tested in isolation.
 */
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	AgentConfig,
	AgentEventMap,
	AgentHelloResult,
	AgentMethod,
	AgentParams,
	AgentResult,
	CacheEntry,
	CacheResponse,
	CompanionActionResponse,
	ConnectionState,
	ConversationSnapshot,
	ConversationView,
	ConvReplayResult,
	DeployProgress,
	DeployRequest,
	ExtensionUIResponse,
	HostInventory,
	HostKeyInfo,
	HostSettings,
	OAuthStatusResponse,
	OpenConversationRequest,
	ProbeResult,
	ProxyStats,
	RpcCommand,
	RpcResponse,
	ServerAuthInput,
	ServerConfig,
	ServerRuntimeStatus,
	SyncPlan,
	SyncRecord,
	SyncStatusResponse,
	TestConnectionResult,
	UninstallRequest,
	WorkspaceConfig,
} from "@pi-web/shared";
import type { LinkPeer } from "@pi-web/shared/link";
import type { ClientChannel } from "ssh2";

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export interface Logger {
	debug(msg: string, extra?: Record<string, unknown>): void;
	info(msg: string, extra?: Record<string, unknown>): void;
	warn(msg: string, extra?: Record<string, unknown>): void;
	error(msg: string, extra?: Record<string, unknown>): void;
	child(scope: string): Logger;
}

export interface HostPaths {
	/** ~/.pi-web-host by default (override: --data-dir or PI_WEB_DATA_DIR). */
	dataDir: string;
	cacheDir: string;
	tmpDir: string;
	logsDir: string;
	/** Host pi agent dir: settings.hostAgentDir ?? $PI_CODING_AGENT_DIR ?? ~/.pi/agent */
	hostAgentDir: string;
	/** Directory holding pi-web-agent.mjs, bridge.mjs, pi-web-ext.mjs and VERSION (the @pi-web/agent build). */
	agentDistDir: string;
	/** Built SPA directory, or null when the web UI is served by the Vite dev server. */
	webDistDir: string | null;
}

/** JSON-file backed persistence with atomic writes (write temp + rename). */
export interface Store {
	getSettings(): HostSettings;
	updateSettings(patch: Partial<HostSettings>): Promise<HostSettings>;

	listServers(): ServerConfig[];
	getServer(id: string): ServerConfig | undefined;
	saveServer(server: ServerConfig): Promise<void>;
	deleteServer(id: string): Promise<void>;

	listWorkspaces(serverId?: string): WorkspaceConfig[];
	getWorkspace(id: string): WorkspaceConfig | undefined;
	saveWorkspace(workspace: WorkspaceConfig): Promise<void>;
	deleteWorkspace(id: string): Promise<void>;

	/** Keeps the newest 1000 records. */
	appendSyncRecord(record: SyncRecord): Promise<void>;
	listSyncRecords(limit?: number): SyncRecord[];

	/** Small keyed state blobs (e.g. "oauth", "sync:<serverId>"). */
	getState<T>(key: string): T | undefined;
	setState<T>(key: string, value: T): Promise<void>;
}

/**
 * Encrypted secret storage (AES-256-GCM, key in dataDir/master.key with mode 0600).
 * Key conventions:
 *   `server:<id>:secret`      SSH password or key passphrase
 *   `server:<id>:proxyToken`  tunnel proxy token
 *   `accessToken`             web UI access token
 */
export interface Secrets {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

/** WebSocket topic fan-out (see WsTopic in @pi-web/shared/api). */
export interface EventHub {
	publish(topic: string, data: unknown): void;
	/** Number of sockets subscribed to a topic (lets producers skip work). */
	subscriberCount(topic: string): number;
}

// ---------------------------------------------------------------------------
// SSH & agent link (module: src/ssh)
// ---------------------------------------------------------------------------

export interface ExecOptions {
	stdin?: string | Buffer;
	/** Kill the channel after this long; default 120s. 0 = no timeout. */
	timeoutMs?: number;
	/** Truncate captured stdout/stderr beyond this many bytes each; default 16 MiB. */
	maxOutputBytes?: number;
}
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	signal?: string;
}

export interface UploadOptions {
	mode?: number;
	onProgress?: (bytesDone: number, bytesTotal: number) => void;
	signal?: AbortSignal;
}

/**
 * The Link to one server's pi-web-agent. Emits:
 *   "event" (name: keyof AgentEventMap, data)
 *   "close" (err?: Error)
 */
export interface AgentClient extends EventEmitter {
	readonly serverId: string;
	readonly hello: AgentHelloResult;
	readonly peer: LinkPeer;
	call<M extends AgentMethod>(method: M, params: AgentParams<M>, options?: { timeoutMs?: number }): Promise<AgentResult<M>>;
	close(): void;
}
export type AgentEventListener = <E extends keyof AgentEventMap>(name: E, data: AgentEventMap[E]) => void;

/**
 * One server's SSH session (with jump hosts) plus its agent link. Emits:
 *   "state" (state: ConnectionState)
 *   "agent" (client: AgentClient | null)   // link established or lost
 */
export interface ServerConnection extends EventEmitter {
	readonly serverId: string;
	readonly state: ConnectionState;
	readonly lastError?: string;
	readonly latencyMs?: number;
	readonly agentClient: AgentClient | null;

	/** Connects SSH (jump hosts included) if needed. Host key must already be trusted. */
	ensureSsh(): Promise<void>;
	/** Run a non-interactive command through the user's login shell (`sh -c` semantics). */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	/** Upload a local file (SFTP; falls back to `cat >` over exec when SFTP is unavailable). Creates parent dirs. */
	upload(localPath: string, remotePath: string, options?: UploadOptions): Promise<void>;
	writeFile(remotePath: string, content: string | Buffer, options?: { mode?: number }): Promise<void>;
	readFile(remotePath: string, options?: { maxBytes?: number }): Promise<Buffer>;
	/** Stream a remote file (for downloads). */
	createReadStream(remotePath: string): Promise<{ stream: Readable; size: number }>;
	/** Exec `command` with a pty attached (web terminal). */
	openPty(options: { command: string; cols: number; rows: number; term?: string }): Promise<ClientChannel>;
	/**
	 * Returns the agent link, connecting it if necessary by exec'ing the bridge
	 * (`<node> <root>/daemon/bridge.mjs --root <root>`), which starts the daemon on demand.
	 * Rejects with code NOT_DEPLOYED when the server has no deployment.
	 */
	agent(): Promise<AgentClient>;
	disconnectAgent(): void;
	disconnect(): Promise<void>;
}

/**
 * Owns every ServerConnection. Emits:
 *   "status" (status: ServerRuntimeStatus)               // any status field changed
 *   "agent-connected" (serverId: string, client: AgentClient)
 *   "agent-disconnected" (serverId: string)
 */
export interface ConnectionManager extends EventEmitter {
	get(serverId: string): ServerConnection;
	/** SSH + (when deployed) agent link. Idempotent. Enables auto-reconnect for this server. */
	connect(serverId: string): Promise<void>;
	/** Closes everything and disables auto-reconnect. */
	disconnect(serverId: string): Promise<void>;
	/** Called after a server is deleted. */
	remove(serverId: string): Promise<void>;
	status(serverId: string): ServerRuntimeStatus;
	allStatuses(): ServerRuntimeStatus[];
	/** Other services contribute fields (pendingSync, proxy, conversation counts, deployState…). */
	updateStatus(serverId: string, patch: Partial<ServerRuntimeStatus>): void;
	/** Try a connection that is not (yet) saved; returns the host key so the UI can ask for trust. */
	testConnection(input: {
		host: string;
		port: number;
		username: string;
		auth: ServerAuthInput;
		jumpServerIds?: string[];
		/** When testing an existing server, compare against its trusted key and use its stored secret. */
		serverId?: string;
	}): Promise<TestConnectionResult>;
	trustHostKey(serverId: string, key: HostKeyInfo): Promise<void>;
	/** Connect every deployed server (startup). */
	autoConnectAll(): Promise<void>;
	shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Deployment (module: src/deploy)
// ---------------------------------------------------------------------------

/** Emits "progress" (progress: DeployProgress) on every change. */
export interface Deployer extends EventEmitter {
	/** Version of the bundled pi-web-agent (from agentDistDir/VERSION). */
	readonly agentVersion: string;
	probe(serverId: string): Promise<ProbeResult>;
	/** Starts a deploy job in the background and returns its initial progress. One job per server. */
	deploy(serverId: string, request: DeployRequest): DeployProgress;
	getJob(serverId: string): DeployProgress | undefined;
	cancel(serverId: string): void;
	uninstall(serverId: string, request: UninstallRequest): Promise<void>;
	restartAgent(serverId: string): Promise<void>;
	/** AgentConfig to send with agent.configure whenever the link (re)connects. */
	buildAgentConfig(serverId: string): Promise<AgentConfig>;
	/** pi version the host would deploy right now (policy "host" → host pi version, else pinned). */
	targetPiVersion(): Promise<string>;
	/**
	 * After agentDirMode changed: rewrite R/bin/pi (it bakes in the agent dir) and update
	 * deployed.agentDir. No-op when already in sync or SSH is down (retried on the next link).
	 */
	syncAgentDir(serverId: string): Promise<void>;
	listCache(): Promise<CacheResponse>;
	deleteCache(name: string): Promise<void>;
	/** Store a user-provided Node.js linux tarball (.tar.xz or .tar.gz) in the cache. */
	importNodeTarball(fileName: string, data: Readable): Promise<CacheEntry>;
}

// ---------------------------------------------------------------------------
// Tunnel proxy, sync, OAuth (modules: src/proxy, src/sync)
// ---------------------------------------------------------------------------

export interface TunnelProxy {
	/** Serve the agent's proxy streams for this server (registers peer.onStreamOpen). */
	attach(serverId: string, client: AgentClient): void;
	detach(serverId: string): void;
	stats(serverId: string): ProxyStats;
	/** Add a domain to the server's proxy.extraDomains (persisted). */
	allowDomain(serverId: string, domain: string): Promise<ServerConfig>;
	/** Endpoints ("host:port" or a pattern on 443) of every LLM provider known to the host pi configuration (cached). */
	providerDomains(): Promise<string[]>;
	/** A port this Pi-Web listens on: never reachable through a tunnel to the host itself. */
	protectLocalPort(port: number): void;
}

/** Emits "status" (SyncStatusResponse), "record" (SyncRecord), "running" ({serverId, running}), "configUpdated" ({serverId, at}). */
/**
 * Syncer event "auth-synced": a sync run that covered auth.json finished for a server (any
 * trigger: deploy, manual, auto, connect or an OAuth push).
 */
export interface AuthSyncedEvent {
	serverId: string;
	at: number;
	ok: boolean;
	error?: string;
}

export interface Syncer extends EventEmitter {
	inventory(): Promise<HostInventory>;
	status(): Promise<SyncStatusResponse>;
	preview(serverId: string): Promise<SyncPlan>;
	run(serverId: string, trigger: SyncRecord["trigger"]): Promise<SyncRecord>;
	/** Runs servers sequentially-per-server, in parallel across servers. Default: all servers with an agent connection. */
	runMany(serverIds: string[] | undefined, trigger: SyncRecord["trigger"]): Promise<SyncRecord[]>;
	/** Fast path: sync only auth.json to the given (default: all connected, auth enabled) servers. */
	pushAuth(serverIds?: string[]): Promise<Array<{ serverId: string; ok: boolean; error?: string }>>;
	/** Start/stop watching the host agent dir for auto-sync. */
	start(): Promise<void>;
	stop(): Promise<void>;
	/** settings.hostAgentDir changed: watch the new directory and treat its content as changed (no-op unless started). */
	rewatch(): Promise<void>;
	/** Called on every agent (re)connect: syncs when the server is marked pending or auto-sync is on. */
	onAgentConnected(serverId: string): void;
	/** Time of the last sync that changed files on that server. */
	lastChangeAt(serverId: string): number | undefined;
}

export interface OAuthKeeper {
	start(): Promise<void>;
	stop(): Promise<void>;
	/** settings.hostAgentDir changed: watch the new auth.json and re-read it (no-op unless started). */
	rewatch(): Promise<void>;
	status(): Promise<OAuthStatusResponse>;
	refresh(provider: string): Promise<OAuthStatusResponse>;
}

/** Access to the host's own pi installation/configuration. */
export interface HostPi {
	readonly agentDir: string;
	/** Installed host pi version (`pi --version` on PATH, else the bundled dependency's version). */
	version(): Promise<string | null>;
	/** Cached ModelRuntime over the host agent dir (recreated when models.json/auth.json change). */
	modelRuntime(): Promise<ModelRuntime>;
	invalidate(): void;
}

// ---------------------------------------------------------------------------
// Conversations (module: src/conv)
// ---------------------------------------------------------------------------

export interface ConversationService {
	/** On agent connect: conv.list, replay missed events, subscribe to conv.event/conv.info. */
	attach(serverId: string, client: AgentClient): Promise<void>;
	detach(serverId: string): void;
	list(): ConversationView[];
	get(convId: string): ConversationView | undefined;
	open(workspaceId: string, request: OpenConversationRequest): Promise<ConversationView>;
	snapshot(convId: string): Promise<ConversationSnapshot>;
	rpc(convId: string, command: RpcCommand, timeoutMs?: number): Promise<RpcResponse & { seq?: number }>;
	uiResponse(convId: string, response: ExtensionUIResponse): Promise<void>;
	companion(
		convId: string,
		action: "navigate" | "label" | "reload",
		args: Record<string, unknown>,
	): Promise<CompanionActionResponse>;
	stop(convId: string, force?: boolean): Promise<void>;
	replay(convId: string, afterSeq: number): Promise<ConvReplayResult>;
	exportHtml(convId: string): Promise<{ stream: Readable; size: number; fileName: string }>;
}

// ---------------------------------------------------------------------------
// Composition root
// ---------------------------------------------------------------------------

export interface AppContext {
	readonly version: string;
	readonly paths: HostPaths;
	readonly log: Logger;
	readonly store: Store;
	readonly secrets: Secrets;
	readonly hub: EventHub;
	readonly hostPi: HostPi;
	readonly connections: ConnectionManager;
	readonly deployer: Deployer;
	readonly proxy: TunnelProxy;
	readonly syncer: Syncer;
	readonly oauth: OAuthKeeper;
	readonly conversations: ConversationService;
}

/** Error with an API code and HTTP status; routes translate it into ApiErrorBody. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}
}
