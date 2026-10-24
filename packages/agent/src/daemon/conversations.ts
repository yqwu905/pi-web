import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	type AgentConfig,
	type AgentEventMap,
	applyConvRecord,
	COMPANION_COMMAND_PREFIX,
	COMPANION_STATUS_KEY,
	companionActionTimeout,
	CONV_SNAPSHOT_TIMEOUT_MS,
	CONV_START_TIMEOUT_MS,
	type ConvCompanionParams,
	type ConvCompanionResult,
	type ConversationState,
	type ConvEvent,
	type ConvInfo,
	type ConvRecord,
	type ConvReplayParams,
	type ConvReplayResult,
	type ConvSendParams,
	type ConvSendResult,
	type ConvSnapshot,
	type ConvSnapshotParams,
	type ConvStartParams,
	type ConvStartResult,
	type ConvStatus,
	type ConvStopParams,
	type ConvUiResponseParams,
	type ConvUiResponseResult,
	createConversationState,
	defaultCommandTimeout,
	EXTENSION_UI_DIALOG_METHODS,
	type ExtensionUIRequest,
	isPlainObject,
	type PiWebEvent,
	type RpcCommand,
	type RpcResponse,
	RPC_TIMEOUT_MS,
	type RpcSessionState,
	type SessionStats,
} from "@pi-web/shared";
import { piProxyEnv, PROXY_ENV_NAMES } from "./config.js";
import { AgentError, errorMessage } from "./errors.js";
import { JsonlLineDecoder } from "./jsonl.js";
import type { AgentLogger } from "./logger.js";
import type { RemotePaths } from "./paths.js";
import { RingBuffer } from "./ring.js";

const MINUTE = 60_000;
const DEFAULT_TIMEOUT_MS = RPC_TIMEOUT_MS;
const SESSION_CHANGING_COMMANDS = new Set(["new_session", "switch_session", "fork", "clone"]);
/** Read-only commands; they do not count as activity for the idle reaper. */
const QUERY_COMMANDS = new Set([
	"get_state",
	"get_messages",
	"get_session_stats",
	"get_available_models",
	"get_available_thinking_levels",
	"get_commands",
	"get_fork_messages",
	"get_entries",
	"get_tree",
	"get_last_assistant_text",
]);
const STDERR_TAIL_BYTES = 64 * 1024;
const EXIT_STDERR_BYTES = 4 * 1024;
const STDERR_LINES_PER_SEC = 20;
const STDERR_MAX_LINE = 8 * 1024;

export interface ConversationManagerOptions {
	paths: RemotePaths;
	getConfig: () => AgentConfig | null;
	emit: <E extends keyof AgentEventMap>(event: E, data: AgentEventMap[E]) => void;
	log: Pick<AgentLogger, "debug" | "info" | "warn" | "error">;
	/** Ring buffer size per conversation. Default 3000. */
	ringSize?: number;
	/** Byte budget of each ring buffer (approximate JSON size). Default 32 MiB. */
	ringMaxBytes?: number;
	/** How long exited conversations stay available for replay. Default 10 min. */
	retentionMs?: number;
	/** Delay between closing stdin and SIGTERM. Default 5s. */
	stopGraceMs?: number;
	/** Delay between SIGTERM and SIGKILL. Default 3s. */
	killGraceMs?: number;
	/**
	 * Force stop: delay between SIGTERM and SIGKILL. Default 1s. pi's SIGTERM handler kills the
	 * detached process groups of its bash tool; SIGKILL alone would leave them running.
	 */
	forceKillGraceMs?: number;
	/** Timeout of the initial get_state. Default 60s (must stay below CONV_START_TIMEOUT_MS). */
	startTimeoutMs?: number;
	/** Total budget of start() when it attaches to an existing process. Default CONV_START_TIMEOUT_MS. */
	attachTimeoutMs?: number;
	/** Total budget of snapshot(). Default CONV_SNAPSHOT_TIMEOUT_MS. */
	snapshotTimeoutMs?: number;
	/** Idle reaper interval. Default 60s. */
	reapIntervalMs?: number;
	/** Base environment for pi processes. Default process.env. */
	baseEnv?: NodeJS.ProcessEnv;
}

interface RpcOutcome {
	response: RpcResponse;
	/** lastSeq at the moment the response line was read. */
	seq: number;
	/** Tracker state at the same moment. */
	tracker: ConversationState;
}

interface PendingRpc {
	command: string;
	/** An extension slash command: pi answers only after its handler finished. */
	slash: boolean;
	resolve: (outcome: RpcOutcome) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

interface CompanionWaiter {
	resolve: (result: ConvCompanionResult) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

/** Context of a pending extension dialog, used to drop dialogs pi stopped waiting for. */
interface DialogContext {
	/** Run (agent_start count) during which it was requested; null when no run was active. */
	runId: number | null;
	/** Pending slash-command RPCs at request time. */
	slashRpcIds: Set<string>;
	/** pi resolves timed dialogs itself (our timer mirrors it). */
	hasTimeout: boolean;
	timeoutMs?: number;
	requestedAt: number;
}

class Conversation {
	readonly info: ConvInfo;
	readonly ring: RingBuffer<ConvEvent>;
	tracker: ConversationState = createConversationState();
	readonly pending = new Map<string, PendingRpc>();
	readonly companions = new Map<string, CompanionWaiter>();
	readonly uiTimers = new Map<string, NodeJS.Timeout>();
	readonly dialogs = new Map<string, DialogContext>();
	/** Number of agent_start events seen (identifies the current run). */
	runId = 0;
	readonly stdoutDecoder = new JsonlLineDecoder();
	readonly stderrDecoder = new StringDecoder("utf8");
	stderrTail = "";
	stderrPartial = "";
	stderrWindowStart = 0;
	stderrWindowCount = 0;
	stderrDropped = 0;
	started = false;
	exited = false;
	exitInfo: { code: number | null; signal: string | null } | null = null;
	stdoutEnded = false;
	stderrEnded = false;
	companionAvailable = false;
	/** Proxy token in this process's environment (accepted by the proxy until it exits). */
	proxyToken?: string;
	finalizeTimer?: NodeJS.Timeout;
	removalTimer?: NodeJS.Timeout;
	stopTimers: NodeJS.Timeout[] = [];
	ready!: Promise<RpcSessionState>;
	readonly exitPromise: Promise<void>;
	resolveExit!: () => void;

	constructor(
		readonly child: ChildProcess,
		info: ConvInfo,
		ringSize: number,
		ringMaxBytes: number,
	) {
		this.info = info;
		this.ring = new RingBuffer<ConvEvent>(ringSize, ringMaxBytes);
		this.exitPromise = new Promise((resolvePromise) => {
			this.resolveExit = resolvePromise;
		});
	}
}

/**
 * One budget shared by the steps of a multi-step operation, so the operation as a whole
 * honours the timeout the host waits for (see @pi-web/shared timeouts).
 */
class Deadline {
	private readonly at: number;

	constructor(
		private readonly budgetMs: number,
		private readonly what: string,
	) {
		this.at = Date.now() + budgetMs;
	}

	error(): AgentError {
		return new AgentError("TIMEOUT", `${this.what}超时（${Math.round(this.budgetMs / 1000)} 秒）`);
	}

	/** Milliseconds left, at most `cap`; throws TIMEOUT once the deadline has passed. */
	remaining(cap = Number.POSITIVE_INFINITY): number {
		const left = this.at - Date.now();
		if (left <= 0) throw this.error();
		return Math.min(left, cap);
	}

	/** Waits for `promise`, failing with TIMEOUT when the deadline passes first. */
	async wait<T>(promise: Promise<T>): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		const expired = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(this.error()), Math.max(0, this.at - Date.now()));
		});
		try {
			return await Promise.race([promise, expired]);
		} finally {
			clearTimeout(timer);
		}
	}
}

/** argv for the pi process (argv[0] is the CLI script, run with config.nodePath). */
export function buildPiArgs(config: AgentConfig, params: ConvStartParams, sessionFile?: string): string[] {
	const args = [config.piCliPath, "--mode", "rpc"];
	if (sessionFile) args.push("--session", sessionFile);
	args.push(params.trust === "approve" ? "--approve" : "--no-approve");
	args.push("-e", config.companionExtPath);
	if (params.model?.provider && params.model.modelId) args.push("--model", `${params.model.provider}/${params.model.modelId}`);
	if (params.thinkingLevel) args.push("--thinking", params.thinkingLevel);
	if (params.name) args.push("--name", params.name);
	return args;
}

export function buildPiEnv(
	config: AgentConfig,
	paths: RemotePaths,
	params: Pick<ConvStartParams, "env">,
	baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	const proxyNames: readonly string[] = PROXY_ENV_NAMES;
	for (const [key, value] of Object.entries(baseEnv)) {
		if (value !== undefined && !proxyNames.includes(key)) env[key] = value;
	}
	env.PI_CODING_AGENT_DIR = config.agentDir;
	env.PI_OFFLINE = "1";
	env.PI_SKIP_VERSION_CHECK = "1";
	env.PI_TELEMETRY = "0";
	Object.assign(env, piProxyEnv(config.proxy));
	for (const extra of [config.extraEnv, params.env]) {
		if (!extra) continue;
		for (const [key, value] of Object.entries(extra)) if (typeof value === "string") env[key] = value;
	}
	env.PATH = [paths.binDir, dirname(config.nodePath), env.PATH].filter((p) => p).join(":");
	return env;
}

function copyInfo(info: ConvInfo): ConvInfo {
	return { ...info, pendingUi: [...info.pendingUi], statuses: { ...info.statuses }, widgets: { ...info.widgets } };
}

/**
 * Keeps only what snapshots need from the reducer state (messages come from get_messages).
 * Timing stays: the reducer bounds it and snapshots carry it.
 */
function compactTracker(state: ConversationState): ConversationState {
	let next = state;
	if (next.messages.length > 0) next = { ...next, messages: [] };
	const tools = Object.values(next.tools);
	if (tools.some((t) => t.status !== "running")) {
		next = { ...next, tools: Object.fromEntries(tools.filter((t) => t.status === "running").map((t) => [t.toolCallId, t])) };
	}
	if (Object.keys(next.bashOutput).length > 0) next = { ...next, bashOutput: {} };
	return next;
}

/**
 * Owns one `pi --mode rpc` child process per conversation: strict JSONL framing,
 * request/response correlation, event sequencing with a replay ring buffer, a reducer
 * tracker for atomic snapshots, extension UI bookkeeping and the companion round-trip.
 */
export class ConversationManager {
	private readonly convs = new Map<string, Conversation>();
	/** Resolved session file path → convId of the live process serving it. */
	private readonly sessionIndex = new Map<string, string>();
	private nextRpcId = 0;
	private reaper?: NodeJS.Timeout;
	private readonly ringSize: number;
	private readonly ringMaxBytes: number;
	private readonly retentionMs: number;
	private readonly stopGraceMs: number;
	private readonly killGraceMs: number;
	private readonly forceKillGraceMs: number;
	private readonly startTimeoutMs: number;
	private readonly attachTimeoutMs: number;
	private readonly snapshotTimeoutMs: number;

	constructor(private readonly options: ConversationManagerOptions) {
		this.ringSize = options.ringSize ?? 3000;
		this.ringMaxBytes = options.ringMaxBytes ?? 32 * 1024 * 1024;
		this.retentionMs = options.retentionMs ?? 10 * MINUTE;
		this.stopGraceMs = options.stopGraceMs ?? 5000;
		this.killGraceMs = options.killGraceMs ?? 3000;
		this.forceKillGraceMs = options.forceKillGraceMs ?? 1000;
		this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
		this.attachTimeoutMs = options.attachTimeoutMs ?? CONV_START_TIMEOUT_MS;
		this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? CONV_SNAPSHOT_TIMEOUT_MS;
		const interval = options.reapIntervalMs ?? MINUTE;
		if (interval > 0) {
			this.reaper = setInterval(() => this.reapIdle(Date.now()), interval);
			this.reaper.unref();
		}
	}

	list(): ConvInfo[] {
		return [...this.convs.values()].map((c) => copyInfo(c.info));
	}

	get(convId: string): ConvInfo | undefined {
		const conv = this.convs.get(convId);
		return conv ? copyInfo(conv.info) : undefined;
	}

	/** Live (not exited) conversation serving this session file. */
	findBySessionFile(file: string): ConvInfo | undefined {
		const convId = this.sessionIndex.get(resolve(file));
		const conv = convId ? this.convs.get(convId) : undefined;
		return conv && !conv.exited ? copyInfo(conv.info) : undefined;
	}

	/** Proxy tokens of live pi processes. */
	liveProxyTokens(): string[] {
		const tokens: string[] = [];
		for (const conv of this.convs.values()) if (!conv.exited && conv.proxyToken) tokens.push(conv.proxyToken);
		return tokens;
	}

	get liveCount(): number {
		let n = 0;
		for (const conv of this.convs.values()) if (!conv.exited) n++;
		return n;
	}

	async start(params: ConvStartParams): Promise<ConvStartResult> {
		const config = this.options.getConfig();
		if (!config) throw new AgentError("NOT_CONFIGURED", "Agent 尚未配置");
		if (!params || typeof params.convId !== "string" || !params.convId) throw new AgentError("BAD_PARAMS", "缺少 convId");
		if (typeof params.cwd !== "string" || !isAbsolute(params.cwd)) throw new AgentError("BAD_PARAMS", "工作区路径必须是绝对路径");
		if (params.sessionFile !== undefined && (typeof params.sessionFile !== "string" || !isAbsolute(params.sessionFile))) {
			throw new AgentError("BAD_PARAMS", "会话文件路径必须是绝对路径");
		}
		const cwd = resolve(params.cwd);
		const sessionFile = params.sessionFile ? resolve(params.sessionFile) : undefined;

		const running = this.findRunning(params.convId, sessionFile);
		if (running) return this.attach(running);

		const cwdStat = await stat(cwd).catch(() => null);
		if (!cwdStat?.isDirectory()) throw new AgentError("CWD_NOT_FOUND", `工作区目录不存在：${cwd}`);
		if (sessionFile) {
			const fileStat = await stat(sessionFile).catch(() => null);
			if (!fileStat?.isFile()) throw new AgentError("SESSION_NOT_FOUND", `会话文件不存在：${sessionFile}`);
		}
		// A concurrent start may have spawned the process while we were checking the paths.
		const raced = this.findRunning(params.convId, sessionFile);
		if (raced) return this.attach(raced);
		const existing = this.convs.get(params.convId);
		if (existing) this.forget(existing);

		const args = buildPiArgs(config, params, sessionFile);
		const env = buildPiEnv(config, this.options.paths, params, this.options.baseEnv);
		const child = spawn(config.nodePath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const now = Date.now();
		const conv = new Conversation(
			child,
			{
				convId: params.convId,
				cwd,
				sessionFile,
				sessionName: params.name,
				pid: child.pid,
				status: "starting",
				startedAt: now,
				lastActivityAt: now,
				lastSeq: 0,
				pendingUi: [],
				statuses: {},
				widgets: {},
			},
			this.ringSize,
			this.ringMaxBytes,
		);
		if (config.proxy.enabled) conv.proxyToken = config.proxy.token;
		this.convs.set(conv.info.convId, conv);
		if (sessionFile) this.sessionIndex.set(sessionFile, conv.info.convId);
		this.wireProcess(conv);
		this.options.log.info("conversation starting", { convId: conv.info.convId, cwd, pid: child.pid, sessionFile });
		this.emitInfo(conv);
		conv.ready = this.initialize(conv);
		conv.ready.catch(() => {});
		const state = await conv.ready;
		return { conv: copyInfo(conv.info), state, attached: false };
	}

	async send(params: ConvSendParams): Promise<ConvSendResult> {
		const conv = this.requireLive(params?.convId);
		const command = params.command as RpcCommand;
		if (!isPlainObject(command) || typeof command.type !== "string") throw new AgentError("BAD_PARAMS", "无效的 RPC 命令");
		const { id: _ignored, ...rest } = command;
		const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : defaultCommandTimeout(command);
		// The timeout covers waiting for a still-starting process too: the host waits exactly this long.
		const deadline = new Deadline(timeoutMs, `pi 命令 ${command.type} `);
		await deadline.wait(conv.ready);
		const outcome = await this.rpc(conv, rest as RpcCommand, deadline.remaining());
		const data = outcome.response.data as { cancelled?: boolean } | undefined;
		if (outcome.response.success && SESSION_CHANGING_COMMANDS.has(command.type) && !data?.cancelled) {
			await this.refreshSession(conv).catch((err) =>
				this.options.log.warn("session refresh failed", { convId: conv.info.convId, error: errorMessage(err) }),
			);
		}
		return { ...outcome.response, seq: outcome.seq };
	}

	async snapshot(params: ConvSnapshotParams): Promise<ConvSnapshot> {
		const conv = this.requireLive(params?.convId);
		const deadline = new Deadline(this.snapshotTimeoutMs, "读取会话快照");
		await deadline.wait(conv.ready);
		const stateOutcome = await this.rpc(conv, { type: "get_state" }, deadline.remaining(DEFAULT_TIMEOUT_MS));
		if (!stateOutcome.response.success) throw new AgentError("RPC_FAILED", stateOutcome.response.error ?? "get_state 失败");
		const state = stateOutcome.response.data as RpcSessionState;
		this.applyState(conv, state);
		const messagesOutcome = await this.rpc(conv, { type: "get_messages" }, deadline.remaining(DEFAULT_TIMEOUT_MS));
		if (!messagesOutcome.response.success) throw new AgentError("RPC_FAILED", messagesOutcome.response.error ?? "get_messages 失败");
		let stats: SessionStats | undefined;
		try {
			const statsOutcome = await this.rpc(conv, { type: "get_session_stats" }, deadline.remaining(DEFAULT_TIMEOUT_MS));
			if (statsOutcome.response.success) stats = statsOutcome.response.data as SessionStats;
		} catch {
			// stats are optional
		}
		const t = messagesOutcome.tracker;
		const uiRemainingMs: Record<string, number> = {};
		const now = Date.now();
		for (const request of t.ui.pending) {
			const dialog = conv.dialogs.get(request.id);
			if (dialog?.timeoutMs) uiRemainingMs[request.id] = Math.max(0, dialog.timeoutMs - (now - dialog.requestedAt));
		}
		return {
			info: copyInfo(conv.info),
			state,
			messages: (messagesOutcome.response.data as { messages?: ConvSnapshot["messages"] } | undefined)?.messages ?? [],
			streaming: t.streaming,
			streamingToolArgs: t.streamingToolArgs,
			runningTools: Object.values(t.tools).filter((tool) => tool.status === "running"),
			queue: t.queue,
			ui: t.ui,
			isRunning: t.isRunning,
			isCompacting: t.isCompacting,
			stats,
			seq: messagesOutcome.seq,
			uiRemainingMs,
			timing: t.timing,
		};
	}

	uiResponse(params: ConvUiResponseParams): ConvUiResponseResult {
		const conv = this.requireLive(params?.convId);
		const response = params.response;
		if (!isPlainObject(response) || typeof response.id !== "string") throw new AgentError("BAD_PARAMS", "无效的对话框响应");
		if (!conv.info.pendingUi.some((r) => r.id === response.id)) return { ok: true, delivered: false };
		// pi already took the default answer of a timed dialog and ignores a late one.
		const dialog = conv.dialogs.get(response.id);
		const late = dialog?.timeoutMs !== undefined && Date.now() - dialog.requestedAt >= dialog.timeoutMs;
		this.write(conv, { ...response, type: "extension_ui_response" }, true);
		this.resolveUi(conv, response.id);
		return { ok: true, delivered: !late };
	}

	replay(params: ConvReplayParams): ConvReplayResult {
		const conv = this.convs.get(params?.convId);
		if (!conv) throw new AgentError("CONV_NOT_FOUND", "会话进程不存在");
		const afterSeq = Number(params.afterSeq) || 0;
		const events = conv.ring.tailWhile((e) => e.seq > afterSeq);
		const first = conv.ring.first();
		const complete = !first || first.seq <= afterSeq + 1;
		return { events, complete, lastSeq: conv.info.lastSeq };
	}

	async stop(params: ConvStopParams): Promise<{ ok: true }> {
		const conv = this.convs.get(params?.convId);
		if (!conv) throw new AgentError("CONV_NOT_FOUND", "会话进程不存在");
		await this.terminate(conv, Boolean(params.force));
		return { ok: true };
	}

	async companion(params: ConvCompanionParams): Promise<ConvCompanionResult> {
		const conv = this.requireLive(params?.convId);
		const action = params.action;
		if (action !== "navigate" && action !== "label" && action !== "reload") {
			throw new AgentError("BAD_PARAMS", `未知操作：${String(action)}`);
		}
		// navigate and reload first wait for the agent to become idle; one budget covers every step.
		const deadline = new Deadline(companionActionTimeout(action), "操作");
		await deadline.wait(conv.ready);
		const commandName = `${COMPANION_COMMAND_PREFIX}${action}`;
		if (!conv.companionAvailable) {
			const outcome = await this.rpc(conv, { type: "get_commands" }, deadline.remaining(DEFAULT_TIMEOUT_MS));
			const commands = (outcome.response.data as { commands?: Array<{ name?: string }> } | undefined)?.commands ?? [];
			if (!commands.some((c) => c.name === commandName)) {
				throw new AgentError("COMPANION_UNAVAILABLE", "Pi-Web 伴随扩展未加载，无法执行该操作");
			}
			conv.companionAvailable = true;
		}
		const reqId = randomUUID();
		const timeoutMs = deadline.remaining();
		const payload = { ...(params.args ?? {}), reqId };
		const message = `/${commandName} ${JSON.stringify(payload)}`;

		const result = new Promise<ConvCompanionResult>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				conv.companions.delete(reqId);
				reject(deadline.error());
			}, timeoutMs);
			conv.companions.set(reqId, { resolve: resolvePromise, reject, timer });
		});
		const settleWaiter = (value: ConvCompanionResult | Error) => {
			const waiter = conv.companions.get(reqId);
			if (!waiter) return;
			conv.companions.delete(reqId);
			clearTimeout(waiter.timer);
			if (value instanceof Error) waiter.reject(value);
			else waiter.resolve(value);
		};
		this.rpc(conv, { type: "prompt", message }, timeoutMs).then(
			({ response }) => {
				// The extension reports through setStatus before pi answers the prompt, so a
				// waiter that is still pending here never got a result.
				if (!response.success) settleWaiter({ ok: false, error: response.error ?? "命令执行失败" });
				else settleWaiter({ ok: false, error: "伴随扩展未返回结果" });
			},
			(err: Error) => settleWaiter(err),
		);
		const outcome = await result;
		if (action === "navigate" && outcome.ok && !outcome.cancelled) {
			await this.refreshSession(conv).catch(() => {});
		}
		return outcome;
	}

	/** Stops every live conversation (close stdin → SIGTERM → SIGKILL) and waits for them. */
	async shutdownAll(): Promise<void> {
		await Promise.all([...this.convs.values()].filter((c) => !c.exited).map((c) => this.terminate(c, false)));
	}

	dispose(): void {
		if (this.reaper) clearInterval(this.reaper);
		for (const conv of this.convs.values()) {
			if (conv.removalTimer) clearTimeout(conv.removalTimer);
			// SIGTERM first: pi's handler kills its bash tool's process groups.
			if (!conv.exited) this.killNow(conv);
		}
	}

	/** Stops idle conversations whose inactivity exceeds config.idleTimeoutMin. */
	reapIdle(now: number): void {
		const minutes = this.options.getConfig()?.idleTimeoutMin ?? 0;
		if (!(minutes > 0)) return;
		for (const conv of this.convs.values()) {
			if (conv.exited || conv.info.status !== "idle") continue;
			if (conv.info.pendingUi.length > 0 || conv.pending.size > 0 || conv.companions.size > 0) continue;
			if (conv.tracker.isCompacting) continue;
			if (now - conv.info.lastActivityAt <= minutes * MINUTE) continue;
			this.options.log.info("stopping idle conversation", { convId: conv.info.convId, idleMin: minutes });
			void this.terminate(conv, false);
		}
	}

	// ---------------------------------------------------------------------------

	/** The live process with this convId or serving this session file, if any. */
	private findRunning(convId: string, sessionFile: string | undefined): Conversation | undefined {
		if (sessionFile) {
			const servingId = this.sessionIndex.get(sessionFile);
			const serving = servingId ? this.convs.get(servingId) : undefined;
			if (serving && !serving.exited) return serving;
		}
		const existing = this.convs.get(convId);
		return existing && !existing.exited ? existing : undefined;
	}

	private requireLive(convId: string | undefined): Conversation {
		const conv = convId ? this.convs.get(convId) : undefined;
		if (!conv) throw new AgentError("CONV_NOT_FOUND", "会话进程不存在");
		if (conv.exited) throw new AgentError("CONV_EXITED", "会话进程已退出");
		return conv;
	}

	/** Returns an existing process; waiting for it to start and refreshing its state share one budget. */
	private async attach(conv: Conversation): Promise<ConvStartResult> {
		const deadline = new Deadline(this.attachTimeoutMs, "等待会话启动");
		const initial = await deadline.wait(conv.ready);
		let state = initial;
		try {
			const outcome = await this.rpc(conv, { type: "get_state" }, deadline.remaining(DEFAULT_TIMEOUT_MS));
			if (outcome.response.success) state = outcome.response.data as RpcSessionState;
		} catch {
			// fall back to the initial state
		}
		this.applyState(conv, state);
		return { conv: copyInfo(conv.info), state, attached: true };
	}

	private async initialize(conv: Conversation): Promise<RpcSessionState> {
		try {
			const outcome = await this.rpc(conv, { type: "get_state" }, this.startTimeoutMs);
			if (!outcome.response.success) throw new Error(outcome.response.error ?? "get_state failed");
			const state = outcome.response.data as RpcSessionState;
			conv.started = true;
			this.applyState(conv, state);
			if (!this.updateStatus(conv)) this.emitInfo(conv);
			this.options.log.info("conversation ready", { convId: conv.info.convId, sessionFile: conv.info.sessionFile });
			return state;
		} catch (err) {
			if (!conv.exited) conv.child.kill("SIGKILL");
			await Promise.race([conv.exitPromise, new Promise((r) => setTimeout(r, 3000).unref())]);
			const tail = conv.stderrTail.trim().slice(-2000);
			throw new AgentError("START_FAILED", `pi 启动失败：${errorMessage(err)}${tail ? `\n${tail}` : ""}`);
		}
	}

	private wireProcess(conv: Conversation): void {
		const { child } = conv;
		child.stdout?.on("data", (chunk: Buffer) => {
			for (const line of conv.stdoutDecoder.push(chunk)) this.onLine(conv, line);
		});
		child.stdout?.on("close", () => {
			if (conv.stdoutEnded) return;
			for (const line of conv.stdoutDecoder.end()) this.onLine(conv, line);
			conv.stdoutEnded = true;
			this.maybeFinalize(conv);
		});
		child.stderr?.on("data", (chunk: Buffer) => this.onStderr(conv, conv.stderrDecoder.write(chunk)));
		child.stderr?.on("close", () => {
			conv.stderrEnded = true;
			this.onStderr(conv, conv.stderrDecoder.end());
			if (conv.stderrPartial) {
				this.forwardStderrLine(conv, conv.stderrPartial);
				conv.stderrPartial = "";
			}
			this.maybeFinalize(conv);
		});
		child.stdin?.on("error", () => {});
		child.on("error", (err) => {
			this.options.log.error("pi process error", { convId: conv.info.convId, error: err.message });
			conv.stderrTail = `${conv.stderrTail}${err.message}\n`.slice(-STDERR_TAIL_BYTES);
			if (child.pid === undefined && !conv.exitInfo) {
				conv.exitInfo = { code: null, signal: null };
				conv.stdoutEnded = true;
				conv.stderrEnded = true;
				this.maybeFinalize(conv);
			}
		});
		child.on("exit", (code, signal) => {
			conv.exitInfo = { code, signal };
			this.maybeFinalize(conv);
			// A grandchild may keep stdout/stderr open; do not wait for it forever.
			if (!conv.exited) conv.finalizeTimer = setTimeout(() => this.finalize(conv), 2000);
		});
	}

	private maybeFinalize(conv: Conversation): void {
		if (conv.exitInfo && conv.stdoutEnded && conv.stderrEnded) this.finalize(conv);
	}

	private finalize(conv: Conversation): void {
		if (conv.exited) return;
		if (!conv.stdoutEnded) {
			for (const line of conv.stdoutDecoder.end()) this.onLine(conv, line);
		}
		conv.exited = true;
		if (conv.finalizeTimer) clearTimeout(conv.finalizeTimer);
		for (const timer of conv.stopTimers) clearTimeout(timer);
		for (const timer of conv.uiTimers.values()) clearTimeout(timer);
		conv.uiTimers.clear();
		conv.dialogs.clear();
		const { code, signal } = conv.exitInfo ?? { code: null, signal: null };
		conv.info.exitCode = code;
		conv.info.exitSignal = signal;
		conv.info.pendingUi = [];
		this.emitRecord(conv, { type: "pi_web_exit", code, signal, stderrTail: conv.stderrTail.slice(-EXIT_STDERR_BYTES) });
		this.updateStatus(conv);
		const exitErr = () => new AgentError("CONV_EXITED", `pi 进程已退出（${signal ?? `退出码 ${code}`}）`);
		for (const [id, pending] of conv.pending) {
			clearTimeout(pending.timer);
			pending.reject(exitErr());
			conv.pending.delete(id);
		}
		for (const [id, waiter] of conv.companions) {
			clearTimeout(waiter.timer);
			waiter.reject(exitErr());
			conv.companions.delete(id);
		}
		this.unindex(conv);
		this.options.log.info("conversation exited", { convId: conv.info.convId, code, signal });
		conv.resolveExit();
		conv.removalTimer = setTimeout(() => {
			if (this.convs.get(conv.info.convId) === conv) this.convs.delete(conv.info.convId);
		}, this.retentionMs);
		conv.removalTimer.unref();
	}

	private forget(conv: Conversation): void {
		if (conv.removalTimer) clearTimeout(conv.removalTimer);
		if (this.convs.get(conv.info.convId) === conv) this.convs.delete(conv.info.convId);
	}

	/** SIGTERM now (pi kills the detached process groups of its bash tool), SIGKILL shortly after. */
	private killNow(conv: Conversation): void {
		conv.child.kill("SIGTERM");
		const kill = setTimeout(() => {
			if (!conv.exited) conv.child.kill("SIGKILL");
		}, this.forceKillGraceMs);
		kill.unref();
		conv.stopTimers.push(kill);
	}

	private async terminate(conv: Conversation, force: boolean): Promise<void> {
		if (conv.exited) return;
		if (force) {
			this.killNow(conv);
		} else if (conv.stopTimers.length === 0) {
			conv.child.stdin?.end();
			const term = setTimeout(() => conv.child.kill("SIGTERM"), this.stopGraceMs);
			const kill = setTimeout(() => conv.child.kill("SIGKILL"), this.stopGraceMs + this.killGraceMs);
			term.unref();
			kill.unref();
			conv.stopTimers.push(term, kill);
		}
		await conv.exitPromise;
	}

	private write(conv: Conversation, payload: unknown, activity: boolean): void {
		const stdin = conv.child.stdin;
		if (conv.exited || !stdin || stdin.destroyed || stdin.writableEnded) {
			throw new AgentError("CONV_EXITED", "会话进程已退出");
		}
		stdin.write(`${JSON.stringify(payload)}\n`);
		if (activity) conv.info.lastActivityAt = Date.now();
	}

	private rpc(conv: Conversation, command: RpcCommand, timeoutMs: number): Promise<RpcOutcome> {
		if (conv.exited) return Promise.reject(new AgentError("CONV_EXITED", "会话进程已退出"));
		const id = `pw-${++this.nextRpcId}`;
		return new Promise<RpcOutcome>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				conv.pending.delete(id);
				reject(new AgentError("TIMEOUT", `pi 命令 ${command.type} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
			}, timeoutMs);
			const slash = command.type === "prompt" && typeof command.message === "string" && command.message.startsWith("/");
			conv.pending.set(id, { command: command.type, slash, resolve: resolvePromise, reject, timer });
			try {
				this.write(conv, { ...command, id }, !QUERY_COMMANDS.has(command.type));
			} catch (err) {
				clearTimeout(timer);
				conv.pending.delete(id);
				reject(err as Error);
			}
		});
	}

	private onLine(conv: Conversation, line: string): void {
		if (conv.exited || !line.trim()) return;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			this.options.log.warn("unparseable pi output line", { convId: conv.info.convId, line: line.slice(0, 200) });
			return;
		}
		if (!isPlainObject(record) || typeof record.type !== "string") return;
		if (record.type === "response") {
			this.onResponse(conv, record as unknown as RpcResponse);
			return;
		}
		conv.info.lastActivityAt = Date.now();
		if (record.type === "extension_ui_request") {
			this.onUiRequest(conv, record as unknown as ExtensionUIRequest, line.length);
			return;
		}
		const event = record as unknown as ConvRecord;
		if (event.type === "agent_start") conv.runId++;
		this.emitRecord(conv, event, line.length);
		if (event.type === "session_info_changed") {
			conv.info.sessionName = event.name;
			this.emitInfo(conv);
		}
		if (event.type === "agent_settled") this.dropStaleDialogs(conv, (d) => d.runId === conv.runId);
		if (event.type === "agent_start" || event.type === "agent_settled") this.updateStatus(conv);
	}

	/**
	 * pi resolves a dialog silently (nothing on stdout) when its AbortSignal fires, e.g. when the
	 * user aborts the run while a confirm of a tool_call hook is shown. Such a dialog would stay
	 * pending forever (status waiting_ui, never idle-reaped). Once pi provably stopped waiting —
	 * the run that raised it settled, or the slash command that raised it was answered — dialogs
	 * without a timeout (timed ones are handled by their timer) are resolved.
	 */
	private dropStaleDialogs(conv: Conversation, stale: (dialog: DialogContext) => boolean): void {
		for (const request of [...conv.info.pendingUi]) {
			const dialog = conv.dialogs.get(request.id);
			if (dialog && !dialog.hasTimeout && stale(dialog)) this.resolveUi(conv, request.id);
		}
	}

	private onResponse(conv: Conversation, response: RpcResponse): void {
		const pending = typeof response.id === "string" ? conv.pending.get(response.id) : undefined;
		if (!pending) {
			if (!response.success) {
				this.options.log.warn("unmatched pi error response", { convId: conv.info.convId, command: response.command, error: response.error });
			}
			return;
		}
		conv.pending.delete(response.id as string);
		clearTimeout(pending.timer);
		pending.resolve({ response, seq: conv.info.lastSeq, tracker: conv.tracker });
		// pi answers a slash command after its handler returned: it no longer awaits dialogs it raised outside a run.
		if (pending.slash) this.dropStaleDialogs(conv, (d) => d.runId === null && d.slashRpcIds.has(response.id as string));
	}

	private onUiRequest(conv: Conversation, request: ExtensionUIRequest, size: number): void {
		if (EXTENSION_UI_DIALOG_METHODS.includes(request.method)) {
			if (!conv.info.pendingUi.some((r) => r.id === request.id)) conv.info.pendingUi.push(request);
			const timeout = (request as { timeout?: unknown }).timeout;
			const timed = typeof timeout === "number" && timeout > 0;
			conv.dialogs.set(request.id, {
				runId: conv.tracker.isRunning ? conv.runId : null,
				slashRpcIds: new Set([...conv.pending].filter(([, p]) => p.slash).map(([id]) => id)),
				hasTimeout: timed,
				...(timed ? { timeoutMs: timeout } : {}),
				requestedAt: Date.now(),
			});
			if (typeof timeout === "number" && timeout > 0) {
				const timer = setTimeout(() => {
					conv.uiTimers.delete(request.id);
					if (conv.info.pendingUi.some((r) => r.id === request.id)) this.resolveUi(conv, request.id);
				}, timeout + 1000);
				timer.unref();
				conv.uiTimers.set(request.id, timer);
			}
			this.emitRecord(conv, request, size);
			this.updateStatus(conv);
			return;
		}
		if (request.method === "setStatus") {
			if (request.statusKey === COMPANION_STATUS_KEY) {
				this.onCompanionResult(conv, request.statusText);
				return;
			}
			if (typeof request.statusText === "string") conv.info.statuses[request.statusKey] = request.statusText;
			else delete conv.info.statuses[request.statusKey];
		} else if (request.method === "setWidget") {
			if (Array.isArray(request.widgetLines)) {
				conv.info.widgets[request.widgetKey] = {
					lines: request.widgetLines,
					placement: request.widgetPlacement ?? "aboveEditor",
				};
			} else {
				delete conv.info.widgets[request.widgetKey];
			}
		}
		this.emitRecord(conv, request, size);
	}

	private onCompanionResult(conv: Conversation, text: string | undefined): void {
		if (typeof text !== "string" || !text) return;
		let result: { reqId?: unknown; ok?: unknown; error?: unknown; cancelled?: unknown };
		try {
			result = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof result?.reqId !== "string") return;
		const waiter = conv.companions.get(result.reqId);
		if (!waiter) return;
		conv.companions.delete(result.reqId);
		clearTimeout(waiter.timer);
		const out: ConvCompanionResult = { ok: result.ok === true };
		if (typeof result.error === "string") out.error = result.error;
		if (typeof result.cancelled === "boolean") out.cancelled = result.cancelled;
		waiter.resolve(out);
	}

	private resolveUi(conv: Conversation, id: string): void {
		conv.info.pendingUi = conv.info.pendingUi.filter((r) => r.id !== id);
		conv.dialogs.delete(id);
		const timer = conv.uiTimers.get(id);
		if (timer) {
			clearTimeout(timer);
			conv.uiTimers.delete(id);
		}
		this.emitRecord(conv, { type: "pi_web_ui_resolved", id });
		this.updateStatus(conv);
	}

	private onStderr(conv: Conversation, text: string): void {
		if (!text) return;
		conv.stderrTail = (conv.stderrTail + text).slice(-STDERR_TAIL_BYTES);
		conv.stderrPartial += text;
		let index = conv.stderrPartial.indexOf("\n");
		while (index >= 0) {
			const line = conv.stderrPartial.slice(0, index).replace(/\r$/, "");
			conv.stderrPartial = conv.stderrPartial.slice(index + 1);
			this.forwardStderrLine(conv, line);
			index = conv.stderrPartial.indexOf("\n");
		}
		if (conv.stderrPartial.length > STDERR_MAX_LINE) {
			this.forwardStderrLine(conv, conv.stderrPartial);
			conv.stderrPartial = "";
		}
	}

	private forwardStderrLine(conv: Conversation, line: string): void {
		if (!line.trim()) return;
		const now = Date.now();
		if (now - conv.stderrWindowStart >= 1000) {
			if (conv.stderrDropped > 0) {
				this.emitRecord(conv, { type: "pi_web_stderr", text: `[已省略 ${conv.stderrDropped} 行 stderr 输出]` });
				conv.stderrDropped = 0;
			}
			conv.stderrWindowStart = now;
			conv.stderrWindowCount = 0;
		}
		if (conv.stderrWindowCount >= STDERR_LINES_PER_SEC) {
			conv.stderrDropped++;
			return;
		}
		conv.stderrWindowCount++;
		this.emitRecord(conv, { type: "pi_web_stderr", text: line });
	}

	/** Assigns the next seq, stores the event for replay, updates the tracker and broadcasts it. */
	private emitRecord(conv: Conversation, record: ConvRecord | PiWebEvent, size = 128): void {
		const seq = ++conv.info.lastSeq;
		const event: ConvEvent = { convId: conv.info.convId, seq, ts: Date.now(), record };
		conv.ring.push(event, size);
		conv.tracker = compactTracker(applyConvRecord(conv.tracker, record, seq, event.ts));
		this.options.emit("conv.event", event);
	}

	private emitInfo(conv: Conversation): void {
		this.options.emit("conv.info", copyInfo(conv.info));
	}

	private computeStatus(conv: Conversation): ConvStatus {
		if (conv.exited) return "exited";
		if (!conv.started) return "starting";
		if (conv.info.pendingUi.length > 0) return "waiting_ui";
		if (conv.tracker.isRunning) return "running";
		return "idle";
	}

	/** Recomputes the status; on change emits pi_web_status and conv.info and returns true. */
	private updateStatus(conv: Conversation): boolean {
		const next = this.computeStatus(conv);
		if (next === conv.info.status) return false;
		conv.info.status = next;
		this.emitRecord(conv, { type: "pi_web_status", status: next });
		this.emitInfo(conv);
		return true;
	}

	private applyState(conv: Conversation, state: RpcSessionState | undefined): void {
		if (!state) return;
		const previous = conv.info.sessionFile;
		conv.info.sessionFile = state.sessionFile ? resolve(state.sessionFile) : undefined;
		conv.info.sessionId = state.sessionId;
		conv.info.sessionName = state.sessionName;
		if (previous !== conv.info.sessionFile) {
			if (previous && this.sessionIndex.get(previous) === conv.info.convId) this.sessionIndex.delete(previous);
		}
		if (conv.info.sessionFile && !conv.exited) this.sessionIndex.set(conv.info.sessionFile, conv.info.convId);
	}

	private unindex(conv: Conversation): void {
		for (const [file, convId] of this.sessionIndex) {
			if (convId === conv.info.convId) this.sessionIndex.delete(file);
		}
	}

	/** Re-reads get_state after the session file may have changed and tells every viewer to resync. */
	private async refreshSession(conv: Conversation): Promise<void> {
		const outcome = await this.rpc(conv, { type: "get_state" }, DEFAULT_TIMEOUT_MS);
		if (!outcome.response.success) return;
		this.applyState(conv, outcome.response.data as RpcSessionState);
		this.emitRecord(conv, {
			type: "pi_web_session_changed",
			sessionFile: conv.info.sessionFile,
			sessionId: conv.info.sessionId,
			sessionName: conv.info.sessionName,
		});
		this.emitInfo(conv);
	}
}
