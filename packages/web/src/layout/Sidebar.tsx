import type { ConversationView, ServerView, SessionSummary, WorkspaceView } from "@pi-web/shared";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Folder, FolderPlus, Plus, RefreshCw, Search, Server as ServerIcon, Settings2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { setSessionArchived } from "../api/archive";
import { errorMessage, stopConversation } from "../api/client";
import { useAllWorkspaces, useServerWorkspaces, useWorkspaceSessions } from "../api/hooks";
import { Segmented } from "../components/ui/Choice";
import { StatusDot } from "../components/ui/Display";
import { IconButton } from "../components/ui/IconButton";
import { Spinner } from "../components/ui/Spinner";
import { cn } from "../lib/cn";
import { formatRelativeTime } from "../lib/format";
import { parseRoute, paths } from "../lib/routes";
import {
	archiveBlockedReason,
	isArchived,
	isInProgress,
	liveConversationForSession,
	matchesSessionQuery,
	sessionRouteId,
	sessionTitle,
	sidebarSessionGroups,
	unlistedConversations,
} from "../lib/sessions";
import { DeleteSessionModal } from "../pages/chat/components/DeleteSessionModal";
import { NewWorkspaceDialog } from "../pages/workspace/NewWorkspaceDialog";
import { WorkspaceSettingsDialog } from "../pages/workspace/WorkspaceSettingsDialog";
import { convStatusDisplay, serverStatusDisplay } from "../lib/status";
import { useAttentionStore } from "../stores/attention";
import { useLiveConversations } from "../stores/convs";
import { useServers, useServersStore } from "../stores/servers";
import { toast } from "../stores/toasts";
import { useUiStore } from "../stores/ui";

const SESSIONS_PREVIEW = 8;
/**
 * Session row actions: shown on hover and keyboard focus (always on touch screens). The opacity is
 * on this wrapper, not the buttons, so a disabled button (IconButton's disabled:opacity-50) stays hidden too.
 */
const ROW_ACTIONS =
	"absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover/session:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * Archiving or restoring from a row moves the row (and its focused button) to the other list.
 * The row reports the move before it starts; once it has rendered, focus that dropped to <body>
 * goes to the moved row, the 已归档 toggle or the workspace row instead.
 */
type TrackFocus = (move: { file: string; archived: boolean } | null) => void;

interface SidebarContext {
	query: string;
	/** Set while the 进行中 filter is on: the in-progress conversations of all workspaces. */
	inProgress?: readonly ConversationView[];
	activeServerId?: string;
	activeWorkspaceId?: string;
	activeSessionId?: string;
	/** The workspace's files/terminal/git page is open (its row is highlighted, as in the artboards). */
	workspacePageActive?: boolean;
}

function SessionRow({
	workspaceId,
	serverId,
	session,
	conv,
	active,
	trackFocus,
}: {
	workspaceId: string;
	serverId: string;
	session?: SessionSummary;
	conv?: ConversationView;
	active: boolean;
	trackFocus: TrackFocus;
}) {
	const live = convStatusDisplay(conv?.info.status);
	const running = conv?.info.status === "running" || conv?.info.status === "starting";
	const waiting = conv?.info.status === "waiting_ui";
	const routeId = session ? sessionRouteId(session) : conv?.info.sessionId;
	const unread = useAttentionStore((s) => {
		const key = conv?.info.sessionId ?? session?.id ?? routeId;
		return key ? s.unread[key] : undefined;
	});
	const title = session ? sessionTitle(session) : conv?.info.sessionName || "新对话";
	const subtitle =
		running || waiting
			? live?.text
			: session
				? `${formatRelativeTime(session.modifiedMs)} · ${session.messageCount} 条消息`
				: (live?.text ?? "");
	const to = routeId ? paths.chat(workspaceId, routeId) : paths.chat(workspaceId);
	const archiveBlocked = archiveBlockedReason(conv?.info.status);
	const [archiving, setArchiving] = useState(false);
	const archive = async () => {
		if (!session || archiving) return;
		setArchiving(true);
		trackFocus({ file: session.file, archived: true });
		try {
			await setSessionArchived(serverId, session.file, true);
			toast.success("会话已归档，可在“已归档”中找回");
		} catch (e) {
			trackFocus(null);
			toast.error(errorMessage(e), { title: "归档失败" });
		} finally {
			setArchiving(false);
		}
	};
	return (
		<div className="group/session relative">
			<Link
				to={to}
				aria-current={active ? "page" : undefined}
				data-session-file={session?.file}
				className={cn(
					"flex flex-col gap-0.5 rounded-md px-2 py-1.5",
					active ? "bg-selected text-fg hover:text-fg" : "text-fg-2 hover:bg-raised hover:text-fg",
					session && "group-hover/session:pr-7 group-has-[:focus-visible]/session:pr-7 [@media(hover:none)]:pr-7",
				)}
			>
				<span className="flex items-center gap-1.5 text-sm">
					<StatusDot
						tone={running ? "accent" : waiting ? "warning" : "neutral"}
						pulse={running}
						hollow={!running && !waiting}
						srLabel={live?.text}
					/>
					<span className="min-w-0 flex-1 truncate">{title}</span>
					{unread && !active && (
						<span
							className="shrink-0 rounded-sm bg-selected px-1 text-2xs leading-4 text-accent"
							title={unread === "waiting" ? "等待你的确认" : "有新的回复"}
						>
							未读
						</span>
					)}
				</span>
				{subtitle && (
					<span className={cn("truncate pl-3.5 text-2xs", running ? "text-link" : waiting ? "text-warning" : "text-fg-3")}>{subtitle}</span>
				)}
			</Link>
			{session && (
				<div className={ROW_ACTIONS}>
					{/* Not disabled while archiving: a disabled button would drop the keyboard focus. */}
					<IconButton
						aria-label={`归档会话 ${title}`}
						title={archiveBlocked ?? undefined}
						size="xs"
						variant="subtle"
						disabled={Boolean(archiveBlocked)}
						onClick={() => void archive()}
					>
						<Archive size={12} strokeWidth={2} />
					</IconButton>
				</div>
			)}
		</div>
	);
}

/** A row of the 已归档 group: opens the session (read-only until a message is sent), 恢复 and 删除. */
function ArchivedSessionRow({
	workspaceId,
	serverId,
	session,
	conv,
	active,
	trackFocus,
}: {
	workspaceId: string;
	serverId: string;
	session: SessionSummary;
	conv?: ConversationView;
	active: boolean;
	trackFocus: TrackFocus;
}) {
	const navigate = useNavigate();
	const title = sessionTitle(session);
	const routeId = sessionRouteId(session);
	const [restoring, setRestoring] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const restore = async () => {
		if (restoring) return;
		setRestoring(true);
		trackFocus({ file: session.file, archived: false });
		try {
			await setSessionArchived(serverId, session.file, false);
			toast.success("会话已恢复");
		} catch (e) {
			trackFocus(null);
			toast.error(errorMessage(e), { title: "恢复失败" });
		} finally {
			setRestoring(false);
		}
	};
	const convId = conv?.convId;
	return (
		<div className="group/session relative">
			<Link
				to={paths.chat(workspaceId, routeId)}
				aria-current={active ? "page" : undefined}
				className={cn(
					"flex flex-col gap-0.5 rounded-md px-2 py-1.5 group-hover/session:pr-12 group-has-[:focus-visible]/session:pr-12 [@media(hover:none)]:pr-12",
					active ? "bg-selected text-fg hover:text-fg" : "text-fg-3 hover:bg-raised hover:text-fg",
				)}
			>
				<span className="flex items-center gap-1.5 text-sm">
					<Archive size={11} strokeWidth={2} className="shrink-0 text-fg-3" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate">{title}</span>
				</span>
				<span className="truncate pl-[17px] text-2xs text-fg-3">归档于 {formatRelativeTime(session.archivedAt)}</span>
			</Link>
			<div className={ROW_ACTIONS}>
				<IconButton aria-label={`恢复会话 ${title}`} size="xs" variant="subtle" onClick={() => void restore()}>
					<ArchiveRestore size={12} strokeWidth={2} />
				</IconButton>
				<IconButton aria-label={`删除会话 ${title}`} size="xs" variant="subtle" onClick={() => setDeleteOpen(true)}>
					<Trash2 size={12} strokeWidth={2} />
				</IconButton>
			</div>
			{deleteOpen && (
				<DeleteSessionModal
					open
					onClose={() => setDeleteOpen(false)}
					title={title}
					target={{
						serverId,
						sessionFile: session.file,
						workspaceId,
						sessionIds: [routeId, session.id],
						isLive: Boolean(convId),
						stop: async () => {
							if (convId) await stopConversation(convId);
						},
					}}
					onDeleted={() => {
						if (active) navigate(paths.chat(workspaceId), { replace: true });
					}}
				/>
			)}
		</div>
	);
}

function WorkspaceNode({ workspace, server, ctx }: { workspace: WorkspaceView; server: ServerView; ctx: SidebarContext }) {
	const wsId = workspace.config.id;
	const searching = ctx.query.trim().length > 0;
	const filtering = ctx.inProgress !== undefined;
	// Searching or filtering narrows the list: everything that matches is shown, without the new-session row.
	const narrowed = searching || filtering;
	// The 进行中 filter shows only workspaces with an in-progress conversation, expanded.
	const hasInProgress = ctx.inProgress?.some((c) => c.workspaceId === wsId) ?? false;
	const stored = useUiStore((s) => s.expandedWorkspaces[wsId]);
	const setExpanded = useUiStore((s) => s.setWorkspaceExpanded);
	const expanded = searching || hasInProgress || (stored ?? false);
	const online = server.status.connection === "connected";
	// Listing needs the agent: while offline keep showing the cached list instead of failing requests.
	const sessionsQuery = useWorkspaceSessions(wsId, { enabled: expanded && online });
	const liveConvs = useLiveConversations(wsId);
	const navigate = useNavigate();
	const [showAll, setShowAll] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [archivedOpen, setArchivedOpen] = useState(false);

	const sessions = sessionsQuery.data;
	// Archived sessions leave the list (and the count) for the collapsed 已归档 group.
	const groups = useMemo(
		() => sidebarSessionGroups(sessions ?? [], ctx.query, filtering ? liveConvs : undefined),
		[sessions, ctx.query, filtering, liveConvs],
	);
	const filtered = groups.active;
	const archived = groups.archived;
	const extra = useMemo(
		() =>
			sessions
				? unlistedConversations(wsId, sessions, liveConvs).filter(
						(c) => matchesSessionQuery({ name: c.info.sessionName, firstMessage: "" }, ctx.query) && (!filtering || isInProgress(c.info.status)),
					)
				: [],
		[sessions, liveConvs, wsId, ctx.query, filtering],
	);
	const runningCount = liveConvs.filter((c) => c.info.status === "running" || c.info.status === "waiting_ui").length;
	const count = sessions ? groups.count : workspace.sessionCount;
	const activeWs = ctx.activeWorkspaceId === wsId;
	// Opening an archived session (link, browser history) reveals it in the group, also when the
	// sidebar mounts on it (mobile drawer, re-expanded server).
	const viewingArchived = activeWs && archived.some((s) => sessionRouteId(s) === ctx.activeSessionId);
	const [prevViewingArchived, setPrevViewingArchived] = useState(false);
	if (prevViewingArchived !== viewingArchived) {
		setPrevViewingArchived(viewingArchived);
		if (viewingArchived) setArchivedOpen(true);
	}
	// The group is collapsed by default each time it appears again.
	if (archivedOpen && sessions && !sessions.some(isArchived)) setArchivedOpen(false);
	const showArchived = archivedOpen || narrowed;

	const nodeRef = useRef<HTMLDivElement>(null);
	const focusMove = useRef<{ file: string; archived: boolean } | null>(null);
	const trackFocus: TrackFocus = (move) => {
		focusMove.current = move;
	};
	useEffect(() => {
		const move = focusMove.current;
		if (!move || !sessions) return;
		const moved = sessions.find((s) => s.file === move.file);
		if (moved && isArchived(moved) !== move.archived) return; // not rendered yet
		focusMove.current = null;
		if (document.activeElement && document.activeElement !== document.body) return; // focus is elsewhere
		const root = nodeRef.current;
		if (!root) return;
		const row = [...root.querySelectorAll<HTMLElement>("a[data-session-file]")].find((a) => a.dataset.sessionFile === move.file);
		const target = row ?? root.querySelector<HTMLElement>("[data-archived-toggle]") ?? root.querySelector<HTMLElement>("[data-workspace-toggle]");
		target?.focus();
	}, [sessions]);

	if (filtering && !hasInProgress) return null;
	if (narrowed && sessions && filtered.length === 0 && extra.length === 0 && archived.length === 0) return null;

	const visible = showAll || narrowed ? filtered : filtered.slice(0, SESSIONS_PREVIEW);
	const pageActive = activeWs && Boolean(ctx.workspacePageActive);
	const offline = !online;

	return (
		<div ref={nodeRef} className="flex flex-col gap-0.5">
			<div className={cn("group/ws flex h-7 items-center rounded-md", pageActive ? "bg-selected" : "hover:bg-raised")}>
				<button
					type="button"
					aria-expanded={expanded}
					data-workspace-toggle=""
					onClick={() => setExpanded(wsId, !expanded)}
					title={workspace.config.path}
					className={cn(
						"flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-sm",
						activeWs ? "text-fg" : "text-fg-2 hover:text-fg",
						pageActive && "font-semibold",
					)}
				>
					{expanded ? (
						<ChevronDown size={12} strokeWidth={2.2} className="shrink-0 text-fg-3" aria-hidden="true" />
					) : (
						<ChevronRight size={12} strokeWidth={2.2} className="shrink-0 text-fg-3" aria-hidden="true" />
					)}
					<Folder size={14} strokeWidth={1.7} className={cn("shrink-0", activeWs ? "text-accent" : "text-fg-2")} aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate">{workspace.config.alias || workspace.config.path}</span>
					{runningCount > 0 && <StatusDot tone="accent" pulse srLabel={`${runningCount} 个对话运行中`} size={6} />}
					{count !== undefined && <span className="text-2xs text-fg-3">{count}</span>}
				</button>
				<IconButton
					aria-label={`工作区设置 ${workspace.config.alias || workspace.config.path}`}
					size="xs"
					variant="subtle"
					onClick={() => setSettingsOpen(true)}
					className="mr-1 opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
				>
					<Settings2 size={12} strokeWidth={2} />
				</IconButton>
			</div>
			{settingsOpen && <WorkspaceSettingsDialog workspaceId={wsId} open onClose={() => setSettingsOpen(false)} />}
			{expanded && (
				<div className="flex flex-col gap-0.5 pl-5">
					{offline && !sessions && (
						<span className="flex min-h-7 items-center px-2 text-xs text-fg-3">服务器离线，无法读取会话</span>
					)}
					{sessionsQuery.isLoading && (
						<span className="flex h-7 items-center gap-2 px-2 text-xs text-fg-3">
							<Spinner size={11} /> 加载会话…
						</span>
					)}
					{online && sessionsQuery.isError && (
						<span className="flex min-h-7 items-center gap-2 px-2 text-xs text-fg-3">
							无法加载会话
							<button
								type="button"
								aria-label="重试"
								title="重试"
								onClick={() => void sessionsQuery.refetch()}
								className="inline-flex size-5 items-center justify-center rounded-sm bg-transparent text-fg-3 hover:bg-raised hover:text-fg"
							>
								<RefreshCw size={11} aria-hidden="true" />
							</button>
						</span>
					)}
					{extra.map((c) => (
						<SessionRow
							key={c.convId}
							workspaceId={wsId}
							serverId={server.config.id}
							conv={c}
							active={activeWs && (ctx.activeSessionId === c.info.sessionId || (!ctx.activeSessionId && !c.info.sessionId))}
							trackFocus={trackFocus}
						/>
					))}
					{visible.map((s) => (
						<SessionRow
							key={s.file}
							workspaceId={wsId}
							serverId={server.config.id}
							session={s}
							conv={liveConversationForSession(s, liveConvs)}
							active={activeWs && ctx.activeSessionId === sessionRouteId(s)}
							trackFocus={trackFocus}
						/>
					))}
					{!narrowed && filtered.length > SESSIONS_PREVIEW && (
						<button
							type="button"
							onClick={() => setShowAll((v) => !v)}
							className="flex h-6 items-center rounded-md border-0 bg-transparent px-2 text-left text-xs text-fg-3 hover:text-fg"
						>
							{showAll ? "收起" : `显示全部（${filtered.length}）`}
						</button>
					)}
					{!narrowed && (
						<button
							type="button"
							onClick={() => navigate(paths.chat(wsId))}
							className="flex h-7 items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-left text-xs text-fg-3 hover:bg-raised hover:text-fg"
						>
							<Plus size={12} strokeWidth={2} aria-hidden="true" />
							新建对话
						</button>
					)}
					{archived.length > 0 && (
						<>
							<button
								type="button"
								aria-expanded={showArchived}
								data-archived-toggle=""
								// While searching or filtering the group is always shown: the toggle does nothing then.
								onClick={() => !narrowed && setArchivedOpen(!archivedOpen)}
								className="flex h-7 items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-left text-xs text-fg-3 hover:bg-raised hover:text-fg"
							>
								{showArchived ? (
									<ChevronDown size={12} strokeWidth={2.2} aria-hidden="true" />
								) : (
									<ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
								)}
								已归档（{archived.length}）
							</button>
							{showArchived && (
								<div role="group" aria-label="已归档的会话" className="flex flex-col gap-0.5">
									{archived.map((s) => (
										<ArchivedSessionRow
											key={s.file}
											workspaceId={wsId}
											serverId={server.config.id}
											session={s}
											conv={liveConversationForSession(s, liveConvs)}
											active={activeWs && ctx.activeSessionId === sessionRouteId(s)}
											trackFocus={trackFocus}
										/>
									))}
								</div>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

function ServerNode({ server, ctx }: { server: ServerView; ctx: SidebarContext }) {
	const id = server.config.id;
	const searching = ctx.query.trim().length > 0;
	// The 进行中 filter lists only servers with an in-progress conversation (see Sidebar), expanded.
	const narrowed = searching || ctx.inProgress !== undefined;
	const stored = useUiStore((s) => s.expandedServers[id]);
	const setExpanded = useUiStore((s) => s.setServerExpanded);
	const expanded = narrowed || (stored ?? true);
	const workspaces = useServerWorkspaces(expanded ? id : undefined);
	const status = serverStatusDisplay(server);
	const active = ctx.activeServerId === id && !ctx.activeWorkspaceId;
	const offline = server.status.connection !== "connected";
	const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);

	return (
		<div className="flex flex-col gap-0.5">
			<div
				className={cn(
					"group flex h-8 items-center gap-2 rounded-md px-2 text-sm font-semibold",
					active ? "bg-selected" : "hover:bg-raised",
					offline && !active ? "text-fg-3" : "text-fg",
				)}
			>
				<button
					type="button"
					aria-expanded={expanded}
					aria-label={`${expanded ? "收起" : "展开"} ${server.config.name}`}
					onClick={() => setExpanded(id, !expanded)}
					className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent text-fg-3 hover:text-fg"
				>
					{expanded ? <ChevronDown size={12} strokeWidth={2.2} /> : <ChevronRight size={12} strokeWidth={2.2} />}
				</button>
				<StatusDot tone={status.tone} hollow={status.hollow} pulse={status.pulse} />
				<Link
					to={paths.server(id)}
					aria-current={active ? "page" : undefined}
					className={cn("min-w-0 flex-1 truncate", offline && !active ? "text-fg-3 hover:text-fg" : "text-fg hover:text-fg")}
				>
					{server.config.name}
				</Link>
				<span className={cn("shrink-0 text-2xs font-medium", status.tone === "danger" ? "text-danger" : status.tone === "warning" ? "text-warning" : active ? "text-fg-2" : "text-fg-3")}>
					{status.text}
				</span>
			</div>
			{expanded && (
				<div className="flex flex-col gap-0.5 pl-[18px]">
					{workspaces.isLoading && (
						<span className="flex h-7 items-center gap-2 px-2 text-xs text-fg-3">
							<Spinner size={11} /> 加载工作区…
						</span>
					)}
					{workspaces.isError && <span className="flex h-7 items-center px-2 text-xs text-fg-3">无法加载工作区</span>}
					{workspaces.data?.length === 0 && !narrowed && <span className="flex h-7 items-center px-2 text-xs text-fg-3">暂无工作区</span>}
					{workspaces.data?.map((w) => (
						<WorkspaceNode key={w.config.id} workspace={w} server={server} ctx={ctx} />
					))}
					{!narrowed && workspaces.data && (
						<button
							type="button"
							onClick={() => setNewWorkspaceOpen(true)}
							className="flex h-7 items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-left text-xs text-fg-3 hover:bg-raised hover:text-fg"
						>
							<FolderPlus size={12} strokeWidth={2} aria-hidden="true" />
							新建工作区
						</button>
					)}
				</div>
			)}
			{newWorkspaceOpen && <NewWorkspaceDialog serverId={id} open onClose={() => setNewWorkspaceOpen(false)} />}
		</div>
	);
}

/** Expands the server/workspace of the current route so the active session is visible. */
function useAutoExpand(serverId: string | undefined, workspaceId: string | undefined) {
	const setServerExpanded = useUiStore((s) => s.setServerExpanded);
	const setWorkspaceExpanded = useUiStore((s) => s.setWorkspaceExpanded);
	useEffect(() => {
		if (serverId && useUiStore.getState().expandedServers[serverId] === false) setServerExpanded(serverId, true);
		if (workspaceId && !useUiStore.getState().expandedWorkspaces[workspaceId]) setWorkspaceExpanded(workspaceId, true);
	}, [serverId, workspaceId, setServerExpanded, setWorkspaceExpanded]);
}

/**
 * Left sidebar (264px): session search, the 全部/进行中 filter, server → workspace → session tree
 * with live running/waiting badges, and footer links (同步中心, 添加服务器).
 */
export function Sidebar({ className }: { className?: string }) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<"all" | "inProgress">("all");
	const liveConvs = useLiveConversations();
	// Conversations outside a workspace have no row in the tree.
	const inProgress = useMemo(() => liveConvs.filter((c) => c.workspaceId && isInProgress(c.info.status)), [liveConvs]);
	const location = useLocation();
	const route = parseRoute(location.pathname);
	const servers = useServers();
	const loaded = useServersStore((s) => s.loaded);
	const error = useServersStore((s) => s.error);
	const allWorkspaces = useAllWorkspaces();

	const activeWorkspaceId = route.kind === "workspace" ? route.workspaceId : undefined;
	const workspaceServerId = activeWorkspaceId ? allWorkspaces.data?.find((w) => w.config.id === activeWorkspaceId)?.config.serverId : undefined;
	const activeServerId = route.kind === "server" || route.kind === "serverSettings" ? route.serverId : workspaceServerId;
	const ctx: SidebarContext = {
		query,
		inProgress: filter === "inProgress" ? inProgress : undefined,
		activeServerId,
		activeWorkspaceId,
		activeSessionId: route.kind === "workspace" && route.tab === "chat" ? route.sessionId : undefined,
		workspacePageActive: route.kind === "workspace" && route.tab !== "chat",
	};
	useAutoExpand(workspaceServerId, activeWorkspaceId);
	const shownServers = ctx.inProgress ? servers.filter((s) => ctx.inProgress?.some((c) => c.serverId === s.config.id)) : servers;

	const footerLink = (active: boolean) =>
		cn(
			"flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-sm",
			active ? "bg-selected font-semibold text-fg hover:text-fg" : "text-fg-2 hover:bg-raised hover:text-fg",
		);

	return (
		<aside
			aria-label="服务器与会话"
			className={cn("flex min-h-0 w-[264px] shrink-0 flex-col border-r border-border bg-panel", className)}
		>
			<div className="flex flex-col gap-2.5 border-b border-border p-3">
				<label htmlFor="pw-session-search" className="section-label">
					搜索会话
				</label>
				<div className="flex h-8 items-center gap-2 rounded-md border border-border bg-bg px-2.5 focus-within:border-accent">
					<Search size={14} strokeWidth={1.8} className="shrink-0 text-fg-3" aria-hidden="true" />
					<input
						id="pw-session-search"
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") setQuery("");
						}}
						placeholder="名称或首条消息"
						className="min-w-0 flex-1 border-0 bg-transparent text-sm text-fg outline-none placeholder:text-fg-3 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
					/>
				</div>
				<Segmented
					aria-label="筛选会话"
					tone="sunken"
					value={filter}
					onChange={setFilter}
					options={[
						{ value: "all", label: "全部" },
						{
							value: "inProgress",
							label: (
								<>
									进行中
									{inProgress.length > 0 && <span className="text-2xs font-medium text-accent">{inProgress.length}</span>}
								</>
							),
							title: "运行中、启动中或等待确认的会话",
						},
					]}
				/>
			</div>

			<div className="relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-2">
				<div className="flex items-center justify-between px-2 pt-1.5 pb-1">
					<span className="section-label">服务器</span>
					<Link
						to={paths.addServer()}
						aria-label="添加服务器"
						title="添加服务器"
						className="flex size-6 items-center justify-center rounded-sm text-fg-2 hover:bg-raised hover:text-fg"
					>
						<Plus size={14} strokeWidth={2} aria-hidden="true" />
					</Link>
				</div>
				{!loaded && !error && (
					<span className="flex h-8 items-center gap-2 px-2 text-xs text-fg-3">
						<Spinner size={11} /> 加载中…
					</span>
				)}
				{error && !loaded && <span className="px-2 py-1 text-xs text-danger">{error}</span>}
				{loaded && servers.length === 0 && (
					<Link to={paths.addServer()} className="mx-1 mt-1 rounded-md border border-dashed border-border-strong px-3 py-3 text-xs text-fg-2 hover:text-fg">
						还没有服务器，点击添加第一台
					</Link>
				)}
				{loaded && servers.length > 0 && shownServers.length === 0 && (
					<span className="flex min-h-8 items-center px-2 text-xs text-fg-3">没有进行中的会话</span>
				)}
				{shownServers.map((s, i) => (
					<div key={s.config.id} className={cn(i > 0 && "mt-1.5")}>
						<ServerNode server={s} ctx={ctx} />
					</div>
				))}
			</div>

			<nav aria-label="管理" className="flex flex-col gap-0.5 border-t border-border px-1.5 py-2">
				<Link to={paths.sync()} aria-current={route.kind === "sync" ? "page" : undefined} className={footerLink(route.kind === "sync")}>
					<RefreshCw size={16} strokeWidth={1.7} aria-hidden="true" />
					同步中心
				</Link>
				<Link
					to={paths.addServer()}
					aria-current={route.kind === "addServer" ? "page" : undefined}
					className={footerLink(route.kind === "addServer")}
				>
					<ServerIcon size={16} strokeWidth={1.7} aria-hidden="true" />
					添加服务器
				</Link>
			</nav>
		</aside>
	);
}
