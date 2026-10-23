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
	/** Drops a session from the remembered slots of the workspaces `inWorkspace` accepts (e.g. it was archived on their server). */
	forgetSessionWhere(sessionId: string, inWorkspace: (workspaceId: string) => boolean): void;
	/** Drops every remembered session of these workspaces (workspace or server removed). */
	forgetWorkspaces(workspaceIds: readonly string[]): void;
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
			forgetSessionWhere: (sessionId, inWorkspace) =>
				set((s) => {
					const matches = (workspaceId: string, id: string) => id === sessionId && inWorkspace(workspaceId);
					const visited = s.lastVisited !== null && matches(s.lastVisited.workspaceId, s.lastVisited.sessionId);
					if (!visited && !Object.entries(s.lastSession).some(([ws, id]) => matches(ws, id))) return s;
					const lastSession = Object.fromEntries(Object.entries(s.lastSession).filter(([ws, id]) => !matches(ws, id)));
					return { lastSession, lastVisited: visited ? null : s.lastVisited };
				}),
			forgetWorkspaces: (workspaceIds) =>
				set((s) => {
					const ids = new Set(workspaceIds);
					const lastSession = Object.fromEntries(Object.entries(s.lastSession).filter(([ws]) => !ids.has(ws)));
					const lastVisited = s.lastVisited && ids.has(s.lastVisited.workspaceId) ? null : s.lastVisited;
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
