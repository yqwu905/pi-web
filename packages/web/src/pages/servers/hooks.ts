/**
 * Data hooks of the server, sync and settings pages: deploy job (REST + `deploy:<id>` topic),
 * agent status, proxy stats (REST + `proxy:<id>` topic), OAuth status (REST + `oauth` topic),
 * sync history (REST + `sync` record events) and the host inventory.
 */
import type {
	AgentStatus,
	DeployProgress,
	OAuthStatusResponse,
	ProxyStats,
	ServerView,
	SyncRecord,
	SyncTopicEvent,
} from "@pi-web/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef } from "react";
import {
	getAgentLogs,
	getAgentStatus,
	getDeployJob,
	getOAuthStatus,
	getProxyStats,
	getSshConfig,
	getSyncHistory,
	getSyncInventory,
	getServer,
} from "../../api/client";
import { invalidateServers, useTopic, useWsReconnect } from "../../api/hooks";
import { queryKeys } from "../../api/queryClient";
import { useServer, useServersStore } from "../../stores/servers";
import { mergeRecord } from "../sync/lib/plan";

export const serverQueryKeys = {
	deployJob: (serverId: string) => ["servers", serverId, "deploy"] as const,
	proxy: (serverId: string) => ["servers", serverId, "proxy"] as const,
	logs: (serverId: string, tail: number) => ["servers", serverId, "logs", tail] as const,
	syncPreview: (serverId: string) => ["sync", "preview", serverId] as const,
};

/** True when the server's agent link is usable (connected and deployed). */
export function agentAvailable(view: ServerView | undefined): boolean {
	if (!view) return false;
	const s = view.status;
	return s.connection === "connected" && (s.deployState === "deployed" || s.deployState === "outdated" || Boolean(s.agent));
}

/**
 * One server from the live store; when the store has loaded but does not know the id,
 * falls back to GET /servers/:id (e.g. a server created moments ago).
 */
export function useServerView(serverId: string | null | undefined): { view: ServerView | undefined; loading: boolean; notFound: boolean } {
	const fromStore = useServer(serverId);
	const loaded = useServersStore((s) => s.loaded);
	const q = useQuery({
		queryKey: queryKeys.server(serverId ?? ""),
		queryFn: async () => {
			const view = await getServer(serverId as string);
			useServersStore.getState().upsertServer(view);
			return view;
		},
		enabled: Boolean(serverId) && loaded && !fromStore,
		retry: false,
	});
	const view = fromStore ?? q.data;
	return {
		view,
		loading: Boolean(serverId) && !view && (!loaded || q.isLoading),
		notFound: Boolean(serverId) && !view && loaded && q.isError,
	};
}

/** Current deploy job of a server, kept live by the `deploy:<id>` topic. */
export function useDeployJob(serverId: string | null | undefined) {
	const client = useQueryClient();
	const key = serverQueryKeys.deployJob(serverId ?? "");
	const lastState = useRef<DeployProgress["state"] | null>(null);
	useTopic<DeployProgress>(serverId ? `deploy:${serverId}` : null, (job) => {
		if (!job || typeof job !== "object" || job.serverId !== serverId) return;
		client.setQueryData<DeployProgress | null>(key, job);
	});
	useWsReconnect(() => {
		if (serverId) void client.invalidateQueries({ queryKey: key });
	});
	const q = useQuery({
		queryKey: key,
		queryFn: async () => (await getDeployJob(serverId as string)).job,
		enabled: Boolean(serverId),
		staleTime: 5_000,
	});
	const state = q.data?.state ?? null;
	useEffect(() => {
		// A job that just finished changed the server config (deployed info, status).
		if (lastState.current === "running" && state && state !== "running") void invalidateServers();
		lastState.current = state;
	}, [state]);
	return q;
}

export function useAgentStatus(view: ServerView | undefined, options: { refetchInterval?: number } = {}) {
	const serverId = view?.config.id ?? "";
	return useQuery<AgentStatus>({
		queryKey: queryKeys.agentStatus(serverId),
		queryFn: () => getAgentStatus(serverId),
		enabled: agentAvailable(view),
		refetchInterval: options.refetchInterval ?? 15_000,
		staleTime: 5_000,
	});
}

/** Proxy statistics from REST, then live from the `proxy:<id>` topic. */
export function useProxyStats(view: ServerView | undefined) {
	const client = useQueryClient();
	const serverId = view?.config.id ?? "";
	const enabled = Boolean(view) && view?.config.proxy.mode === "tunnel";
	useTopic<ProxyStats>(enabled ? `proxy:${serverId}` : null, (stats) => {
		if (!stats || typeof stats !== "object" || !Array.isArray(stats.byHost)) return;
		client.setQueryData(serverQueryKeys.proxy(serverId), stats);
	});
	return useQuery({
		queryKey: serverQueryKeys.proxy(serverId),
		queryFn: () => getProxyStats(serverId),
		enabled,
		staleTime: 30_000,
	});
}

export function useAgentLogs(view: ServerView | undefined, tail: number, options: { enabled?: boolean } = {}) {
	const serverId = view?.config.id ?? "";
	return useQuery({
		queryKey: serverQueryKeys.logs(serverId, tail),
		queryFn: async () => (await getAgentLogs(serverId, tail)).lines,
		enabled: agentAvailable(view) && (options.enabled ?? true),
		staleTime: 10_000,
	});
}

/** OAuth keeper status from REST, then live from the `oauth` topic. */
export function useOAuthStatus() {
	const client = useQueryClient();
	useTopic<OAuthStatusResponse>("oauth", (data) => {
		if (!data || typeof data !== "object" || !Array.isArray(data.providers)) return;
		client.setQueryData(queryKeys.oauth, data);
	});
	// Events published while the socket was down are lost.
	useWsReconnect(() => void client.invalidateQueries({ queryKey: queryKeys.oauth }));
	return useQuery({ queryKey: queryKeys.oauth, queryFn: () => getOAuthStatus(), staleTime: 30_000 });
}

/** Sync history (newest first); pushed records are merged in without a refetch. */
export function useSyncHistory(limit = 50) {
	const client = useQueryClient();
	useTopic<SyncTopicEvent>("sync", (ev) => {
		if (!ev || typeof ev !== "object" || ev.kind !== "record") return;
		client.setQueryData<SyncRecord[]>([...queryKeys.syncHistory, limit], (prev) => (prev ? mergeRecord(prev, ev.record, limit) : prev));
	});
	useWsReconnect(() => void client.invalidateQueries({ queryKey: queryKeys.syncHistory }));
	return useQuery({
		queryKey: [...queryKeys.syncHistory, limit],
		queryFn: async () => (await getSyncHistory(limit)).records,
		staleTime: 30_000,
	});
}

export function useSyncInventory() {
	return useQuery({ queryKey: queryKeys.syncInventory, queryFn: () => getSyncInventory(), staleTime: 60_000 });
}

export function useSshConfigHosts(enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.sshConfig,
		queryFn: async () => (await getSshConfig()).hosts,
		enabled,
		staleTime: 60_000,
	});
}

/** Re-renders every `intervalMs` (countdowns, elapsed time) and returns the current time. */
export function useNow(intervalMs: number, active = true): number {
	const [, force] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (!active) return;
		const t = setInterval(force, intervalMs);
		return () => clearInterval(t);
	}, [intervalMs, active]);
	return Date.now();
}
