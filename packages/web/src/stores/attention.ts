/**
 * Conversations that need the user's attention (DESIGN §4.3): an "未读" marker in the session
 * list when a conversation the user is not looking at finishes a run or starts waiting for a
 * dialog answer, and a browser notification for the same events while the tab is hidden or
 * another conversation is open.
 */
import type { ConversationView } from "@pi-web/shared";
import { create } from "zustand";

/** Why a conversation is unread, and where it runs (the sidebar's 进行中 filter lists unread sessions too). */
export interface UnreadMark {
	reason: "done" | "waiting";
	serverId: string;
	workspaceId: string | null;
}

interface AttentionState {
	/** Keyed by session id (falls back to the conversation id before the session has one). */
	unread: Record<string, UnreadMark>;
	mark(key: string, mark: UnreadMark): void;
	clear(key: string): void;
}

export const useAttentionStore = create<AttentionState>()((set) => ({
	unread: {},
	mark: (key, mark) =>
		set((s) => {
			const prev = s.unread[key];
			if (prev && prev.reason === mark.reason && prev.serverId === mark.serverId && prev.workspaceId === mark.workspaceId) return s;
			return { unread: { ...s.unread, [key]: mark } };
		}),
	clear: (key) =>
		set((s) => {
			if (!(key in s.unread)) return s;
			const { [key]: _cleared, ...rest } = s.unread;
			return { unread: rest };
		}),
}));

export function attentionKey(view: Pick<ConversationView, "convId" | "info">): string {
	return view.info.sessionId ?? view.convId;
}

/** The conversation the chat page currently shows (null: none). */
let viewing: { convId: string; key: string } | null = null;
let navigateTo: ((path: string) => void) | null = null;

function isVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** Called by the chat page while it shows a conversation; returns the cleanup. */
export function setViewing(convId: string, key: string): () => void {
	viewing = { convId, key };
	if (isVisible()) useAttentionStore.getState().clear(key);
	return () => {
		if (viewing?.convId === convId) viewing = null;
	};
}

/** Lets a notification click open its conversation (registered by the app shell). */
export function setAttentionNavigator(fn: ((path: string) => void) | null): void {
	navigateTo = fn;
}

if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (isVisible() && viewing) useAttentionStore.getState().clear(viewing.key);
	});
}

/** Asks for notification permission (call from a user gesture, e.g. sending a message). */
export function requestNotificationPermission(): void {
	if (typeof Notification === "undefined" || Notification.permission !== "default") return;
	try {
		void Notification.requestPermission().catch(() => undefined);
	} catch {
		// old Safari: callback form only; not worth supporting
	}
}

const RUNNING = new Set(["running", "starting"]);

/**
 * A conversation's status changed ("convs" topic): a finished run (running → idle) or a new
 * dialog (→ waiting_ui) of a conversation the user is not looking at is marked unread and,
 * when allowed, announced with a browser notification.
 */
export function noteConversationChange(prev: ConversationView | undefined, next: ConversationView, chatPath: (view: ConversationView) => string | null): void {
	if (!prev) return;
	const before = prev.info.status;
	const after = next.info.status;
	let reason: "done" | "waiting" | null = null;
	if (after === "waiting_ui" && before !== "waiting_ui") reason = "waiting";
	else if (after === "idle" && RUNNING.has(before)) reason = "done";
	if (!reason) return;
	const key = attentionKey(next);
	const watched = viewing?.convId === next.convId && isVisible();
	if (watched) return;
	useAttentionStore.getState().mark(key, { reason, serverId: next.serverId, workspaceId: next.workspaceId });
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	const title = next.info.sessionName || "对话";
	try {
		const notification = new Notification(reason === "waiting" ? "pi 需要你的确认" : "pi 运行结束", {
			body: title,
			tag: `pi-web:${next.convId}`,
		});
		notification.onclick = () => {
			window.focus();
			const path = chatPath(next);
			if (path && navigateTo) navigateTo(path);
			notification.close();
		};
	} catch {
		// Notification constructor unavailable (e.g. some mobile browsers)
	}
}
