/**
 * Persisted UI preferences (localStorage): sidebar tree expansion and the last opened
 * session per workspace. The mobile sidebar drawer state is not persisted.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface UiState {
	/** Server rows default to expanded; workspace rows default to collapsed. */
	expandedServers: Record<string, boolean>;
	expandedWorkspaces: Record<string, boolean>;
	/** Last session id opened per workspace (chat tab link target). */
	lastSession: Record<string, string>;
	/** Last opened conversation, for the home redirect. */
	lastVisited: { workspaceId: string; sessionId: string } | null;
	sidebarOpen: boolean;
	setServerExpanded(serverId: string, expanded: boolean): void;
	setWorkspaceExpanded(workspaceId: string, expanded: boolean): void;
	rememberSession(workspaceId: string, sessionId: string): void;
	forgetSession(workspaceId: string, sessionId: string): void;
	setSidebarOpen(open: boolean): void;
}

export const useUiStore = create<UiState>()(
	persist(
		(set) => ({
			expandedServers: {},
			expandedWorkspaces: {},
			lastSession: {},
			lastVisited: null,
			sidebarOpen: false,
			setServerExpanded: (serverId, expanded) => set((s) => ({ expandedServers: { ...s.expandedServers, [serverId]: expanded } })),
			setWorkspaceExpanded: (workspaceId, expanded) =>
				set((s) => ({ expandedWorkspaces: { ...s.expandedWorkspaces, [workspaceId]: expanded } })),
			rememberSession: (workspaceId, sessionId) =>
				set((s) =>
					s.lastSession[workspaceId] === sessionId && s.lastVisited?.sessionId === sessionId
						? s
						: { lastSession: { ...s.lastSession, [workspaceId]: sessionId }, lastVisited: { workspaceId, sessionId } },
				),
			forgetSession: (workspaceId, sessionId) =>
				set((s) => {
					const lastSession = { ...s.lastSession };
					if (lastSession[workspaceId] === sessionId) delete lastSession[workspaceId];
					const lastVisited = s.lastVisited?.sessionId === sessionId ? null : s.lastVisited;
					return { lastSession, lastVisited };
				}),
			setSidebarOpen: (open) => set({ sidebarOpen: open }),
		}),
		{
			name: "pi-web:ui",
			version: 1,
			storage: createJSONStorage(() => localStorage),
			partialize: (s) => ({
				expandedServers: s.expandedServers,
				expandedWorkspaces: s.expandedWorkspaces,
				lastSession: s.lastSession,
				lastVisited: s.lastVisited,
			}),
		},
	),
);
