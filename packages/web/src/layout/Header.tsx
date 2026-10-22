import { Menu as MenuIcon, RefreshCw, Shield, SlidersHorizontal, TriangleAlert, WifiOff } from "lucide-react";
import { Fragment, type ReactNode, useMemo } from "react";
import { Link, useLocation } from "react-router";
import { useSessionById, useSyncStatus, useWorkspace, useWsStatus } from "../api/hooks";
import { IconButton } from "../components/ui/IconButton";
import { Spinner } from "../components/ui/Spinner";
import { cn } from "../lib/cn";
import { parseRoute, paths, type RouteInfo, WORKSPACE_TAB_LABELS } from "../lib/routes";
import { sessionTitle } from "../lib/sessions";
import { useServer, useServers } from "../stores/servers";
import { useUiStore } from "../stores/ui";

export function Logo({ className }: { className?: string }) {
	return (
		<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn("text-accent", className)}>
			<rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" strokeWidth="1.8" />
			<path d="M7 8h10M10 8v9M14 8v6.5c0 1.5.8 2.5 2.5 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
		</svg>
	);
}

interface Crumb {
	label: ReactNode;
	to?: string;
}

/** Server id implied by the current route (server pages, or the workspace's server). */
export function useRouteServerId(route: RouteInfo): string | undefined {
	const { workspace } = useWorkspace(route.kind === "workspace" ? route.workspaceId : undefined);
	if (route.kind === "server" || route.kind === "serverSettings") return route.serverId;
	if (route.kind === "workspace") return workspace?.config.serverId;
	return undefined;
}

function useBreadcrumb(route: RouteInfo): Crumb[] {
	const serverId = useRouteServerId(route);
	const server = useServer(serverId);
	const wsId = route.kind === "workspace" ? route.workspaceId : undefined;
	const { workspace } = useWorkspace(wsId);
	const sessionId = route.kind === "workspace" && route.tab === "chat" ? route.sessionId : undefined;
	const { session } = useSessionById(sessionId ? wsId : undefined, sessionId);
	const serverName = server?.config.name ?? serverId ?? "…";

	switch (route.kind) {
		case "addServer":
			return [{ label: "服务器" }, { label: "添加服务器" }];
		case "server":
			return [{ label: "服务器" }, { label: serverName }];
		case "serverSettings":
			return [{ label: "服务器" }, { label: serverName, to: paths.server(route.serverId) }, { label: "设置" }];
		case "workspace": {
			const crumbs: Crumb[] = [
				{ label: serverName, to: serverId ? paths.server(serverId) : undefined },
				{ label: workspace?.config.alias ?? "…", to: paths.chat(route.workspaceId) },
			];
			if (route.tab === "chat") crumbs.push({ label: route.sessionId ? (session ? sessionTitle(session, 48) : "对话") : "新对话" });
			else crumbs.push({ label: WORKSPACE_TAB_LABELS[route.tab] });
			return crumbs;
		}
		case "sync":
			return [{ label: "同步中心" }];
		case "settings":
			return [{ label: "全局设置" }];
		default:
			return [];
	}
}

const BADGE = "flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-fg-2 hover:border-border-strong hover:text-fg";

function ProxyBadge({ serverId }: { serverId: string | undefined }) {
	const server = useServer(serverId);
	const servers = useServers();
	const info = useMemo(() => {
		if (server) {
			if (server.config.proxy.mode === "off") return { text: "代理关闭", to: paths.server(server.config.id), on: false };
			return { text: `隧道代理 · ${server.status.proxy?.active ?? 0} 个连接`, to: paths.server(server.config.id), on: true };
		}
		const tunnel = servers.filter((s) => s.config.proxy.mode === "tunnel" && s.status.connection === "connected");
		if (tunnel.length === 0) return null;
		const active = tunnel.reduce((n, s) => n + (s.status.proxy?.active ?? 0), 0);
		return { text: `隧道代理 · ${active} 个连接`, to: paths.server(tunnel[0].config.id), on: true };
	}, [server, servers]);
	if (!info) return null;
	return (
		<Link to={info.to} className={BADGE} title="LLM 隧道代理">
			<Shield size={14} strokeWidth={1.8} className={info.on ? "text-accent" : "text-fg-3"} aria-hidden="true" />
			<span className="hidden sm:inline">{info.text}</span>
		</Link>
	);
}

function SyncBadge() {
	const { data } = useSyncStatus();
	const servers = useServers();
	const view = useMemo(() => {
		const statuses = data?.servers ?? [];
		if (statuses.some((s) => s.running)) return { kind: "running" as const, text: "同步中…" };
		const conflicts = statuses.filter((s) => Object.values(s.items).includes("conflict")).length;
		if (conflicts > 0) return { kind: "warn" as const, text: `${conflicts} 台服务器有冲突` };
		const pending = statuses.length
			? statuses.reduce((n, s) => n + s.pendingCount, 0)
			: servers.reduce((n, s) => n + (s.status.pendingSync ?? 0), 0);
		if (pending > 0) return { kind: "warn" as const, text: `${pending} 项待同步` };
		return { kind: "ok" as const, text: "配置已同步" };
	}, [data, servers]);
	return (
		<Link to={paths.sync()} className={BADGE} title="同步中心">
			{view.kind === "running" ? (
				<Spinner size={12} />
			) : view.kind === "warn" ? (
				<TriangleAlert size={14} strokeWidth={1.8} className="text-warning" aria-hidden="true" />
			) : (
				<RefreshCw size={14} strokeWidth={1.8} className="text-success" aria-hidden="true" />
			)}
			<span className="hidden sm:inline">{view.text}</span>
		</Link>
	);
}

function ConnectionBadge() {
	const status = useWsStatus();
	if (status.state === "open" || (status.state === "connecting" && status.generation === 0 && status.attempt === 0)) return null;
	return (
		<span role="status" className={cn(BADGE, "border-warning-border bg-warning-soft text-warning-fg hover:text-warning-fg")}>
			<WifiOff size={14} strokeWidth={1.8} aria-hidden="true" />
			<span className="hidden sm:inline">与 Pi-Web 的连接已断开，正在重连…</span>
		</span>
	);
}

/** 48px top bar: logo, breadcrumb, proxy/sync badges and the settings link (Main artboard). */
export function Header() {
	const location = useLocation();
	const route = useMemo(() => parseRoute(location.pathname), [location.pathname]);
	const crumbs = useBreadcrumb(route);
	const serverId = useRouteServerId(route);
	const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);

	return (
		<header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-3 sm:gap-4 sm:px-4">
			<IconButton aria-label="打开侧栏" className="md:hidden" onClick={() => setSidebarOpen(true)}>
				<MenuIcon size={18} strokeWidth={1.7} />
			</IconButton>
			<Link to={paths.home()} aria-label="Pi-Web 首页" className="flex shrink-0 items-center gap-2 text-[15px] font-bold tracking-[0.2px] text-fg hover:text-fg">
				<Logo />
				<span className="hidden sm:inline">Pi-Web</span>
			</Link>
			<nav aria-label="位置" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm text-fg-2">
				{crumbs.map((c, i) => {
					const last = i === crumbs.length - 1;
					return (
						<Fragment key={i}>
							{i > 0 && (
								<span aria-hidden="true" className="text-fg-4">
									/
								</span>
							)}
							{c.to && !last ? (
								<Link to={c.to} className="shrink-0 truncate text-fg-2 hover:text-fg">
									{c.label}
								</Link>
							) : (
								<span aria-current={last ? "page" : undefined} className={cn("truncate", last ? "text-fg" : "shrink-0")}>
									{c.label}
								</span>
							)}
						</Fragment>
					);
				})}
			</nav>
			<div className="flex shrink-0 items-center gap-2">
				<ConnectionBadge />
				<ProxyBadge serverId={serverId} />
				<SyncBadge />
				<Link
					to={paths.settings()}
					aria-label="全局设置"
					title="全局设置"
					className="flex size-8 items-center justify-center rounded-md text-fg-2 hover:bg-raised hover:text-fg"
				>
					<SlidersHorizontal size={18} strokeWidth={1.7} aria-hidden="true" />
				</Link>
			</div>
		</header>
	);
}
