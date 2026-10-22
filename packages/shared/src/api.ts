/**
 * Browser ⇄ host contract: REST DTOs (under /api) and WebSocket messages (/ws).
 * Errors: non-2xx responses carry `ApiErrorBody`.
 */
import type {
	ConvEvent,
	ConvInfo,
	ConvSnapshot,
	FsListResult,
	FsReadResult,
	GitDiffResult,
	GitLogResult,
	GitStatusResult,
	SessionsReadResult,
	SessionSummary,
} from "./agent-protocol.js";
import type {
	DeployedInfo,
	HostSettings,
	ProxyConfig,
	ProxyStats,
	ServerAuth,
	ServerConfig,
	ServerRuntimeStatus,
	SyncConfig,
	SyncItemKey,
	WorkspaceConfig,
} from "./models.js";
import type {
	AgentMessage,
	ExtensionUIRequest,
	ExtensionUIResponse,
	PiModel,
	RpcCommand,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	SessionStats,
	SessionTreeNode,
	ThinkingLevel,
} from "./pi.js";

export interface ApiErrorBody {
	error: { code: string; message: string; details?: unknown };
}

// ---------- meta & settings ----------

export interface MetaResponse {
	version: string;
	hostname: string;
	hostAgentDir: string;
	hostPiVersion: string | null;
	dataDir: string;
	/** True when the request was authenticated (or auth is disabled). */
	authenticated: boolean;
}
export type SettingsResponse = HostSettings & {
	/** Only in the response that enabled the access token: the token, for the browser that enabled it. */
	issuedAccessToken?: string;
};
export type UpdateSettingsRequest = Partial<HostSettings>;

// ---------- servers ----------

export interface ServerView {
	config: ServerConfig;
	status: ServerRuntimeStatus;
}

export interface ServerAuthInput extends ServerAuth {
	/** Password or key passphrase; null clears the stored secret, undefined keeps it. */
	secret?: string | null;
}

export interface CreateServerRequest {
	name: string;
	group?: string;
	host: string;
	port?: number;
	username: string;
	auth: ServerAuthInput;
	jumpServerIds?: string[];
	remoteRoot?: string;
	agentDirMode?: "isolated" | "shared";
	proxy?: Partial<ProxyConfig>;
	sync?: Partial<Omit<SyncConfig, "items">> & { items?: Partial<Record<SyncItemKey, boolean>> };
	idleTimeoutMin?: number;
	defaultTrust?: "approve" | "no-approve";
	jumpOnly?: boolean;
}
export type UpdateServerRequest = Partial<CreateServerRequest>;

export interface HostKeyInfo {
	algorithm: string;
	/** "SHA256:<base64>" */
	fingerprint: string;
}
export interface TestConnectionResult {
	ok: boolean;
	error?: string;
	hostKey?: HostKeyInfo;
	hostKeyStatus: "trusted" | "unknown" | "mismatch";
	latencyMs?: number;
}
export interface TrustHostKeyRequest {
	fingerprint: string;
	algorithm: string;
}

export interface ProbeResult {
	os: string;
	arch: string;
	supportedArch: boolean;
	kernel?: string;
	glibc?: string;
	glibcOk: boolean;
	home: string;
	shell?: string;
	diskFreeBytes?: number;
	hasTar: boolean;
	hasGzip: boolean;
	sftp: boolean;
	internet: { reachable: boolean; detail?: string };
	existing?: { agentVersion?: string; piVersion?: string; nodeVersion?: string };
	/** Human-readable blocking problems; empty when deploy can proceed. */
	issues: string[];
	warnings: string[];
}

export interface DeployRequest {
	agentDirMode?: "isolated" | "shared";
	/** Explicit pi version; default from host settings policy. */
	piVersion?: string;
	proxyMode?: "off" | "tunnel";
	proxyScope?: "llm" | "tools";
	/** Re-upload every component even when versions match. */
	force?: boolean;
	/** Run a full sync after install (default true). */
	sync?: boolean;
}
export type DeployStepId =
	| "probe"
	| "prepare"
	| "upload_node"
	| "upload_pi"
	| "upload_agent"
	| "install"
	| "start_agent"
	| "sync"
	| "selfcheck";
export interface DeployStep {
	id: DeployStepId;
	label: string;
	status: "pending" | "running" | "done" | "skipped" | "error";
	detail?: string;
	bytesDone?: number;
	bytesTotal?: number;
}
export interface DeployProgress {
	serverId: string;
	jobId: string;
	state: "running" | "done" | "error" | "cancelled";
	steps: DeployStep[];
	/** Last ~200 log lines. */
	log: string[];
	error?: string;
	startedAt: number;
	finishedAt?: number;
	result?: DeployedInfo;
}

export interface SshConfigHost {
	alias: string;
	hostName?: string;
	user?: string;
	port?: number;
	identityFile?: string;
	proxyJump?: string;
}

export interface UninstallRequest {
	keepSessions: boolean;
}

export interface AgentLogsResponse {
	lines: string[];
}

// ---------- workspaces & files ----------

export interface CreateWorkspaceRequest {
	path: string;
	alias?: string;
	trust?: "approve" | "no-approve";
	defaults?: WorkspaceConfig["defaults"];
	env?: Record<string, string>;
	/** Create the directory when it does not exist. */
	create?: boolean;
}
export type UpdateWorkspaceRequest = Partial<Omit<CreateWorkspaceRequest, "create" | "path">>;

export interface WorkspaceView {
	config: WorkspaceConfig;
	sessionCount?: number;
	runningCount?: number;
}

export type FsListResponse = FsListResult;
export type FsReadResponse = FsReadResult;
export type GitStatusResponse = GitStatusResult;
export type GitDiffResponse = GitDiffResult;
export type GitLogResponse = GitLogResult;
export type SessionListResponse = { sessions: SessionSummary[] };
export type SessionFileResponse = SessionsReadResult;

// ---------- conversations ----------

/** A live conversation process on a server, as known by the host. */
export interface ConversationView {
	convId: string;
	serverId: string;
	workspaceId: string | null;
	info: ConvInfo;
}

export interface OpenConversationRequest {
	/** Resume this session file (absolute remote path); omit for a new session. */
	sessionFile?: string;
	model?: { provider: string; modelId: string };
	thinkingLevel?: ThinkingLevel;
	name?: string;
}

/**
 * Everything the chat view needs to render a live conversation: the agent's atomic
 * ConvSnapshot (apply only events with seq > snapshot.seq) plus host-side context.
 */
export interface ConversationSnapshot {
	convId: string;
	serverId: string;
	workspaceId: string | null;
	snapshot: ConvSnapshot;
	/** True when the host synced new configuration since this process started (reload offered). */
	configStale: boolean;
}

export interface ConversationRpcRequest {
	command: RpcCommand;
	timeoutMs?: number;
}
export type ConversationRpcResponse = RpcResponse;

export interface ConversationUiResponseRequest {
	response: ExtensionUIResponse;
}

export interface NavigateRequest {
	targetId: string;
	summarize?: boolean;
	customInstructions?: string;
	label?: string;
}
export interface LabelRequest {
	entryId: string;
	label?: string;
}
export interface CompanionActionResponse {
	ok: boolean;
	error?: string;
	cancelled?: boolean;
}

export interface TreeResponse {
	tree: SessionTreeNode[];
	leafId: string | null;
}
export interface ModelsResponse {
	models: PiModel[];
}
export interface CommandsResponse {
	commands: RpcSlashCommand[];
}

// ---------- sync ----------

export interface HostInventoryItem {
	key: SyncItemKey;
	label: string;
	present: boolean;
	fileCount: number;
	bytes: number;
	/** Short human-readable summary, e.g. "2 个 API Key · 1 个 OAuth". */
	detail?: string;
}
export interface HostInventory {
	agentDir: string;
	items: HostInventoryItem[];
	scannedAt: number;
}

export interface SyncPlanEntry {
	path: string;
	item: SyncItemKey;
	action: "add" | "update" | "delete";
	/** Target exists on the server with content not written by the last sync; it will be backed up first. */
	conflict: boolean;
	bytes?: number;
	note?: string;
}
export interface SyncPlan {
	serverId: string;
	entries: SyncPlanEntry[];
	summary: { add: number; update: number; delete: number; conflict: number };
	warnings: string[];
	generatedAt: number;
}

export type SyncCellState = "synced" | "pending" | "conflict" | "disabled" | "unknown";
export interface SyncServerStatus {
	serverId: string;
	online: boolean;
	auto: boolean;
	running: boolean;
	lastSyncAt?: number;
	items: Record<SyncItemKey, SyncCellState>;
	pendingCount: number;
}
export interface SyncStatusResponse {
	hostAgentDir: string;
	watching: boolean;
	servers: SyncServerStatus[];
}

export interface SyncRecord {
	id: string;
	serverId: string;
	at: number;
	trigger: "manual" | "auto" | "connect" | "oauth" | "deploy";
	added: number;
	updated: number;
	deleted: number;
	conflicts: number;
	backedUp: string[];
	status: "ok" | "error";
	error?: string;
	durationMs: number;
}
export interface SyncRunRequest {
	/** Default: every server with sync configured. */
	serverIds?: string[];
}
export interface SyncRunResponse {
	records: SyncRecord[];
}

export interface OAuthProviderStatus {
	provider: string;
	expiresAt: number;
	lastRefreshAt?: number;
	/** When the keeper will refresh next (expiresAt - refresh margin). */
	refreshAt: number;
	pushed: Array<{ serverId: string; at?: number; ok: boolean; error?: string }>;
	error?: string;
}
export interface OAuthStatusResponse {
	providers: OAuthProviderStatus[];
}

// ---------- cache ----------

export interface CacheEntry {
	name: string;
	kind: "node" | "pi" | "agent";
	version: string;
	arch?: string;
	bytes: number;
	createdAt: number;
	usedBy: string[];
}
export interface CacheResponse {
	entries: CacheEntry[];
	totalBytes: number;
}

// ---------- WebSocket (/ws) ----------

/**
 * Topics:
 * - "servers"               → ServerRuntimeStatus (one server's status changed)
 * - "convs"                 → ConversationView (a live conversation started/changed/exited)
 * - `conv:${convId}`        → ConvEvent
 * - `deploy:${serverId}`    → DeployProgress
 * - "sync"                  → SyncTopicEvent
 * - "oauth"                 → OAuthStatusResponse
 * - `proxy:${serverId}`     → ProxyStats
 */
export type WsTopic = string;

export type SyncTopicEvent =
	| { kind: "status"; status: SyncStatusResponse }
	| { kind: "record"; record: SyncRecord }
	| { kind: "running"; serverId: string; running: boolean }
	| { kind: "configUpdated"; serverId: string; at: number };

export type WsClientMessage =
	| { type: "subscribe"; topics: WsTopic[] }
	| { type: "unsubscribe"; topics: WsTopic[] }
	| { type: "ping" };

export type WsServerMessage =
	| { type: "hello"; version: string }
	| { type: "event"; topic: WsTopic; data: unknown }
	| { type: "pong" }
	| { type: "error"; message: string };

export type ConvTopicEvent = ConvEvent;
export type ServersTopicEvent = ServerRuntimeStatus;
export type ProxyTopicEvent = ProxyStats;

/**
 * Terminal WebSocket: /ws/term?serverId=…&cwd=…&cols=…&rows=…
 * Binary frames carry terminal bytes both ways. Text frames carry JSON control messages.
 */
export type TermClientControl = { type: "resize"; cols: number; rows: number };
export type TermServerControl = { type: "ready" } | { type: "exit"; code: number | null } | { type: "error"; message: string };
