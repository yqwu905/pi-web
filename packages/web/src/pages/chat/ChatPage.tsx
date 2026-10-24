import type { BashResult } from "@pi-web/shared";
import { CircleAlert, CloudOff, MessageSquarePlus, PanelRightOpen } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { setSessionArchived } from "../../api/archive";
import { errorMessage } from "../../api/client";
import { invalidateSessions } from "../../api/hooks";
import { ButtonLink, Callout, EmptyState, IconButton, LoadingBlock, toast } from "../../components/ui";
import { paths } from "../../lib/routes";
import { sessionTitle } from "../../lib/sessions";
import { useConversation } from "../../stores/conversation";
import { setViewing } from "../../stores/attention";
import { useConversationView } from "../../stores/convs";
import { useServer } from "../../stores/servers";
import { ConnectButton } from "../workspace/WorkspaceGate";
import { Composer, type ComposerHandle } from "./components/Composer";
import { CompactDialog, DeleteSessionDialog, ExtensionUiDialogs, ForkDialog, RenameDialog } from "./components/Dialogs";
import { InfoPanel } from "./components/InfoPanel";
import { MessageList } from "./components/MessageList";
import type { BashRunView } from "./components/MessageViews";
import { SessionTreeModal } from "./components/SessionTreeModal";
import { ArchivedBanner, CompactingBanner, ErrorBanner, ExitedBanner, ExtensionStatuses, ExtensionWidgets, RetryBanner } from "./components/StatusArea";
import { TodoPanel } from "./components/TodoPanel";
import { useMediaMinWidth, useStoredState } from "./hooks";
import { buildDisplayItems, hasRunningTool } from "./logic/messages";
import { selectTodoSnapshot } from "./logic/todos";

/**
 * Session ids that the chat view itself moved to (new session got its id, fork, clone):
 * they keep the current view (same React key) instead of remounting it.
 */
const sessionAliases = new Map<string, string>();
/** Last set_editor_text nonce handled per conversation. */
const editorNonces = new Map<string, string>();
/** Extension notifications already shown as toasts, per conversation. */
const shownNotifications = new Map<string, Set<string>>();

/** Route: /w/:workspaceId/chat/:sessionId? */
export default function ChatPage() {
	const { workspaceId = "", sessionId } = useParams();
	const [newCount, setNewCount] = useState(0);
	/** Bumped when the user navigates a view away from the session it follows: forces a fresh view. */
	const [epoch, setEpoch] = useState(0);
	const [prevSessionId, setPrevSessionId] = useState(sessionId);
	if (prevSessionId !== sessionId) {
		setPrevSessionId(sessionId);
		if (sessionId === undefined) setNewCount((n) => n + 1);
	}
	const viewKey = sessionId === undefined ? `new-${newCount}` : (sessionAliases.get(sessionId) ?? sessionId);
	const detach = useCallback(() => setEpoch((n) => n + 1), []);
	return (
		<ChatView
			key={`${workspaceId}:${viewKey}:${epoch}`}
			workspaceId={workspaceId}
			routeSessionId={sessionId}
			viewKey={viewKey}
			onDetach={detach}
		/>
	);
}

interface LocalBashRun {
	id: string;
	command: string;
	excludeFromContext: boolean;
	startedAt: number;
	/** bashOutput keys that existed before this run (its stream is the first new key). */
	baseKeys: Set<string>;
	key?: string;
	result?: BashResult;
	error?: string;
	done: boolean;
	syncing?: boolean;
}

function ChatView({
	workspaceId,
	routeSessionId,
	viewKey,
	onDetach,
}: {
	workspaceId: string;
	routeSessionId?: string;
	viewKey: string;
	/** The route moved to a session this view did not follow to (sidebar link, browser Back). */
	onDetach: () => void;
}) {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const [pin, setPin] = useState<string | null>(null);
	// The session id this view itself navigated to (a new conversation got its id, fork, clone).
	const followed = useRef(routeSessionId);
	useEffect(() => {
		// Any other route change (e.g. Back to the session that was forked) must not reuse this
		// view: it is pinned to the conversation that now serves the other session and would
		// bounce straight back to it.
		if (routeSessionId !== followed.current) onDetach();
	}, [routeSessionId, onDetach]);
	const pinView = useConversationView(pin);
	const pinnedConvId = pin && pinView && pinView.info.status !== "exited" ? pin : null;
	const conv = useConversation({ workspaceId, sessionId: routeSessionId, convId: pinnedConvId });
	const { state } = conv;

	// The conversation lives on the workspace's server: offline means no history and no sending.
	const server = useServer(conv.workspace?.config.serverId);
	const connection = server?.status.connection;
	const offline = Boolean(server) && connection !== "connected" && connection !== "connecting";
	const prevConnection = useRef(connection);
	useEffect(() => {
		const before = prevConnection.current;
		prevConnection.current = connection;
		if (before === undefined || before === connection || connection !== "connected") return;
		// Back online: reload what failed while the server was away.
		void invalidateSessions(workspaceId);
		if (conv.error && conv.convId) void conv.resync();
	}, [connection, workspaceId, conv]);

	const composerRef = useRef<ComposerHandle>(null);
	const pendingText = useRef<string | null>(null);
	const pendingInsert = useRef<string | null>(null);
	const fillComposer = useCallback((text: string) => {
		if (composerRef.current) composerRef.current.setText(text);
		else pendingText.current = text;
	}, []);
	const insertIntoComposer = useCallback((text: string) => {
		if (composerRef.current) composerRef.current.insert(text);
		else pendingInsert.current = text;
	}, []);
	useEffect(() => {
		if (pendingText.current !== null && composerRef.current) {
			composerRef.current.setText(pendingText.current);
			pendingText.current = null;
		}
		if (pendingInsert.current !== null && composerRef.current) {
			composerRef.current.insert(pendingInsert.current);
			pendingInsert.current = null;
		}
	});

	// ?prefill= (Files "在对话中引用", Git "发给 pi 审阅") adds to the composer's draft once.
	const prefill = searchParams.get("prefill");
	useEffect(() => {
		if (prefill === null) return;
		insertIntoComposer(prefill);
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("prefill");
				return next;
			},
			{ replace: true },
		);
	}, [prefill, insertIntoComposer, setSearchParams]);

	// Follow the live session: a new conversation gets its id, fork/clone switch the session.
	useEffect(() => {
		if (conv.mode !== "live" || !conv.sessionId || conv.sessionId === routeSessionId) return;
		if (!conv.rpcState?.sessionId && !conv.info?.sessionId) return;
		sessionAliases.set(conv.sessionId, viewKey);
		if (conv.convId) setPin(conv.convId);
		followed.current = conv.sessionId;
		navigate(paths.chat(workspaceId, conv.sessionId), { replace: routeSessionId === undefined });
	}, [conv.mode, conv.sessionId, conv.convId, conv.rpcState?.sessionId, conv.info?.sessionId, routeSessionId, viewKey, workspaceId, navigate]);

	const ready = conv.mode === "live" && !conv.loading && conv.convId !== null;

	// The open conversation is "read": no unread marker or notification for it.
	const viewedKey = conv.sessionId ?? conv.convId;
	useEffect(() => {
		if (!conv.convId || !viewedKey) return;
		return setViewing(conv.convId, viewedKey);
	}, [conv.convId, viewedKey]);

	// set_editor_text from extensions (ignore the value already present when the view loads).
	const editorText = state.ui.editorText;
	useEffect(() => {
		if (!ready || !conv.convId) return;
		const nonce = editorText?.nonce ?? "";
		const seen = editorNonces.get(conv.convId);
		editorNonces.set(conv.convId, nonce);
		if (seen !== undefined && seen !== nonce && editorText) fillComposer(editorText.text);
	}, [ready, conv.convId, editorText, fillComposer]);

	// notify / extension_error → toasts (only ones that arrive while the view is open).
	const notifications = state.ui.notifications;
	const { dismissNotification } = conv;
	useEffect(() => {
		if (!ready || !conv.convId) return;
		let seen = shownNotifications.get(conv.convId);
		if (!seen) {
			shownNotifications.set(conv.convId, new Set(notifications.map((n) => n.id)));
			return;
		}
		for (const n of notifications) {
			if (seen.has(n.id)) continue;
			seen.add(n.id);
			const isExtError = n.id.startsWith("ext-error-");
			const tone = n.notifyType === "error" ? "error" : n.notifyType === "warning" ? "warning" : "info";
			toast[tone](n.message, isExtError ? { title: "扩展错误" } : {});
			dismissNotification(n.id);
		}
		if (seen.size > 500) seen = new Set([...seen].slice(-200));
		shownNotifications.set(conv.convId, seen);
	}, [ready, conv.convId, notifications, dismissNotification]);

	// ---------- "!cmd" bash runs ----------

	const [bashRuns, setBashRuns] = useState<LocalBashRun[]>([]);
	const latestState = useRef(state);
	useLayoutEffect(() => {
		latestState.current = state;
	});

	const runBash = useCallback(
		async (command: string, excludeFromContext: boolean) => {
			const id = `bash-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			const update = (patch: Partial<LocalBashRun>) => setBashRuns((runs) => runs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
			setBashRuns((runs) => [
				...runs,
				{ id, command, excludeFromContext, startedAt: Date.now(), baseKeys: new Set(Object.keys(latestState.current.bashOutput)), done: false },
			]);
			try {
				await conv.ensureLive();
				const res = await conv.rpc({ type: "bash", command, ...(excludeFromContext ? { excludeFromContext: true } : {}) }, 10 * 60_000);
				if (!res.success) throw new Error(res.error || "命令执行失败");
				update({ result: res.data as BashResult, key: res.id, done: true });
			} catch (e) {
				update({ done: true, error: errorMessage(e) });
				toast.error(errorMessage(e), { title: "命令执行失败" });
			}
		},
		[conv.ensureLive, conv.rpc],
	);

	// Finished runs are replaced by pi's own bashExecution message after a resync (pi defers it while a run streams).
	const { resync } = conv;
	useEffect(() => {
		if (state.isRunning) return;
		const finished = bashRuns.filter((r) => r.done && !r.syncing);
		if (finished.length === 0) return;
		const ids = new Set(finished.map((r) => r.id));
		setBashRuns((runs) => runs.map((r) => (ids.has(r.id) ? { ...r, syncing: true } : r)));
		resync()
			.catch(() => undefined)
			.finally(() => setBashRuns((runs) => runs.filter((r) => !ids.has(r.id))));
	}, [bashRuns, state.isRunning, resync]);

	const bashViews = useMemo(() => {
		const claimed = new Set(bashRuns.map((r) => r.key).filter((k): k is string => Boolean(k)));
		return bashRuns.map((run): BashRunView & { id: string } => {
			let key = run.key;
			if (!key) {
				key = Object.keys(state.bashOutput).find((k) => !run.baseKeys.has(k) && !claimed.has(k));
				if (key) claimed.add(key);
			}
			const streamed = key ? state.bashOutput[key] : undefined;
			return {
				id: run.id,
				command: run.command,
				output: streamed ?? run.result?.output ?? run.error ?? "",
				running: !run.done,
				failed: Boolean(run.error),
				exitCode: run.result?.exitCode,
				cancelled: run.result?.cancelled,
				truncated: run.result?.truncated && !streamed,
				fullOutputPath: run.result?.fullOutputPath,
				excludeFromContext: run.excludeFromContext,
				startedAt: run.startedAt,
			};
		});
	}, [bashRuns, state.bashOutput]);
	const bashRunning = bashRuns.some((r) => !r.done);
	const abortBash = useCallback(() => {
		conv.call({ type: "abort_bash" }).catch((e: unknown) => toast.error(errorMessage(e), { title: "中止命令失败" }));
	}, [conv.call]);

	// ---------- messages & banners ----------

	const items = useMemo(() => buildDisplayItems(state), [state.messages, state.streaming, state.streamingToolArgs, state.tools, state.isRunning]);
	const waiting = conv.isLive && state.isRunning && !state.streaming && !state.isCompacting && !hasRunningTool(state);
	const todoSnapshot = useMemo(
		() => selectTodoSnapshot({ statuses: state.ui.statuses, readOnlyFile: conv.readOnlyFile, messages: state.messages }),
		[state.ui.statuses, conv.readOnlyFile, state.messages],
	);

	// Each banner remembers its own dismissal (one shared slot brought the other back).
	const [dismissedErrors, setDismissedErrors] = useState<ReadonlySet<string>>(() => new Set());
	const dismissError = useCallback((message: string) => setDismissedErrors((prev) => new Set(prev).add(message)), []);
	const syncError = !offline && conv.error && items.length > 0 && !dismissedErrors.has(`sync:${conv.error}`) ? conv.error : undefined;
	const lastMessage = state.messages[state.messages.length - 1] as { role: string; errorMessage?: string } | undefined;
	const lastError =
		state.lastError && !dismissedErrors.has(`turn:${state.lastError}`) && !(lastMessage?.role === "assistant" && lastMessage.errorMessage === state.lastError)
			? state.lastError
			: undefined;

	// The crash banner belongs to the process that crashed: a new process (sending resumes the session) hides it.
	const [exitInfo, setExitInfo] = useState<{ convId: string | null; exited: NonNullable<typeof state.exited> } | undefined>(undefined);
	useEffect(() => {
		const exited = state.exited;
		if (exited && (exited.signal || (exited.code !== null && exited.code !== 0))) setExitInfo({ convId: conv.convId, exited });
	}, [state.exited]);
	const showExit = exitInfo && !(conv.isLive && conv.convId !== exitInfo.convId) ? exitInfo.exited : undefined;

	// ---------- side panel & dialogs ----------

	const wide = useMediaMinWidth(1180);
	const [panelPref, setPanelPref] = useStoredState("pi-web:chat-panel-open", true);
	const [panelNarrow, setPanelNarrow] = useState(false);
	const panelOpen = wide ? panelPref : panelNarrow;
	const setPanelOpen = (open: boolean) => (wide ? setPanelPref(open) : setPanelNarrow(open));
	const [dialog, setDialog] = useState<"tree" | "fork" | "compact" | "rename" | "delete" | null>(null);
	const closeDialog = useCallback(() => setDialog(null), []);

	const sessionName = state.sessionName ?? conv.session?.name ?? "";

	// ---------- archive ----------

	// Archiving only hides the session in Pi-Web (host-side mark); sending restores it first.
	const archivedAt = conv.session?.archivedAt;
	const archiveServerId = conv.serverId;
	const archiveFile = conv.session?.file;
	const [archiveBusy, setArchiveBusy] = useState(false);
	const setArchived = useCallback(
		async (archived: boolean): Promise<boolean> => {
			if (!archiveServerId || !archiveFile) return false;
			setArchiveBusy(true);
			try {
				await setSessionArchived(archiveServerId, archiveFile, archived);
				return true;
			} catch (e) {
				toast.error(errorMessage(e), { title: archived ? "归档失败" : "恢复会话失败" });
				return false;
			} finally {
				setArchiveBusy(false);
			}
		},
		[archiveServerId, archiveFile],
	);
	const restoreBeforeSend = useCallback(() => setArchived(false), [setArchived]);
	const toggleArchived = () => {
		const archive = archivedAt === undefined;
		void setArchived(archive).then((ok) => {
			if (ok) toast.success(archive ? "会话已归档" : "会话已恢复");
		});
	};

	// ---------- render ----------

	let placeholder: ReactNode;
	if (offline && server && items.length === 0 && (conv.error || conv.mode !== "new"))
		placeholder = (
			<EmptyState
				icon={<CloudOff />}
				title="服务器未连接"
				description={
					<>
						对话需要通过 SSH 连接到 <span className="text-fg">{server.config.name}</span>。
						{connection === "error" && server.status.error ? <span className="mt-1 block text-danger">{server.status.error}</span> : null}
					</>
				}
				actions={<ConnectButton serverId={server.config.id} />}
			/>
		);
	else if (conv.loading && items.length === 0) placeholder = <LoadingBlock text="正在加载会话…" />;
	else if (conv.mode === "new" && routeSessionId && conv.error)
		placeholder = (
			<EmptyState
				icon={<CircleAlert />}
				title="找不到该会话"
				description={conv.error}
				actions={
					<ButtonLink to={paths.chat(workspaceId)} variant="primary" icon={<MessageSquarePlus size={14} />}>
						新建对话
					</ButtonLink>
				}
			/>
		);
	else if (conv.error && items.length === 0)
		placeholder = (
			<Callout tone="danger" title="无法加载会话">
				{conv.error}
			</Callout>
		);
	else if (items.length === 0 && bashViews.length === 0 && !state.isRunning)
		placeholder =
			conv.mode === "new" ? (
				<EmptyState
					icon={<MessageSquarePlus />}
					title="开始新对话"
					description={
						<>
							在 <code className="text-mono text-fg">{conv.workspace?.config.alias ?? conv.workspace?.config.path ?? "工作区"}</code> 中运行 pi。输入
							<code className="mx-1 text-mono text-fg">/</code>调用命令与技能，
							<code className="mx-1 text-mono text-fg">!命令</code>执行 bash，也可以粘贴或拖入图片。
						</>
					}
				/>
			) : (
				<EmptyState icon={<MessageSquarePlus />} title={sessionTitle(conv.session)} description="这个会话还没有消息。" compact />
			);

	const panelToggle = !panelOpen ? (
		<div className="absolute top-2 right-3 z-10">
			<IconButton aria-label="展开会话信息" variant="secondary" size="md" onClick={() => setPanelOpen(true)}>
				<PanelRightOpen size={15} strokeWidth={1.8} />
			</IconButton>
		</div>
	) : null;

	return (
		<div className="relative flex min-h-0 flex-1">
			<section aria-label="对话" className="flex min-w-0 flex-1 flex-col bg-bg">
				{archivedAt !== undefined && <ArchivedBanner archivedAt={archivedAt} restoring={archiveBusy} onRestore={toggleArchived} />}
				<MessageList
					items={items}
					workspaceId={workspaceId}
					resetKey={viewKey}
					bashRuns={bashViews}
					waiting={waiting}
					placeholder={placeholder}
					overlay={panelToggle}
					timing={state.timing}
				/>
				<div className="shrink-0 px-4 pb-4 sm:px-6">
					<div className="mx-auto flex max-w-[860px] flex-col gap-2">
						{state.isCompacting && conv.isLive && <CompactingBanner />}
						{state.retry && conv.isLive && (
							<RetryBanner
								retry={state.retry}
								onStop={() => conv.call({ type: "abort_retry" }).catch((e: unknown) => toast.error(errorMessage(e), { title: "停止重试失败" }))}
							/>
						)}
						{offline && server && (items.length > 0 || conv.mode === "new") && (
							<Callout tone="warning" title={`${server.config.name} 未连接`} actions={<ConnectButton serverId={server.config.id} size="sm" label="连接" />}>
								重新连接后才能发送消息。
							</Callout>
						)}
						{lastError && <ErrorBanner message={lastError} onDismiss={() => dismissError(`turn:${lastError}`)} />}
						{syncError && <ErrorBanner message={`同步会话失败：${syncError}`} onDismiss={() => dismissError(`sync:${syncError}`)} />}
						{showExit && <ExitedBanner exited={showExit} onDismiss={() => setExitInfo(undefined)} />}
						<TodoPanel snapshot={todoSnapshot} />
						{conv.isLive && <ExtensionStatuses statuses={state.ui.statuses} />}
						{conv.isLive && <ExtensionWidgets widgets={state.ui.widgets} placement="aboveEditor" />}
						<Composer
							ref={composerRef}
							conv={conv}
							draftKey={`${workspaceId}:${routeSessionId ?? "new"}`}
							onBash={runBash}
							bashRunning={bashRunning}
							onAbortBash={abortBash}
							beforeSend={archivedAt !== undefined ? restoreBeforeSend : undefined}
						/>
						{conv.isLive && <ExtensionWidgets widgets={state.ui.widgets} placement="belowEditor" />}
					</div>
				</div>
			</section>

			{panelOpen && (
				<InfoPanel
					conv={conv}
					onClose={() => setPanelOpen(false)}
					onOpenTree={() => setDialog("tree")}
					onOpenFork={() => setDialog("fork")}
					onOpenCompact={() => setDialog("compact")}
					onOpenRename={() => setDialog("rename")}
					onOpenDelete={() => setDialog("delete")}
					archived={archivedAt !== undefined}
					archiveBusy={archiveBusy}
					onToggleArchive={toggleArchived}
					className={wide ? "w-[288px] shrink-0" : "absolute inset-y-0 right-0 z-20 w-[300px] max-w-[90%] shadow-pop"}
				/>
			)}

			<SessionTreeModal open={dialog === "tree"} onClose={closeDialog} conv={conv} onFillComposer={fillComposer} />
			<ForkDialog open={dialog === "fork"} onClose={closeDialog} conv={conv} onForked={fillComposer} />
			<CompactDialog open={dialog === "compact"} onClose={closeDialog} conv={conv} />
			<RenameDialog open={dialog === "rename"} onClose={closeDialog} conv={conv} currentName={sessionName} />
			<DeleteSessionDialog
				open={dialog === "delete"}
				onClose={closeDialog}
				conv={conv}
				title={sessionName || sessionTitle(conv.session)}
				onDeleted={() => navigate(paths.chat(workspaceId), { replace: true })}
			/>
			<ExtensionUiDialogs conv={conv} />
		</div>
	);
}
