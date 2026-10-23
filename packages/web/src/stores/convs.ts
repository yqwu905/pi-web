/**
 * Live conversations store: ConversationView list from GET /api/conversations, kept current
 * by the "convs" WS topic (one ConversationView per start/status change/exit).
 * Each event also invalidates that workspace's session list so the sidebar picks up new
 * sessions, names and message counts. `useConvsLiveSync()` is mounted once by the AppShell.
 */
import type { ConversationView } from "@pi-web/shared";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { errorMessage, listConversations } from "../api/client";
import { queryClient, queryKeys } from "../api/queryClient";
import { wsClient } from "../api/ws";
import { paths } from "../lib/routes";
import { noteConversationChange } from "./attention";

interface ConvsState {
	loaded: boolean;
	error: string | null;
	byId: Record<string, ConversationView>;
	setAll(list: ConversationView[]): void;
	upsert(view: ConversationView): void;
	remove(convId: string): void;
	setError(error: string | null): void;
}

export const useConvsStore = create<ConvsState>()((set) => ({
	loaded: false,
	error: null,
	byId: {},
	setAll: (list) => set({ byId: Object.fromEntries(list.map((c) => [c.convId, c])), loaded: true, error: null }),
	upsert: (view) => set((s) => ({ byId: { ...s.byId, [view.convId]: view } })),
	remove: (convId) =>
		set((s) => {
			if (!(convId in s.byId)) return s;
			const { [convId]: _removed, ...rest } = s.byId;
			return { byId: rest };
		}),
	setError: (error) => set({ error }),
}));

let inflight: Promise<void> | null = null;

export function refreshConversations(): Promise<void> {
	if (inflight) return inflight;
	inflight = listConversations()
		.then(({ conversations }) => useConvsStore.getState().setAll(conversations))
		.catch((error: unknown) => useConvsStore.getState().setError(errorMessage(error)))
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/** All known conversations (including exited ones still reported by the host). */
export function useConversations(): ConversationView[] {
	const byId = useConvsStore((s) => s.byId);
	return useMemo(() => Object.values(byId), [byId]);
}

/** Conversations with a live process (status !== "exited"), optionally for one workspace. */
export function useLiveConversations(workspaceId?: string): ConversationView[] {
	const byId = useConvsStore((s) => s.byId);
	return useMemo(
		() =>
			Object.values(byId).filter(
				(c) => c.info.status !== "exited" && (workspaceId === undefined || c.workspaceId === workspaceId),
			),
		[byId, workspaceId],
	);
}

export function useConversationView(convId: string | null | undefined): ConversationView | undefined {
	return useConvsStore((s) => (convId ? s.byId[convId] : undefined));
}

/** Initial load + "convs" topic + reload after WS reconnects. Mount once (AppShell). */
export function useConvsLiveSync(): void {
	useEffect(() => {
		void refreshConversations();
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		const invalidateSessions = (workspaceId: string) => {
			if (timers.has(workspaceId)) return;
			timers.set(
				workspaceId,
				setTimeout(() => {
					timers.delete(workspaceId);
					void queryClient.invalidateQueries({ queryKey: queryKeys.sessions(workspaceId) });
				}, 800),
			);
		};
		const offTopic = wsClient.subscribe<ConversationView>("convs", (view) => {
			if (!view || typeof view !== "object" || !view.convId) return;
			const prev = useConvsStore.getState().byId[view.convId];
			useConvsStore.getState().upsert(view);
			noteConversationChange(prev, view, (v) => (v.workspaceId && v.info.sessionId ? paths.chat(v.workspaceId, v.info.sessionId) : null));
			const changed =
				!prev ||
				prev.info.status !== view.info.status ||
				prev.info.sessionFile !== view.info.sessionFile ||
				prev.info.sessionName !== view.info.sessionName;
			if (changed && view.workspaceId) invalidateSessions(view.workspaceId);
		});
		const offOpen = wsClient.onOpen(({ reconnect }) => {
			if (reconnect) void refreshConversations();
		});
		return () => {
			offTopic();
			offOpen();
			for (const t of timers.values()) clearTimeout(t);
		};
	}, []);
}
