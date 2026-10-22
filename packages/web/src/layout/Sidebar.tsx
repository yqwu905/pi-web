import type { ConversationView, ServerView, SessionSummary, WorkspaceView } from "@pi-web/shared";
import { ChevronDown, ChevronRight, Folder, FolderPlus, Plus, RefreshCw, Search, Server as ServerIcon, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useAllWorkspaces, useServerWorkspaces, useWorkspaceSessions } from "../api/hooks";
import { StatusDot } from "../components/ui/Display";
import { IconButton } from "../components/ui/IconButton";
import { Spinner } from "../components/ui/Spinner";
import { cn } from "../lib/cn";
import { formatRelativeTime } from "../lib/format";
import { parseRoute, paths } from "../lib/routes";
import { liveConversationForSession, matchesSessionQuery, sessionRouteId, sessionTitle, unlistedConversations } from "../lib/sessions";
import { NewWorkspaceDialog } from "../pages/workspace/NewWorkspaceDialog";
import { WorkspaceSettingsDialog } from "../pages/workspace/WorkspaceSettingsDialog";
import { convStatusDisplay, serverStatusDisplay } from "../lib/status";
import { useLiveConversations } from "../stores/convs";
import { useServers, useServersStore } from "../stores/servers";
import { useUiStore } from "../stores/ui";

const SESSIONS_PREVIEW = 8;

interface SidebarContext {
	query: string;
	activeServerId?: string;
	activeWorkspaceId?: string;
	activeSessionId?: string;
}

function SessionRow({
	workspaceId,
	session,
	conv,
	active,
}: {
	workspaceId: string;
	session?: SessionSummary;
	conv?: ConversationView;
	active: boolean;
}) {
	const live = convStatusDisplay(conv?.info.status);
	const running = conv?.info.status === "running" || conv?.info.status === "starting";
	const waiting = conv?.info.status === "waiting_ui";
	const routeId = session ? sessionRouteId(session) : conv?.info.sessionId;
	const title = session ? sessionTitle(session) : conv?.info.sessionName || "新对话";
	const subtitle =
		running || waiting
			? live?.text
			: session
				? `${formatRelativeTime(session.modifiedMs)} · ${session.messageCount} 条消息`
				: (live?.text ?? "");
	const to = routeId ? paths.chat(workspaceId, routeId) : paths.chat(workspaceId);
	return (
		<Link
			to={to}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex flex-col gap-0.5 rounded-md px-2 py-1.5",
				active ? "bg-selected text-fg hover:text-fg" : "text-fg-2 hover:bg-raised hover:text-fg",
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
			</span>
			{subtitle && (
				<span className={cn("truncate pl-3.5 text-2xs", running ? "text-link" : waiting ? "text-warning" : "text-fg-3")}>{subtitle}</span>
			)}
		</Link>
	);
}

function WorkspaceNode({ workspace, server, ctx }: { workspace: WorkspaceView; server: ServerView; ctx: SidebarContext }) {
	const wsId = workspace.config.id;
	const searching = ctx.query.trim().length > 0;
	const stored = useUiStore((s) => s.expandedWorkspaces[wsId]);
	const setExpanded = useUiStore((s) => s.setWorkspaceExpanded);
	const expanded = searching || (stored ?? false);
	const sessionsQuery = useWorkspaceSessions(expanded ? wsId : undefined);
	const liveConvs = useLiveConversations(wsId);
	const navigate = useNavigate();
	const [showAll, setShowAll] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);

	const sessions = sessionsQuery.data;
	const filtered = useMemo(() => (sessions ?? []).filter((s) => matchesSessionQuery(s, ctx.query)), [sessions, ctx.query]);
	const extra = useMemo(
		() => (sessions ? unlistedConversations(wsId, sessions, liveConvs).filter((c) => matchesSessionQuery({ name: c.info.sessionName, firstMessage: "" }, ctx.query)) : []),
		[sessions, liveConvs, wsId, ctx.query],
	);
	const runningCount = liveConvs.filter((c) => c.info.status === "running" || c.info.status === "waiting_ui").length;
	const count = sessions?.length ?? workspace.sessionCount;

	if (searching && sessions && filtered.length === 0 && extra.length === 0) return null;

	const visible = showAll || searching ? filtered : filtered.slice(0, SESSIONS_PREVIEW);
	const activeWs = ctx.activeWorkspaceId === wsId;
	const offline = server.status.connection !== "connected";

	return (
		<div className="flex flex-col gap-0.5">
			<div className="group/ws flex h-7 items-center rounded-md hover:bg-raised">
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(wsId, !expanded)}
					title={workspace.config.path}
					className={cn(
						"flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-sm",
						activeWs ? "text-fg" : "text-fg-2 hover:text-fg",
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
					{sessionsQuery.isLoading && (
						<span className="flex h-7 items-center gap-2 px-2 text-xs text-fg-3">
							<Spinner size={11} /> 加载会话…
						</span>
					)}
					{sessionsQuery.isError && (
						<span className="flex min-h-7 items-center gap-2 px-2 text-xs text-fg-3">
							{offline ? "服务器离线，无法读取会话" : "无法加载会话"}
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
							conv={c}
							active={activeWs && (ctx.activeSessionId === c.info.sessionId || (!ctx.activeSessionId && !c.info.sessionId))}
						/>
					))}
					{visible.map((s) => (
						<SessionRow
							key={s.file}
							workspaceId={wsId}
							session={s}
							conv={liveConversationForSession(s, liveConvs)}
							active={activeWs && ctx.activeSessionId === sessionRouteId(s)}
						/>
					))}
					{!searching && filtered.length > SESSIONS_PREVIEW && (
						<button
							type="button"
							onClick={() => setShowAll((v) => !v)}
							className="flex h-6 items-center rounded-md border-0 bg-transparent px-2 text-left text-xs text-fg-3 hover:text-fg"
						>
							{showAll ? "收起" : `显示全部（${filtered.length}）`}
						</button>
					)}
					{!searching && (
						<button
							type="button"
							onClick={() => navigate(paths.chat(wsId))}
							className="flex h-7 items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-left text-xs text-fg-3 hover:bg-raised hover:text-fg"
						>
							<Plus size={12} strokeWidth={2} aria-hidden="true" />
							新建对话
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function ServerNode({ server, ctx }: { server: ServerView; ctx: SidebarContext }) {
	const id = server.config.id;
	const searching = ctx.query.trim().length > 0;
	const stored = useUiStore((s) => s.expandedServers[id]);
	const setExpanded = useUiStore((s) => s.setServerExpanded);
	const expanded = searching || (stored ?? true);
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
					{workspaces.data?.length === 0 && !searching && <span className="flex h-7 items-center px-2 text-xs text-fg-3">暂无工作区</span>}
					{workspaces.data?.map((w) => (
						<WorkspaceNode key={w.config.id} workspace={w} server={server} ctx={ctx} />
					))}
					{!searching && workspaces.data && (
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
 * Left sidebar (264px): session search, server → workspace → session tree with live
 * running/waiting badges, and footer links (同步中心, 添加服务器).
 */
export function Sidebar({ className }: { className?: string }) {
	const [query, setQuery] = useState("");
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
		activeServerId,
		activeWorkspaceId,
		activeSessionId: route.kind === "workspace" && route.tab === "chat" ? route.sessionId : undefined,
	};
	useAutoExpand(workspaceServerId, activeWorkspaceId);

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
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-2">
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
				{servers.map((s, i) => (
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
