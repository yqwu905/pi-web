import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";

/** App-wide TanStack Query client (also used by stores and invalidation helpers outside React). */
export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 15_000,
			refetchOnWindowFocus: false,
			retry: (failureCount, error) => {
				// Client errors (4xx) are not worth retrying; network/5xx get one retry.
				if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
				return failureCount < 1;
			},
		},
		mutations: {
			retry: false,
		},
	},
});

/** Query keys. Use these (not ad-hoc arrays) so invalidation helpers keep working. */
export const queryKeys = {
	meta: ["meta"] as const,
	settings: ["settings"] as const,
	sshConfig: ["ssh-config"] as const,
	servers: ["servers"] as const,
	server: (serverId: string) => ["servers", serverId] as const,
	serverWorkspaces: (serverId: string) => ["servers", serverId, "workspaces"] as const,
	agentStatus: (serverId: string) => ["servers", serverId, "agent-status"] as const,
	workspaces: ["workspaces"] as const,
	sessions: (workspaceId: string) => ["workspaces", workspaceId, "sessions"] as const,
	gitStatus: (workspaceId: string) => ["workspaces", workspaceId, "git", "status"] as const,
	/** Prefixes of a workspace's git views (status, diff, log) and file browser queries. */
	workspaceGit: (workspaceId: string) => ["workspaces", workspaceId, "git"] as const,
	workspaceFs: (workspaceId: string) => ["workspaces", workspaceId, "fs"] as const,
	sessionFile: (serverId: string, file: string) => ["session-file", serverId, file] as const,
	conversations: ["conversations"] as const,
	syncStatus: ["sync", "status"] as const,
	syncInventory: ["sync", "inventory"] as const,
	syncHistory: ["sync", "history"] as const,
	oauth: ["oauth"] as const,
	cache: ["cache"] as const,
};
