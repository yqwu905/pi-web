/**
 * URL builders and a pure route parser shared by the layout (breadcrumb, sidebar
 * highlighting) and pages. Keep in sync with the route table in App.tsx.
 */

export type WorkspaceTab = "chat" | "files" | "terminal" | "git";

export const paths = {
	home: () => "/",
	/** With `serverId`, resumes the add-server wizard for a server created earlier. */
	addServer: (serverId?: string) => (serverId ? `/servers/new?server=${encodeURIComponent(serverId)}` : "/servers/new"),
	server: (serverId: string) => `/servers/${encodeURIComponent(serverId)}`,
	serverSettings: (serverId: string) => `/servers/${encodeURIComponent(serverId)}/settings`,
	workspace: (workspaceId: string, tab: WorkspaceTab = "chat") => `/w/${encodeURIComponent(workspaceId)}/${tab}`,
	/** New conversation when `sessionId` is omitted. */
	chat: (workspaceId: string, sessionId?: string) =>
		sessionId
			? `/w/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(sessionId)}`
			: `/w/${encodeURIComponent(workspaceId)}/chat`,
	files: (workspaceId: string, filePath?: string) =>
		`/w/${encodeURIComponent(workspaceId)}/files${filePath ? `?path=${encodeURIComponent(filePath)}` : ""}`,
	terminal: (workspaceId: string) => `/w/${encodeURIComponent(workspaceId)}/terminal`,
	git: (workspaceId: string) => `/w/${encodeURIComponent(workspaceId)}/git`,
	sync: () => "/sync",
	settings: () => "/settings",
};

export type RouteInfo =
	| { kind: "home" }
	| { kind: "addServer" }
	| { kind: "server"; serverId: string }
	| { kind: "serverSettings"; serverId: string }
	| { kind: "workspace"; workspaceId: string; tab: WorkspaceTab; sessionId?: string }
	| { kind: "sync" }
	| { kind: "settings" }
	| { kind: "unknown" };

const TABS: readonly WorkspaceTab[] = ["chat", "files", "terminal", "git"];

function decode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/** Classifies a pathname ("/w/ws1/chat/abc") into the app's route kinds. */
export function parseRoute(pathname: string): RouteInfo {
	const parts = pathname.split("/").filter(Boolean).map(decode);
	if (parts.length === 0) return { kind: "home" };
	const [first, second, third, fourth] = parts;
	if (first === "servers") {
		if (second === "new" && parts.length === 2) return { kind: "addServer" };
		if (second && parts.length === 2) return { kind: "server", serverId: second };
		if (second && third === "settings" && parts.length === 3) return { kind: "serverSettings", serverId: second };
		return { kind: "unknown" };
	}
	if (first === "w" && second) {
		if (!third) return { kind: "workspace", workspaceId: second, tab: "chat" };
		if (!(TABS as readonly string[]).includes(third)) return { kind: "unknown" };
		const tab = third as WorkspaceTab;
		if (tab === "chat" && fourth) return { kind: "workspace", workspaceId: second, tab, sessionId: fourth };
		if (parts.length > 3) return { kind: "unknown" };
		return { kind: "workspace", workspaceId: second, tab };
	}
	if (first === "sync" && parts.length === 1) return { kind: "sync" };
	if (first === "settings" && parts.length === 1) return { kind: "settings" };
	return { kind: "unknown" };
}

export const WORKSPACE_TAB_LABELS: Record<WorkspaceTab, string> = {
	chat: "对话",
	files: "文件",
	terminal: "终端",
	git: "Git",
};
