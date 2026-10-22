import { QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { queryClient } from "./api/queryClient";
import { LoadingBlock } from "./components/ui/Spinner";
import { AppShell } from "./layout/AppShell";
import { WorkspaceLayout } from "./layout/WorkspaceLayout";
import RouteErrorPage from "./pages/RouteErrorPage";

/** Lazy route module: page files default-export their component. */
const page = (load: () => Promise<{ default: ComponentType }>) => async () => ({ Component: (await load()).default });

/**
 * Route table (keep lib/routes.ts `paths`/`parseRoute` in sync):
 *   /                              HomePage (redirect to the last/most recent conversation)
 *   /servers/new                   AddServerPage
 *   /servers/:serverId             ServerDetailPage
 *   /servers/:serverId/settings    ServerSettingsPage
 *   /w/:workspaceId/chat/:sessionId?  ChatPage (no sessionId = new conversation)
 *   /w/:workspaceId/files          FilesPage (?path=)
 *   /w/:workspaceId/terminal       TerminalPage
 *   /w/:workspaceId/git            GitPage
 *   /sync                          SyncCenterPage
 *   /settings                      SettingsPage
 *   /dev/ui                        UiGalleryPage (component style guide, not linked)
 */
export const router = createBrowserRouter([
	{
		path: "/",
		Component: AppShell,
		ErrorBoundary: RouteErrorPage,
		HydrateFallback: () => <LoadingBlock className="h-dvh" />,
		children: [
			{
				ErrorBoundary: RouteErrorPage,
				children: [
					{ index: true, lazy: page(() => import("./pages/HomePage")) },
					{ path: "servers/new", lazy: page(() => import("./pages/servers/AddServerPage")) },
					{ path: "servers/:serverId", lazy: page(() => import("./pages/servers/ServerDetailPage")) },
					{ path: "servers/:serverId/settings", lazy: page(() => import("./pages/servers/ServerSettingsPage")) },
					{
						path: "w/:workspaceId",
						Component: WorkspaceLayout,
						children: [
							{ index: true, element: <Navigate to="chat" replace /> },
							{ path: "chat/:sessionId?", lazy: page(() => import("./pages/chat/ChatPage")) },
							{ path: "files", lazy: page(() => import("./pages/workspace/FilesPage")) },
							{ path: "terminal", lazy: page(() => import("./pages/workspace/TerminalPage")) },
							{ path: "git", lazy: page(() => import("./pages/workspace/GitPage")) },
						],
					},
					{ path: "sync", lazy: page(() => import("./pages/sync/SyncCenterPage")) },
					{ path: "settings", lazy: page(() => import("./pages/settings/SettingsPage")) },
					{ path: "dev/ui", lazy: page(() => import("./pages/dev/UiGalleryPage")) },
					{ path: "*", lazy: page(() => import("./pages/NotFoundPage")) },
				],
			},
		],
	},
]);

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
}
