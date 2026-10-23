/**
 * Archiving sessions. Archiving only hides a session in Pi-Web: the host keeps the mark and the
 * session file on the server is untouched, so it also works while the server is offline.
 * A change updates the cached session lists of the server's workspaces at once (offline lists are
 * not refetched), then refetches them and the workspace counts; the "sessions" topic applies
 * changes made in other tabs the same way. `useSessionsLiveSync()` is mounted once by the AppShell.
 */
import type { SessionSummary, SessionsTopicEvent, WorkspaceView } from "@pi-web/shared";
import { useEffect } from "react";
import { sessionIdFromFile, sessionRouteId } from "../lib/sessions";
import { useUiStore } from "../stores/ui";
import { archiveSession, unarchiveSession } from "./client";
import { invalidateWorkspaces } from "./hooks";
import { queryClient } from "./queryClient";
import { wsClient } from "./ws";

/** queryKeys.sessions(workspaceId) */
const isSessionListKey = (key: readonly unknown[]) => key.length === 3 && key[0] === "workspaces" && key[2] === "sessions";
/** queryKeys.workspaces and queryKeys.serverWorkspaces(serverId) */
const isWorkspaceListKey = (key: readonly unknown[]) =>
	(key.length === 1 && key[0] === "workspaces") || (key.length === 3 && key[0] === "servers" && key[2] === "workspaces");
const refetchSessionLists = () => queryClient.invalidateQueries({ predicate: (q) => isSessionListKey(q.queryKey) });

/** Server id of each workspace in the cached workspace lists. */
function cachedWorkspaceServers(): Map<string, string> {
	const servers = new Map<string, string>();
	for (const [, list] of queryClient.getQueriesData<WorkspaceView[]>({ predicate: (q) => isWorkspaceListKey(q.queryKey) })) {
		for (const w of list ?? []) servers.set(w.config.id, w.config.serverId);
	}
	return servers;
}

/** Applies an archive change to the cached session lists, then refetches them and the workspace counts. */
export function applyArchiveChange(ev: SessionsTopicEvent): void {
	const refetch = () => {
		void refetchSessionLists();
		void invalidateWorkspaces(ev.serverId);
	};
	// A deleted session leaves the lists with the refetch; it must not show as restored meanwhile.
	if (ev.deleted) return refetch();
	// Only that server's workspaces: the same path can exist on another server entry (one machine
	// added twice). A workspace missing from the cached workspace lists counts as that server's.
	const servers = cachedWorkspaceServers();
	const onServer = (workspaceId: string) => (servers.get(workspaceId) ?? ev.serverId) === ev.serverId;
	const ids = new Set([sessionIdFromFile(ev.file)]);
	const lists = queryClient.getQueriesData<SessionSummary[]>({
		predicate: (q) => isSessionListKey(q.queryKey) && onServer(String(q.queryKey[1])),
	});
	for (const [key, sessions] of lists) {
		if (!sessions?.some((s) => s.file === ev.file)) continue;
		const next = sessions.map((s): SessionSummary => {
			if (s.file !== ev.file) return s;
			ids.add(sessionRouteId(s));
			if (ev.archivedAt !== null) return { ...s, archivedAt: ev.archivedAt };
			const { archivedAt: _archivedAt, ...rest } = s;
			return rest;
		});
		queryClient.setQueryData(key, next);
	}
	// An archived session is no longer where the 对话 tab, "/" or the Files/Git links lead.
	if (ev.archivedAt !== null) for (const id of ids) useUiStore.getState().forgetSessionWhere(id, onServer);
	refetch();
}

/** Archives or restores a session. Throws the client's ApiError (e.g. 409 BUSY while it runs). */
export async function setSessionArchived(serverId: string, file: string, archived: boolean): Promise<void> {
	if (archived) {
		const res = await archiveSession(serverId, file);
		applyArchiveChange({ serverId, file, archivedAt: res.archivedAt ?? Date.now() });
	} else {
		await unarchiveSession(serverId, file);
		applyArchiveChange({ serverId, file, archivedAt: null });
	}
}

/** "sessions" topic (changes from other tabs) + refetch after a WS reconnect (events may be lost). Mount once. */
export function useSessionsLiveSync(): void {
	useEffect(() => {
		const offTopic = wsClient.subscribe<SessionsTopicEvent>("sessions", (ev) => {
			if (!ev || typeof ev !== "object" || typeof ev.serverId !== "string" || typeof ev.file !== "string") return;
			if (ev.archivedAt !== null && typeof ev.archivedAt !== "number") return;
			applyArchiveChange(ev);
		});
		const offOpen = wsClient.onOpen(({ reconnect }) => {
			if (reconnect) void refetchSessionLists();
		});
		return () => {
			offTopic();
			offOpen();
		};
	}, []);
}
