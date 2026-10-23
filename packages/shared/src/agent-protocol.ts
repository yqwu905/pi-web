/**
 * Requests and events exchanged over the Link between the Pi-Web host and the
 * remote pi-web-agent daemon. The host is the requester for every method below;
 * the agent pushes `AgentEventMap` events.
 *
 * Paths are absolute remote paths unless stated otherwise ("~" is NOT expanded by
 * callers; methods that accept user input call it out explicitly).
 */
import type { ConversationUiState, ToolExecutionState } from "./conversation.js";
import type {
	AgentMessage,
	AssistantMessage,
	ExtensionUIRequest,
	ExtensionUIResponse,
	PiSessionEvent,
	RpcCommand,
	RpcResponse,
	RpcSessionState,
	SessionEntry,
	SessionHeader,
	SessionStats,
	ThinkingLevel,
} from "./pi.js";

export const AGENT_PROTOCOL_VERSION = 1;

// ---------- configuration ----------

export interface AgentProxyConfig {
	/** When false, pi processes get no proxy variables and the agent does not listen. */
	enabled: boolean;
	/** 127.0.0.1 port the agent listens on for HTTP CONNECT / absolute-URI proxy requests. */
	port: number;
	/** Shared secret; clients must send `Proxy-Authorization: Basic base64("pw:" + token)`. */
	token: string;
	/** "llm": strip proxy variables from pi's bash tool (via settings shellCommandPrefix, done by host sync). */
	scope: "llm" | "tools";
	/** Values for NO_PROXY / no_proxy given to pi processes. */
	noProxy: string[];
}

export interface AgentConfig {
	/** Absolute remote install root, e.g. /home/dev/.pi-web */
	remoteRoot: string;
	/** Absolute PI_CODING_AGENT_DIR for pi processes, e.g. /home/dev/.pi-web/agent or /home/dev/.pi/agent */
	agentDir: string;
	/** Absolute path of the node binary used for pi. */
	nodePath: string;
	/** Absolute path of pi's CLI entry (…/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js). */
	piCliPath: string;
	/** Absolute path of the pi package root (…/node_modules/@earendil-works/pi-coding-agent). */
	piPackageDir: string;
	piVersion: string;
	/** Absolute path of the companion extension loaded into every pi process with `-e`. */
	companionExtPath: string;
	proxy: AgentProxyConfig;
	/** Minutes of inactivity after which an idle (not running, no pending dialog) conversation process exits. 0 = never. */
	idleTimeoutMin: number;
	/**
	 * Extra environment variables for every pi process (the server-level env; a conversation's own
	 * env overrides them). The daemon also writes them to R/run/env.sh for R/bin/pi and the web terminal.
	 */
	extraEnv: Record<string, string>;
}

// ---------- hello / status ----------

export interface AgentHelloParams {
	hostVersion: string;
	protocol: number;
}
export interface AgentHelloResult {
	agentVersion: string;
	protocol: number;
	pid: number;
	startedAt: number;
	home: string;
	platform: string;
	arch: string;
	nodeVersion: string;
	remoteRoot: string;
	/** Last configuration applied (persisted in state/config.json), or null before the first configure. */
	config: AgentConfig | null;
}

export type ConvStatus = "starting" | "idle" | "running" | "waiting_ui" | "exited";

export interface ConvInfo {
	convId: string;
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	pid?: number;
	status: ConvStatus;
	startedAt: number;
	lastActivityAt: number;
	/** Sequence number of the last event emitted for this conversation (0 = none). */
	lastSeq: number;
	/** Dialog requests (select/confirm/input/editor) still waiting for an answer. */
	pendingUi: ExtensionUIRequest[];
	/** Latest setStatus/setWidget values, keyed by statusKey/widgetKey (pi-web internal keys excluded). */
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	exitCode?: number | null;
	exitSignal?: string | null;
}

export interface AgentStatus {
	agentVersion: string;
	pid: number;
	uptimeSec: number;
	conversations: ConvInfo[];
	proxy: { listening: boolean; port: number; activeConnections: number };
	diskFreeBytes?: number;
	loadavg: number[];
}

// ---------- conversations ----------

export interface ConvStartParams {
	/** Host-generated id (UUID). Ignored when an existing process already serves `sessionFile`. */
	convId: string;
	cwd: string;
	/** Resume this session file; omit to start a new session in cwd. */
	sessionFile?: string;
	trust: "approve" | "no-approve";
	model?: { provider: string; modelId: string };
	thinkingLevel?: ThinkingLevel;
	/** Initial session name (pi --name). */
	name?: string;
	env?: Record<string, string>;
}
export interface ConvStartResult {
	conv: ConvInfo;
	state: RpcSessionState;
	/** True when an already running process for the same session file was returned. */
	attached: boolean;
}

export interface ConvSendParams {
	convId: string;
	/** Any pi RPC command; the agent assigns the RPC `id` itself. */
	command: RpcCommand;
	/** Default: defaultCommandTimeout(command) (timeouts.ts); covers waiting for a starting process too. */
	timeoutMs?: number;
}
/** pi's response plus the conversation's lastSeq at the moment the response line was read. */
export type ConvSendResult = RpcResponse & { seq: number };

export interface ConvSnapshotParams {
	convId: string;
}
/**
 * Atomic view of a live conversation: `messages` comes from pi's get_messages and the
 * reducer-tracked fields (streaming, tools, queue, ui) are taken at the same point of
 * the event stream, identified by `seq`. Apply only events with seq > snapshot.seq.
 */
export interface ConvSnapshot {
	info: ConvInfo;
	state: RpcSessionState;
	messages: AgentMessage[];
	streaming: AssistantMessage | null;
	streamingToolArgs: Record<number, string>;
	/** Tool executions that have not finished yet. */
	runningTools: ToolExecutionState[];
	queue: { steering: string[]; followUp: string[] };
	ui: ConversationUiState;
	isRunning: boolean;
	isCompacting: boolean;
	stats?: SessionStats;
	seq: number;
	/**
	 * Time left (ms, measured on the agent when the snapshot was taken) of each pending dialog
	 * that has a timeout: pi's own timer started when it asked, not when a viewer opened it.
	 */
	uiRemainingMs?: Record<string, number>;
}

export interface ConvUiResponseParams {
	convId: string;
	response: ExtensionUIResponse;
}
export interface ConvUiResponseResult {
	ok: true;
	/**
	 * False when pi will not use the answer: the dialog was no longer pending (answered elsewhere,
	 * dropped) or its timeout had passed. Absent from older agents.
	 */
	delivered?: boolean;
}

export interface ConvReplayParams {
	convId: string;
	/** Return events with seq > afterSeq. */
	afterSeq: number;
}
export interface ConvReplayResult {
	events: ConvEvent[];
	/** False when the ring buffer no longer holds every event after `afterSeq` (client must resync with get_messages). */
	complete: boolean;
	lastSeq: number;
}

export interface ConvStopParams {
	convId: string;
	/** SIGKILL immediately instead of closing stdin and waiting up to 5s. */
	force?: boolean;
}

/**
 * Actions executed through the companion extension's hidden commands, because pi's
 * RPC has no command for them. The agent sends `/pi-web-<action> <json>` as a prompt
 * and waits for the extension to report back through setStatus("pi-web:result", json).
 */
export type ConvCompanionParams =
	| {
			convId: string;
			action: "navigate";
			args: { targetId: string; summarize?: boolean; customInstructions?: string; label?: string };
	  }
	| { convId: string; action: "label"; args: { entryId: string; label?: string } }
	| { convId: string; action: "reload"; args?: Record<string, never> };
export interface ConvCompanionResult {
	ok: boolean;
	error?: string;
	cancelled?: boolean;
}

/** Synthetic records the agent adds to a conversation's event stream. */
export type PiWebEvent =
	| { type: "pi_web_status"; status: ConvStatus }
	| { type: "pi_web_exit"; code: number | null; signal: string | null; stderrTail: string }
	| { type: "pi_web_stderr"; text: string }
	/** A dialog request is no longer pending (answered by some client, timed out, or process exited). */
	| { type: "pi_web_ui_resolved"; id: string }
	/** Response to a command sent by another client of the same agent (keeps multiple viewers in sync). */
	| { type: "pi_web_session_changed"; sessionFile?: string; sessionId?: string; sessionName?: string };

export type ConvRecord = PiSessionEvent | ExtensionUIRequest | PiWebEvent;

export interface ConvEvent {
	convId: string;
	seq: number;
	ts: number;
	record: ConvRecord;
}

// ---------- sessions on disk ----------

export interface SessionSummary {
	file: string;
	id: string;
	cwd: string;
	name?: string;
	parentSession?: string;
	createdMs: number;
	modifiedMs: number;
	messageCount: number;
	firstMessage: string;
	/** convId of the live process serving this file, if any. */
	runningConvId?: string;
	/** Set by the host (never the agent) when the session is archived in Pi-Web: when, ms since epoch. */
	archivedAt?: number;
}
export interface SessionsListParams {
	cwd: string;
}
export interface SessionsListResult {
	sessions: SessionSummary[];
}
export interface SessionsReadParams {
	file: string;
}
export interface SessionsReadResult {
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	/** Entry ids on the active branch, root first. */
	branchIds: string[];
}
export interface SessionsDeleteParams {
	file: string;
}
export interface SessionsDeleteResult {
	trashedTo: string;
}

// ---------- filesystem ----------

export type FsEntryType = "file" | "dir" | "symlink" | "other";
export interface FsEntry {
	name: string;
	path: string;
	type: FsEntryType;
	/** For symlinks: the type of the target, when resolvable. */
	targetType?: FsEntryType;
	size: number;
	mtimeMs: number;
	/** True when `git check-ignore` reports the path as ignored (only when respectGitignore was requested). */
	ignored?: boolean;
}
export interface FsListParams {
	/** May start with "~". */
	path: string;
	showHidden?: boolean;
	/** Mark (and, when hideIgnored, drop) git-ignored entries. */
	respectGitignore?: boolean;
	hideIgnored?: boolean;
}
export interface FsListResult {
	path: string;
	parent: string | null;
	entries: FsEntry[];
}
export interface FsReadParams {
	path: string;
	/** Default 2 MiB. */
	maxBytes?: number;
}
export interface FsReadResult {
	path: string;
	size: number;
	mtimeMs: number;
	encoding: "utf8" | "base64";
	content: string;
	truncated: boolean;
	binary: boolean;
}
export interface FsStatParams {
	path: string;
}
export interface FsStatResult {
	path: string;
	exists: boolean;
	type?: FsEntryType;
	size?: number;
	mtimeMs?: number;
}
export interface FsMkdirParams {
	path: string;
	recursive?: boolean;
}
export interface FsRealpathParams {
	/** May start with "~". */
	path: string;
}
export interface FsRealpathResult {
	path: string;
}

// ---------- git ----------

export type GitArea = "staged" | "unstaged" | "untracked" | "conflict";
export interface GitFileStatus {
	path: string;
	origPath?: string;
	area: GitArea;
	/** M, A, D, R, C, T, U or ? */
	code: string;
	additions?: number;
	deletions?: number;
	binary?: boolean;
}
export interface GitStatusParams {
	cwd: string;
}
export interface GitStatusResult {
	isRepo: boolean;
	root?: string;
	branch?: string;
	detached?: boolean;
	upstream?: string;
	ahead: number;
	behind: number;
	headShort?: string;
	files: GitFileStatus[];
}
export interface GitDiffParams {
	cwd: string;
	path?: string;
	area: "staged" | "unstaged" | "untracked";
	contextLines?: number;
}
export interface GitDiffResult {
	/** Unified diff text (git diff --no-color --no-ext-diff). */
	diff: string;
	truncated: boolean;
}
export interface GitLogParams {
	cwd: string;
	limit?: number;
}
export interface GitCommit {
	hash: string;
	short: string;
	subject: string;
	author: string;
	email: string;
	dateMs: number;
	refs?: string;
}
export interface GitLogResult {
	commits: GitCommit[];
}

// ---------- sync ----------

export interface SyncFileInfo {
	size: number;
	mtimeMs: number;
	/** sha256 of the content; for symlinks sha256 of "symlink:" + target. */
	sha256: string;
	/** Present for symlinks: the link target (as stored, not resolved). */
	link?: string;
}
export interface SyncManifestParams {
	/** Top-level names under agentDir to scan, e.g. ["settings.json", "extensions", "npm"]. */
	roots: string[];
}
export interface SyncManifestResult {
	agentDir: string;
	/** Relative POSIX paths under agentDir → current file info (regular files and symlinks; directories omitted). */
	files: Record<string, SyncFileInfo>;
	/** Relative path → sha256 written by the last sync (from state/sync-manifest.json). */
	managed: Record<string, string>;
}
export interface SyncApplyParams {
	/** Absolute remote path of an uploaded tar.gz whose entries are relative paths under agentDir; null when only deleting. */
	archivePath: string | null;
	/** Files contained in the archive with their expected sha256 (verified after extraction). */
	writes: Array<{ path: string; sha256: string; mode?: number; link?: string }>;
	deletes: string[];
	/**
	 * Files already identical to the host: recorded as managed (when their current sha256 still
	 * matches) without being written, so later host deletions reach them.
	 */
	adopt?: Array<{ path: string; sha256: string }>;
	/** Label for the backup folder: state/backup/<backupLabel>/ (shared agent dir: <agentDir>/.pi-web-backup/<backupLabel>/). */
	backupLabel: string;
}
export interface SyncApplyResult {
	written: number;
	deleted: number;
	/** Relative paths that existed with content not written by the last sync and were backed up before overwrite/delete. */
	backedUp: string[];
	backupDir?: string;
	errors: Array<{ path: string; error: string }>;
}

// ---------- misc ----------

export interface AgentLogsParams {
	tail?: number;
}
export interface AgentLogsResult {
	lines: string[];
}

/** Meta sent with Link.openStream by the agent's proxy listener. */
export interface ProxyStreamMeta {
	kind: "proxy";
	host: string;
	port: number;
	/** "connect" for CONNECT tunnels, "http" for absolute-URI requests (already rewritten to origin-form). */
	protocol: "connect" | "http";
}

/** Method name → [params, result]. */
export interface AgentMethodMap {
	hello: [AgentHelloParams, AgentHelloResult];
	"agent.configure": [AgentConfig, { ok: true }];
	"agent.status": [Record<string, never> | undefined, AgentStatus];
	"agent.logs": [AgentLogsParams, AgentLogsResult];
	"agent.shutdown": [Record<string, never> | undefined, { ok: true }];
	"conv.start": [ConvStartParams, ConvStartResult];
	"conv.list": [Record<string, never> | undefined, { conversations: ConvInfo[] }];
	"conv.send": [ConvSendParams, ConvSendResult];
	"conv.snapshot": [ConvSnapshotParams, ConvSnapshot];
	"conv.uiResponse": [ConvUiResponseParams, ConvUiResponseResult];
	"conv.replay": [ConvReplayParams, ConvReplayResult];
	"conv.stop": [ConvStopParams, { ok: true }];
	"conv.companion": [ConvCompanionParams, ConvCompanionResult];
	"sessions.list": [SessionsListParams, SessionsListResult];
	"sessions.read": [SessionsReadParams, SessionsReadResult];
	"sessions.delete": [SessionsDeleteParams, SessionsDeleteResult];
	"fs.list": [FsListParams, FsListResult];
	"fs.read": [FsReadParams, FsReadResult];
	"fs.stat": [FsStatParams, FsStatResult];
	"fs.mkdir": [FsMkdirParams, { ok: true }];
	"fs.realpath": [FsRealpathParams, FsRealpathResult];
	"git.status": [GitStatusParams, GitStatusResult];
	"git.diff": [GitDiffParams, GitDiffResult];
	"git.log": [GitLogParams, GitLogResult];
	"sync.manifest": [SyncManifestParams, SyncManifestResult];
	"sync.apply": [SyncApplyParams, SyncApplyResult];
}
export type AgentMethod = keyof AgentMethodMap;
export type AgentParams<M extends AgentMethod> = AgentMethodMap[M][0];
export type AgentResult<M extends AgentMethod> = AgentMethodMap[M][1];

/** Event name → payload, pushed by the agent. */
export interface AgentEventMap {
	"conv.event": ConvEvent;
	/** Conversation list changed (started/exited/status) — carries the updated ConvInfo. */
	"conv.info": ConvInfo;
	"agent.log": { ts: number; level: "debug" | "info" | "warn" | "error"; msg: string };
}
export type AgentEventName = keyof AgentEventMap;

/** Prefix of the companion extension's hidden commands; UIs should hide commands starting with it. */
export const COMPANION_COMMAND_PREFIX = "pi-web-";
/** statusKey the companion extension uses to report command results: JSON {reqId, ok, error?, cancelled?}. */
export const COMPANION_STATUS_KEY = "pi-web:result";
