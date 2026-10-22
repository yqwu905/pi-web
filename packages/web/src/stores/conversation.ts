/**
 * Per-conversation state for the chat view.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────┐
 * │ const conv = useConversation({ workspaceId, sessionId });                             │
 * │                                                                                      │
 * │ Params                                                                               │
 * │   workspaceId   route :workspaceId                                                    │
 * │   sessionId?    route :sessionId (session uuid); omit for a brand-new conversation    │
 * │   convId?       force a specific live conversation id (rarely needed)                 │
 * │                                                                                      │
 * │ Modes (conv.mode)                                                                    │
 * │   "new"       no session yet; state is empty. First send → conv.prompt(...) starts   │
 * │               a pi process (POST /workspaces/:wsId/conversations) and sends it.      │
 * │   "readonly"  a session file without a live process: GET /sessions/read rendered via │
 * │               entriesToMessages (conv.readOnlyFile has entries/leafId for trees).    │
 * │               conv.prompt / conv.ensureLive lazily open it with { sessionFile }.     │
 * │   "live"      a pi process exists: snapshot (GET /conversations/:id/snapshot) +     │
 * │               conv:<id> events applied with applyConvRecord (only seq > snapshot).   │
 * │               Gaps are filled with /replay; needsResync or a WS reconnect refetches  │
 * │               the snapshot. Stats refresh automatically after each agent_settled.    │
 * │                                                                                      │
 * │ Data                                                                                 │
 * │   state: ConversationState (messages, streaming, tools, queue, ui, isRunning, …)     │
 * │   loading, error, isLive (live and not exited), convId, serverId, workspace,         │
 * │   session (SessionSummary | undefined), sessionFile, sessionId (live sessionId wins), │
 * │   rpcState (get_state result), stats (get_session_stats), configStale, info          │
 * │                                                                                      │
 * │ Actions (stable identities, always act on the latest conversation)                   │
 * │   start(opts?)        open/resume the process → ConversationView                     │
 * │   ensureLive(opts?)   start if needed → convId                                       │
 * │   prompt(text, { images, streamingBehavior }) ensureLive + RPC prompt                │
 * │   rpc(command, timeoutMs?)  raw RPC → RpcResponse (does not throw on success:false)  │
 * │   call(command)       typed RPC → RpcResponseData[type]; throws Error(response.error)│
 * │   uiResponse(resp)    answer an extension dialog (removed optimistically)           │
 * │   dismissNotification(id), resync(), refreshState(), refreshStats(), stop(force?)    │
 * │                                                                                      │
 * │ After new_session / fork / clone / switch_session the snapshot is refetched; watch   │
 * │ conv.sessionId and navigate to paths.chat(workspaceId, conv.sessionId) when it moves.│
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 */
import {
	type ConvEvent,
	type ConversationState,
	type ConversationView,
	type ConvInfo,
	type ExtensionUIResponse,
	type ImageContent,
	type OpenConversationRequest,
	type RpcCommand,
	type RpcResponse,
	type RpcResponseData,
	type RpcSessionState,
	type SessionFileResponse,
	type SessionStats,
	type SessionSummary,
	type SyncTopicEvent,
	type WorkspaceView,
	createConversationState,
	dismissNotification as dismissNotificationReducer,
	resolveUiRequest,
} from "@pi-web/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	ApiError,
	conversationRpc,
	conversationUiResponse,
	errorMessage,
	getConversationSnapshot,
	openConversation,
	readSession,
	replayConversation,
	stopConversation,
} from "../api/client";
import { useWorkspace, useWorkspaceSessions } from "../api/hooks";
import { queryClient, queryKeys } from "../api/queryClient";
import { wsClient } from "../api/ws";
import { applyEvents, classifyEvent, containsSettled, stateFromSessionFile, stateFromSnapshot } from "../lib/conversation-sync";
import { findSessionById, liveConversationForSession } from "../lib/sessions";
import { useConvsStore } from "./convs";

// ---------------------------------------------------------------------------
// Live conversation registry (module level, shared by every component)
// ---------------------------------------------------------------------------

export interface LiveConversationView {
	phase: "loading" | "ready" | "error";
	error: string | null;
	state: ConversationState;
	serverId: string | null;
	workspaceId: string | null;
	info: ConvInfo | null;
	rpcState: RpcSessionState | null;
	stats: SessionStats | null;
	configStale: boolean;
	/** True while a snapshot refetch is in flight after the initial load. */
	resyncing: boolean;
}

const DISPOSE_DELAY_MS = 30_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/** Failures that go away by themselves: server/agent offline (409/503), gateway errors, network. */
function isTransientError(error: unknown): boolean {
	if (error instanceof ApiError) return error.status === 409 || error.status === 502 || error.status === 503 || error.status === 504;
	return error instanceof TypeError;
}
const WORKSPACE_REFRESH_DELAY_MS = 300;

const workspaceRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A tool finished (or the agent settled): it may have changed files, so the workspace's file
 * browser and git views (and the Git tab's change count) refetch. Debounced per workspace.
 */
export function scheduleWorkspaceRefresh(workspaceId: string, delayMs = WORKSPACE_REFRESH_DELAY_MS): void {
	if (workspaceRefreshTimers.has(workspaceId)) return;
	workspaceRefreshTimers.set(
		workspaceId,
		setTimeout(() => {
			workspaceRefreshTimers.delete(workspaceId);
			void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceGit(workspaceId) });
			void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFs(workspaceId) });
		}, delayMs),
	);
}

/** Records after which the workspace's files may differ. */
function changesFiles(type: string): boolean {
	return type === "tool_execution_end" || type === "agent_settled";
}
const STATS_DEBOUNCE_MS = 400;
const RESYNC_DEBOUNCE_MS = 200;

const EMPTY_STATE = createConversationState();

class LiveConversation {
	private view: LiveConversationView = {
		phase: "loading",
		error: null,
		state: EMPTY_STATE,
		serverId: null,
		workspaceId: null,
		info: null,
		rpcState: null,
		stats: null,
		configStale: false,
		resyncing: false,
	};
	private readonly listeners = new Set<() => void>();
	private refs = 0;
	private active = false;
	/** Events received while a snapshot/replay is in flight; null when applying directly. */
	private buffer: ConvEvent[] | null = null;
	private loadToken = 0;
	private offTopic: (() => void) | null = null;
	private offOpen: (() => void) | null = null;
	private offSync: (() => void) | null = null;
	/** Servers whose config changed while a snapshot was in flight (it may predate the change). */
	private readonly configUpdatedDuringLoad = new Set<string>();
	private disposeTimer: ReturnType<typeof setTimeout> | null = null;
	private statsTimer: ReturnType<typeof setTimeout> | null = null;
	private resyncTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly convId: string,
		private readonly onDispose: (convId: string) => void,
	) {}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly getView = (): LiveConversationView => this.view;

	/** Keeps the conversation subscribed; call the returned function to release. */
	retain(): () => void {
		this.refs++;
		if (this.disposeTimer) {
			clearTimeout(this.disposeTimer);
			this.disposeTimer = null;
		}
		if (!this.active) this.activate();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.refs--;
			if (this.refs <= 0 && !this.disposeTimer) {
				this.disposeTimer = setTimeout(() => this.dispose(), DISPOSE_DELAY_MS);
			}
		};
	}

	update(patch: Partial<LiveConversationView>): void {
		this.view = { ...this.view, ...patch };
		for (const l of [...this.listeners]) l();
	}

	/** Local-only state change (optimistic UI). */
	mutateState(fn: (state: ConversationState) => ConversationState): void {
		const next = fn(this.view.state);
		if (next !== this.view.state) this.update({ state: next });
	}

	/** Refetches the snapshot; events arriving meanwhile are buffered and applied afterwards. */
	async resync(): Promise<void> {
		if (this.resyncTimer) {
			clearTimeout(this.resyncTimer);
			this.resyncTimer = null;
		}
		const token = ++this.loadToken;
		if (!this.buffer) this.buffer = [];
		this.configUpdatedDuringLoad.clear();
		if (this.view.phase === "ready") this.update({ resyncing: true });
		try {
			const snap = await getConversationSnapshot(this.convId);
			if (token !== this.loadToken || !this.active) return;
			const buffered = this.buffer ?? [];
			this.buffer = null;
			const configStale = snap.configStale || this.configUpdatedDuringLoad.has(snap.serverId);
			this.configUpdatedDuringLoad.clear();
			const state = applyEvents(stateFromSnapshot(snap.snapshot), buffered);
			this.update({
				phase: "ready",
				error: null,
				state,
				serverId: snap.serverId,
				workspaceId: snap.workspaceId,
				info: snap.snapshot.info,
				rpcState: snap.snapshot.state,
				stats: snap.snapshot.stats ?? this.view.stats,
				configStale,
				resyncing: false,
			});
			this.retryDelayMs = RETRY_MIN_MS;
			if (state.needsResync) this.scheduleResync();
			if (containsSettled(buffered)) this.scheduleStats();
			if (snap.workspaceId && buffered.some((e) => changesFiles(e.record.type))) scheduleWorkspaceRefresh(snap.workspaceId);
		} catch (error) {
			if (token !== this.loadToken) return;
			// Keep applying live events on top of whatever state we had.
			const buffered = this.buffer ?? [];
			this.buffer = null;
			this.update({
				phase: this.view.phase === "ready" ? "ready" : "error",
				error: errorMessage(error),
				state: applyEvents(this.view.state, buffered),
				resyncing: false,
			});
			// The server or its agent is away (503/409/network): retry with backoff while someone
			// watches, so the view recovers by itself once the server is back.
			if (this.active && isTransientError(error)) this.scheduleRetry();
		}
	}

	private retryDelayMs = RETRY_MIN_MS;

	private scheduleRetry(): void {
		if (this.resyncTimer) return;
		const delay = this.retryDelayMs;
		this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
		this.resyncTimer = setTimeout(() => {
			this.resyncTimer = null;
			if (this.active) void this.resync();
		}, delay);
	}

	async refreshState(): Promise<RpcSessionState | null> {
		const res = await conversationRpc(this.convId, { command: { type: "get_state" } });
		if (!res.success || !res.data) return this.view.rpcState;
		const rpcState = res.data as RpcSessionState;
		this.update({ rpcState });
		return rpcState;
	}

	async refreshStats(): Promise<SessionStats | null> {
		const res = await conversationRpc(this.convId, { command: { type: "get_session_stats" } });
		if (!res.success || !res.data) return this.view.stats;
		const stats = res.data as SessionStats;
		this.update({ stats });
		return stats;
	}

	private activate(): void {
		this.active = true;
		this.offTopic = wsClient.subscribe<ConvEvent>(`conv:${this.convId}`, (ev) => this.onEvent(ev));
		this.offSync = wsClient.subscribe<SyncTopicEvent>("sync", (ev) => this.onSyncEvent(ev));
		// Events published before the subscription reaches the server are lost. While the socket is
		// still connecting, the first snapshot can predate the subscription, so resync on that open too.
		let resyncOnOpen = wsClient.getStatus().state !== "open";
		this.offOpen = wsClient.onOpen(({ reconnect }) => {
			if (!reconnect && !resyncOnOpen) return;
			resyncOnOpen = false;
			void this.resync();
		});
		void this.resync();
	}

	private dispose(): void {
		this.active = false;
		this.offTopic?.();
		this.offOpen?.();
		this.offSync?.();
		this.offTopic = null;
		this.offOpen = null;
		this.offSync = null;
		this.configUpdatedDuringLoad.clear();
		for (const t of [this.disposeTimer, this.statsTimer, this.resyncTimer]) if (t) clearTimeout(t);
		this.disposeTimer = this.statsTimer = this.resyncTimer = null;
		this.loadToken++;
		this.buffer = null;
		this.onDispose(this.convId);
	}

	private onEvent(ev: ConvEvent): void {
		if (!ev || typeof ev !== "object" || typeof ev.seq !== "number" || !ev.record) return;
		if (ev.convId && ev.convId !== this.convId) return;
		if (this.buffer) {
			this.buffer.push(ev);
			return;
		}
		const current = this.view.state;
		switch (classifyEvent(current.seq, ev.seq)) {
			case "stale":
				return;
			case "gap":
				this.buffer = [ev];
				void this.fillGap(current.seq);
				return;
			default: {
				const state = applyEvents(current, [ev]);
				this.update({ state, info: this.patchInfo(ev) });
				if (state.needsResync && !current.needsResync) this.scheduleResync();
				if (ev.record.type === "agent_settled") this.scheduleStats();
				if (changesFiles(ev.record.type) && this.view.workspaceId) scheduleWorkspaceRefresh(this.view.workspaceId);
			}
		}
	}

	/** The Host just synced new config to a server: its running conversations need a reload. */
	private onSyncEvent(ev: SyncTopicEvent): void {
		if (!ev || ev.kind !== "configUpdated" || typeof ev.serverId !== "string") return;
		if (this.buffer) this.configUpdatedDuringLoad.add(ev.serverId);
		if (ev.serverId === this.view.serverId && !this.view.configStale) this.update({ configStale: true });
	}

	/** Keeps info.status in step with pi_web_status records between snapshots. */
	private patchInfo(ev: ConvEvent): ConvInfo | null {
		const info = this.view.info;
		if (!info) return info;
		if (ev.record.type === "pi_web_status") return { ...info, status: ev.record.status, lastSeq: ev.seq };
		if (ev.record.type === "pi_web_exit") return { ...info, status: "exited", exitCode: ev.record.code, exitSignal: ev.record.signal };
		return info;
	}

	private async fillGap(afterSeq: number): Promise<void> {
		const token = this.loadToken;
		try {
			const replay = await replayConversation(this.convId, afterSeq);
			if (token !== this.loadToken || !this.active) return;
			if (!replay.complete) {
				void this.resync();
				return;
			}
			const buffered = this.buffer ?? [];
			this.buffer = null;
			const events = [...replay.events, ...buffered];
			const state = applyEvents(this.view.state, events);
			this.update({ state });
			if (state.needsResync) this.scheduleResync();
			if (containsSettled(events)) this.scheduleStats();
		} catch {
			if (token === this.loadToken && this.active) void this.resync();
		}
	}

	private scheduleResync(): void {
		if (this.resyncTimer) return;
		this.resyncTimer = setTimeout(() => {
			this.resyncTimer = null;
			void this.resync();
		}, RESYNC_DEBOUNCE_MS);
	}

	private scheduleStats(): void {
		if (this.statsTimer) clearTimeout(this.statsTimer);
		this.statsTimer = setTimeout(() => {
			this.statsTimer = null;
			if (this.active) this.refreshStats().catch(() => undefined);
		}, STATS_DEBOUNCE_MS);
	}
}

const registry = new Map<string, LiveConversation>();

/** Registry entry for a live conversation (created on demand, disposed 30s after last release). */
export function getLiveConversation(convId: string): LiveConversation {
	let entry = registry.get(convId);
	if (!entry) {
		entry = new LiveConversation(convId, (id) => registry.delete(id));
		registry.set(convId, entry);
	}
	return entry;
}

const noopSubscribe = () => () => {};
const getNull = () => null;

/** Low-level hook: subscribe to a live conversation by convId (null → no subscription). */
export function useLiveConversation(convId: string | null | undefined): LiveConversationView | null {
	const entry = convId ? getLiveConversation(convId) : null;
	useEffect(() => {
		if (!convId) return;
		return getLiveConversation(convId).retain();
	}, [convId]);
	return useSyncExternalStore(entry ? entry.subscribe : noopSubscribe, entry ? entry.getView : getNull, entry ? entry.getView : getNull);
}

// ---------------------------------------------------------------------------
// useConversation
// ---------------------------------------------------------------------------

export interface UseConversationParams {
	workspaceId: string;
	/** Session uuid from the route; omit for a new conversation. */
	sessionId?: string;
	/** Explicit live conversation id (overrides session-based resolution). */
	convId?: string | null;
}

export type ConversationMode = "new" | "readonly" | "live";

export type StartOptions = Omit<OpenConversationRequest, "sessionFile">;

export interface PromptOptions {
	images?: ImageContent[];
	/** Required by pi while the agent is streaming: "steer" (Enter) or "followUp" (Alt+Enter). */
	streamingBehavior?: "steer" | "followUp";
	/** Used when the prompt has to start the process. */
	start?: StartOptions;
}

/** Typed `data` of a successful response to command C. */
export type CommandData<C extends RpcCommand> = RpcResponseData[C["type"] & keyof RpcResponseData];

export interface ConversationHandle {
	mode: ConversationMode;
	loading: boolean;
	error: string | null;
	state: ConversationState;
	/** Live and not exited. */
	isLive: boolean;
	convId: string | null;
	serverId: string | null;
	workspace: WorkspaceView | undefined;
	session: SessionSummary | undefined;
	sessionFile: string | undefined;
	sessionId: string | undefined;
	info: ConvInfo | null;
	rpcState: RpcSessionState | null;
	stats: SessionStats | null;
	configStale: boolean;
	/** Raw session file (read-only mode only). */
	readOnlyFile: SessionFileResponse | undefined;
	start(options?: StartOptions): Promise<ConversationView>;
	ensureLive(options?: StartOptions): Promise<string>;
	prompt(message: string, options?: PromptOptions): Promise<RpcResponse>;
	rpc(command: RpcCommand, timeoutMs?: number): Promise<RpcResponse & { seq?: number }>;
	call<C extends RpcCommand>(command: C, timeoutMs?: number): Promise<CommandData<C>>;
	uiResponse(response: ExtensionUIResponse): Promise<void>;
	dismissNotification(id: string): void;
	resync(): Promise<void>;
	refreshState(): Promise<RpcSessionState | null>;
	refreshStats(): Promise<SessionStats | null>;
	stop(force?: boolean): Promise<void>;
}

/** Commands after which get_state is refetched so rpcState (model, thinking, flags) stays current. */
const STATE_CHANGING: ReadonlySet<string> = new Set([
	"set_model",
	"cycle_model",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_auto_compaction",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_session_name",
]);

export function useConversation(params: UseConversationParams): ConversationHandle {
	const { workspaceId, sessionId } = params;
	const { workspace } = useWorkspace(workspaceId);
	const serverId = workspace?.config.serverId ?? null;
	const sessionsQuery = useWorkspaceSessions(workspaceId);
	const session = useMemo(() => findSessionById(sessionsQuery.data, sessionId), [sessionsQuery.data, sessionId]);
	const convsById = useConvsStore((s) => s.byId);
	const convsLoaded = useConvsStore((s) => s.loaded);

	// Conversation started from this hook (new conversation, or a resumed read-only session).
	const [started, setStarted] = useState<{ convId: string; sessionId?: string } | null>(null);
	const [prevSessionId, setPrevSessionId] = useState(sessionId);
	if (prevSessionId !== sessionId) {
		setPrevSessionId(sessionId);
		const startedSession = started ? (convsById[started.convId]?.info.sessionId ?? started.sessionId) : undefined;
		if (started && startedSession !== sessionId) setStarted(null);
	}

	const resolvedConvId = useMemo(() => {
		if (params.convId) return params.convId;
		if (started && convsById[started.convId]?.info.status !== "exited") return started.convId;
		if (session) {
			const live = liveConversationForSession(session, Object.values(convsById));
			if (live) return live.convId;
			if (!convsLoaded && session.runningConvId) return session.runningConvId;
		} else if (sessionId) {
			// A live session whose file is not listed yet (e.g. just created in another tab).
			const live = Object.values(convsById).find(
				(c) => c.info.status !== "exited" && c.info.sessionId === sessionId && (c.workspaceId === workspaceId || c.workspaceId === null),
			);
			if (live) return live.convId;
		}
		return null;
	}, [params.convId, started, session, sessionId, workspaceId, convsById, convsLoaded]);

	const live = useLiveConversation(resolvedConvId);

	const readOnlyQuery = useQuery({
		queryKey: [...queryKeys.sessionFile(serverId ?? "", session?.file ?? ""), session?.modifiedMs ?? 0],
		queryFn: ({ signal }) => readSession(serverId as string, (session as SessionSummary).file, signal),
		enabled: !resolvedConvId && Boolean(serverId && session),
		staleTime: 5_000,
	});
	const readOnlyState = useMemo(
		() => (readOnlyQuery.data ? stateFromSessionFile(readOnlyQuery.data, session?.name) : null),
		[readOnlyQuery.data, session?.name],
	);

	const mode: ConversationMode = resolvedConvId ? "live" : session ? "readonly" : "new";
	const state = mode === "live" ? (live?.state ?? EMPTY_STATE) : mode === "readonly" ? (readOnlyState ?? EMPTY_STATE) : EMPTY_STATE;
	const loading =
		mode === "live"
			? !live || live.phase === "loading"
			: mode === "readonly"
				? readOnlyQuery.isLoading || !serverId
				: Boolean(sessionId) && (sessionsQuery.isLoading || !workspace);
	const error =
		mode === "live"
			? (live?.error ?? null)
			: mode === "readonly"
				? readOnlyQuery.error
					? errorMessage(readOnlyQuery.error)
					: null
				: sessionsQuery.error
					? errorMessage(sessionsQuery.error)
					: sessionId && sessionsQuery.isSuccess && !session
						? "找不到该会话"
						: null;
	const isLive = mode === "live" && state.status !== "exited" && live?.info?.status !== "exited";
	const liveSessionId = live?.rpcState?.sessionId ?? live?.info?.sessionId;
	const sessionFile = (mode === "live" ? (live?.rpcState?.sessionFile ?? live?.info?.sessionFile) : undefined) ?? session?.file;

	// Latest values for stable action callbacks.
	const latest = useRef({ workspaceId, session, convId: resolvedConvId, isLive, sessionFile });
	useLayoutEffect(() => {
		latest.current = { workspaceId, session, convId: resolvedConvId, isLive, sessionFile };
	});

	const starting = useRef<Promise<ConversationView> | null>(null);
	const start = useCallback((options: StartOptions = {}): Promise<ConversationView> => {
		const cur = latest.current;
		if (cur.convId && cur.isLive) {
			const existing = useConvsStore.getState().byId[cur.convId];
			if (existing) return Promise.resolve(existing);
		}
		// Concurrent callers (e.g. two quick sends) share one start request.
		if (starting.current) return starting.current;
		const promise = (async () => {
			const view = await openConversation(cur.workspaceId, { ...options, sessionFile: cur.sessionFile });
			useConvsStore.getState().upsert(view);
			// Subscribe right away so no early event is missed; the hook's own retain takes over.
			const release = getLiveConversation(view.convId).retain();
			setTimeout(release, 5_000);
			latest.current = { ...latest.current, convId: view.convId, isLive: true };
			setStarted({ convId: view.convId, sessionId: view.info.sessionId });
			return view;
		})().finally(() => {
			starting.current = null;
		});
		starting.current = promise;
		return promise;
	}, []);

	const ensureLive = useCallback(
		async (options?: StartOptions): Promise<string> => {
			const cur = latest.current;
			if (cur.convId && cur.isLive) return cur.convId;
			return (await start(options)).convId;
		},
		[start],
	);

	const rpc = useCallback(async (command: RpcCommand, timeoutMs?: number) => {
		const convId = latest.current.convId;
		if (!convId) throw new Error("对话尚未启动");
		const res = await conversationRpc(convId, { command, timeoutMs });
		if (res.success && STATE_CHANGING.has(command.type)) getLiveConversation(convId).refreshState().catch(() => undefined);
		return res;
	}, []);

	const call = useCallback(
		async <C extends RpcCommand>(command: C, timeoutMs?: number): Promise<CommandData<C>> => {
			const res = await rpc(command, timeoutMs);
			if (!res.success) throw new Error(res.error || `命令 ${command.type} 执行失败`);
			return res.data as CommandData<C>;
		},
		[rpc],
	);

	const prompt = useCallback(
		async (message: string, options: PromptOptions = {}): Promise<RpcResponse> => {
			await ensureLive(options.start);
			const command: Extract<RpcCommand, { type: "prompt" }> = { type: "prompt", message };
			if (options.images?.length) command.images = options.images;
			if (options.streamingBehavior) command.streamingBehavior = options.streamingBehavior;
			return rpc(command);
		},
		[ensureLive, rpc],
	);

	const uiResponse = useCallback(async (response: ExtensionUIResponse) => {
		const convId = latest.current.convId;
		if (!convId) throw new Error("对话尚未启动");
		getLiveConversation(convId).mutateState((s) => resolveUiRequest(s, response.id));
		await conversationUiResponse(convId, { response });
	}, []);

	const dismissNotification = useCallback((id: string) => {
		const convId = latest.current.convId;
		if (convId) getLiveConversation(convId).mutateState((s) => dismissNotificationReducer(s, id));
	}, []);

	const resync = useCallback(async () => {
		const convId = latest.current.convId;
		if (convId) await getLiveConversation(convId).resync();
	}, []);

	const refreshState = useCallback(async () => {
		const convId = latest.current.convId;
		return convId ? getLiveConversation(convId).refreshState() : null;
	}, []);

	const refreshStats = useCallback(async () => {
		const convId = latest.current.convId;
		return convId ? getLiveConversation(convId).refreshStats() : null;
	}, []);

	const stop = useCallback(async (force?: boolean) => {
		const convId = latest.current.convId;
		if (convId) await stopConversation(convId, force);
	}, []);

	return {
		mode,
		loading,
		error,
		state,
		isLive,
		convId: resolvedConvId,
		serverId: live?.serverId ?? serverId,
		workspace,
		session,
		sessionFile,
		sessionId: (mode === "live" ? liveSessionId : undefined) ?? session?.id ?? sessionId,
		info: live?.info ?? null,
		rpcState: live?.rpcState ?? null,
		stats: live?.stats ?? null,
		configStale: live?.configStale ?? false,
		readOnlyFile: mode === "readonly" ? readOnlyQuery.data : undefined,
		start,
		ensureLive,
		prompt,
		rpc,
		call,
		uiResponse,
		dismissNotification,
		resync,
		refreshState,
		refreshStats,
		stop,
	};
}
