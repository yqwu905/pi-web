/**
 * Servers store: the ServerView list (GET /api/servers) kept live by the "servers" WS topic
 * (ServerRuntimeStatus per change). `useServersLiveSync()` is mounted once by the AppShell.
 *
 * After mutating servers through the REST client, either `upsertServer(view)` with the
 * returned ServerView or call `refreshServers()`.
 */
import type { ServerRuntimeStatus, ServerView } from "@pi-web/shared";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { errorMessage, listServers } from "../api/client";
import { wsClient } from "../api/ws";

interface ServersState {
	loaded: boolean;
	error: string | null;
	servers: ServerView[];
	setServers(servers: ServerView[]): void;
	upsertServer(view: ServerView): void;
	removeServer(serverId: string): void;
	/** Returns false when the server is unknown (caller should refresh the list). */
	applyStatus(status: ServerRuntimeStatus): boolean;
	setError(error: string | null): void;
}

export const useServersStore = create<ServersState>()((set, get) => ({
	loaded: false,
	error: null,
	servers: [],
	setServers: (servers) => set({ servers, loaded: true, error: null }),
	upsertServer: (view) =>
		set((s) => {
			const i = s.servers.findIndex((v) => v.config.id === view.config.id);
			if (i < 0) return { servers: [...s.servers, view] };
			const servers = s.servers.slice();
			servers[i] = view;
			return { servers };
		}),
	removeServer: (serverId) => set((s) => ({ servers: s.servers.filter((v) => v.config.id !== serverId) })),
	applyStatus: (status) => {
		const i = get().servers.findIndex((v) => v.config.id === status.serverId);
		if (i < 0) return false;
		set((s) => {
			const servers = s.servers.slice();
			servers[i] = { ...servers[i], status };
			return { servers };
		});
		return true;
	},
	setError: (error) => set({ error }),
}));

let inflight: Promise<void> | null = null;

/** Reloads the server list from the host (deduplicated while in flight). */
export function refreshServers(): Promise<void> {
	if (inflight) return inflight;
	inflight = listServers()
		.then(({ servers }) => useServersStore.getState().setServers(servers))
		.catch((error: unknown) => {
			useServersStore.getState().setError(errorMessage(error));
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/** Servers shown in the UI (jump-only hosts hidden unless requested). */
export function useServers(options: { includeJumpOnly?: boolean } = {}): ServerView[] {
	const servers = useServersStore((s) => s.servers);
	const includeJumpOnly = options.includeJumpOnly ?? false;
	return useMemo(() => (includeJumpOnly ? servers : servers.filter((v) => !v.config.jumpOnly)), [servers, includeJumpOnly]);
}

export function useServer(serverId: string | null | undefined): ServerView | undefined {
	return useServersStore((s) => (serverId ? s.servers.find((v) => v.config.id === serverId) : undefined));
}

export function getServer(serverId: string): ServerView | undefined {
	return useServersStore.getState().servers.find((v) => v.config.id === serverId);
}

/** Initial load + live status + reload after WS reconnects. Mount once (AppShell). */
export function useServersLiveSync(): void {
	useEffect(() => {
		void refreshServers();
		let refreshTimer: ReturnType<typeof setTimeout> | null = null;
		const offTopic = wsClient.subscribe<ServerRuntimeStatus>("servers", (status) => {
			if (!status || typeof status !== "object" || !("serverId" in status)) return;
			if (!useServersStore.getState().applyStatus(status) && !refreshTimer) {
				refreshTimer = setTimeout(() => {
					refreshTimer = null;
					void refreshServers();
				}, 300);
			}
		});
		const offOpen = wsClient.onOpen(({ reconnect }) => {
			if (reconnect) void refreshServers();
		});
		return () => {
			offTopic();
			offOpen();
			if (refreshTimer) clearTimeout(refreshTimer);
		};
	}, []);
}
