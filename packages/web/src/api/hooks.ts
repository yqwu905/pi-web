/**
 * React bindings for the API:
 * - WebSocket: useTopic(topic, handler), useWsStatus(), useWsReconnect(callback)
 * - TanStack Query reads: useMeta, useSettings, useServerWorkspaces, useAllWorkspaces,
 *   useWorkspace, useWorkspaceSessions, useSessionById, useSyncStatus, useGitStatus
 * - Invalidation helpers usable anywhere: invalidateWorkspaces, invalidateSessions, …
 *
 * Servers and live conversations are zustand stores (see ../stores/servers.ts, convs.ts),
 * not queries, because they are pushed over WS; `refreshServers()` / `refreshConversations()`
 * are their invalidation helpers.
 */
import type { SessionSummary, SyncStatusResponse, SyncTopicEvent, WorkspaceView, WsTopic } from "@pi-web/shared";
import { type UseQueryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { findSessionById, sortSessions } from "../lib/sessions";
import { refreshServers } from "../stores/servers";
import {
	getGitStatus,
	getMeta,
	getSettings,
	getSyncStatus,
	listServerWorkspaces,
	listSessions,
	listWorkspaces,
} from "./client";
import { queryClient, queryKeys } from "./queryClient";
import { type TopicHandler, type WsStatus, wsClient } from "./ws";

// ---------- WebSocket ----------

/** Ref that always holds the latest value (updated after render, before effects run). */
export function useLatest<T>(value: T): { readonly current: T } {
	const ref = useRef(value);
	useLayoutEffect(() => {
		ref.current = value;
	});
	return ref;
}

/**
 * Subscribes to a WS topic while mounted. `handler` may change every render (kept in a ref);
 * pass null/undefined as topic to pause. Data is typed by the caller:
 *   useTopic<ConvTopicEvent>(`conv:${convId}`, (ev) => …);
 */
export function useTopic<T = unknown>(topic: WsTopic | null | undefined, handler: TopicHandler<T>): void {
	const ref = useLatest(handler);
	useEffect(() => {
		if (!topic) return;
		return wsClient.subscribe<T>(topic, (data, t) => ref.current(data, t));
	}, [topic, ref]);
}

const subscribeStatus = (cb: () => void) => wsClient.onStatus(cb);
const getStatusSnapshot = () => wsClient.getStatus();

/** Current WS connection status (re-renders on change). */
export function useWsStatus(): WsStatus {
	return useSyncExternalStore(subscribeStatus, getStatusSnapshot, getStatusSnapshot);
}

/** Runs `callback` each time the WS connection comes back after a drop (not on first connect). */
export function useWsReconnect(callback: () => void): void {
	const ref = useLatest(callback);
	useEffect(
		() =>
			wsClient.onOpen(({ reconnect }) => {
				if (reconnect) ref.current();
			}),
		[ref],
	);
}

// ---------- queries ----------

type Opts<T> = Omit<UseQueryOptions<T, Error, T, readonly unknown[]>, "queryKey" | "queryFn">;

export function useMeta(options?: Opts<Awaited<ReturnType<typeof getMeta>>>) {
	return useQuery({ queryKey: queryKeys.meta, queryFn: ({ signal }) => getMeta(signal), staleTime: 60_000, ...options });
}

export function useSettings(options?: Opts<Awaited<ReturnType<typeof getSettings>>>) {
	return useQuery({ queryKey: queryKeys.settings, queryFn: () => getSettings(), ...options });
}

/** Workspaces of one server (sidebar tree). */
export function useServerWorkspaces(serverId: string | null | undefined, options?: Opts<WorkspaceView[]>) {
	return useQuery({
		queryKey: queryKeys.serverWorkspaces(serverId ?? ""),
		queryFn: async () => (await listServerWorkspaces(serverId as string)).workspaces,
		enabled: Boolean(serverId),
		...options,
	});
}

/** Every workspace on every server (breadcrumb, workspace → server lookup). */
export function useAllWorkspaces(options?: Opts<WorkspaceView[]>) {
	return useQuery({
		queryKey: queryKeys.workspaces,
		queryFn: async () => (await listWorkspaces()).workspaces,
		staleTime: 30_000,
		...options,
	});
}

/** One workspace by id (from the all-workspaces list). */
export function useWorkspace(workspaceId: string | null | undefined): {
	workspace: WorkspaceView | undefined;
	isLoading: boolean;
	error: Error | null;
} {
	const q = useAllWorkspaces();
	const workspace = useMemo(
		() => (workspaceId ? q.data?.find((w) => w.config.id === workspaceId) : undefined),
		[q.data, workspaceId],
	);
	return { workspace, isLoading: q.isLoading, error: q.error };
}

/** Sessions of a workspace, newest first. Refetched automatically on "convs" events. */
export function useWorkspaceSessions(workspaceId: string | null | undefined, options?: Opts<SessionSummary[]>) {
	return useQuery({
		queryKey: queryKeys.sessions(workspaceId ?? ""),
		queryFn: async ({ signal }) => sortSessions((await listSessions(workspaceId as string, signal)).sessions),
		enabled: Boolean(workspaceId),
		staleTime: 10_000,
		...options,
	});
}

/** Maps a chat route's session id to its SessionSummary. */
export function useSessionById(
	workspaceId: string | null | undefined,
	sessionId: string | null | undefined,
): { session: SessionSummary | undefined; isLoading: boolean; error: Error | null; refetch: () => void } {
	const q = useWorkspaceSessions(workspaceId);
	const session = useMemo(() => findSessionById(q.data, sessionId ?? undefined), [q.data, sessionId]);
	return { session, isLoading: q.isLoading, error: q.error, refetch: () => void q.refetch() };
}

/** Sync status, kept live by the "sync" topic (status snapshots and running flags). */
export function useSyncStatus(options?: Opts<SyncStatusResponse>) {
	const client = useQueryClient();
	useTopic<SyncTopicEvent>("sync", (ev) => {
		if (!ev || typeof ev !== "object") return;
		if (ev.kind === "status") {
			client.setQueryData(queryKeys.syncStatus, ev.status);
		} else if (ev.kind === "running") {
			client.setQueryData<SyncStatusResponse>(queryKeys.syncStatus, (prev) =>
				prev
					? { ...prev, servers: prev.servers.map((s) => (s.serverId === ev.serverId ? { ...s, running: ev.running } : s)) }
					: prev,
			);
			if (!ev.running) void client.invalidateQueries({ queryKey: queryKeys.syncStatus });
		} else if (ev.kind === "record") {
			void client.invalidateQueries({ queryKey: queryKeys.syncStatus });
			void client.invalidateQueries({ queryKey: queryKeys.syncHistory });
		}
	});
	return useQuery({ queryKey: queryKeys.syncStatus, queryFn: () => getSyncStatus(), staleTime: 30_000, ...options });
}

export function useGitStatus(workspaceId: string | null | undefined, options?: Opts<Awaited<ReturnType<typeof getGitStatus>>>) {
	return useQuery({
		queryKey: queryKeys.gitStatus(workspaceId ?? ""),
		queryFn: () => getGitStatus(workspaceId as string),
		enabled: Boolean(workspaceId),
		staleTime: 30_000,
		...options,
	});
}

// ---------- invalidation helpers ----------

export const invalidateMeta = () => queryClient.invalidateQueries({ queryKey: queryKeys.meta });
export const invalidateSettings = () => queryClient.invalidateQueries({ queryKey: queryKeys.settings });
/** Reload the servers store (and per-server queries such as workspaces). */
export const invalidateServers = async () => {
	await Promise.all([refreshServers(), queryClient.invalidateQueries({ queryKey: queryKeys.servers })]);
};
/** Workspace lists: all, plus one server's (or every server's when omitted). */
export const invalidateWorkspaces = (serverId?: string) =>
	Promise.all([
		queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
		serverId
			? queryClient.invalidateQueries({ queryKey: queryKeys.serverWorkspaces(serverId) })
			: queryClient.invalidateQueries({
					predicate: (q) => q.queryKey[0] === "servers" && q.queryKey[2] === "workspaces",
				}),
	]);
export const invalidateSessions = (workspaceId: string) => queryClient.invalidateQueries({ queryKey: queryKeys.sessions(workspaceId) });
export const invalidateGitStatus = (workspaceId: string) => queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(workspaceId) });
export const invalidateSync = () => queryClient.invalidateQueries({ queryKey: ["sync"] });
