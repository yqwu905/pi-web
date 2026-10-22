/**
 * Session helpers. The chat route param is the session id (the uuid in pi's session file
 * name `<timestamp>_<uuid>.jsonl`, equal to SessionSummary.id and ConvInfo.sessionId).
 */
import type { ConversationView, SessionSummary } from "@pi-web/shared";
import { truncate } from "./format";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Session id from a session file path ("…/2026-10-22T09-14-03-123Z_<uuid>.jsonl" → uuid). */
export function sessionIdFromFile(file: string): string {
	const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.jsonl$/i, "");
	const uuid = UUID_RE.exec(name);
	if (uuid) return uuid[0];
	const underscore = name.lastIndexOf("_");
	return underscore >= 0 ? name.slice(underscore + 1) : name;
}

/** Route param → summary (matches by id, falling back to the id parsed from the file name). */
export function findSessionById(sessions: readonly SessionSummary[] | undefined, sessionId: string | undefined): SessionSummary | undefined {
	if (!sessions || !sessionId) return undefined;
	return sessions.find((s) => s.id === sessionId) ?? sessions.find((s) => sessionIdFromFile(s.file) === sessionId);
}

/** Summary → route param. */
export function sessionRouteId(session: Pick<SessionSummary, "id" | "file">): string {
	return session.id || sessionIdFromFile(session.file);
}

/** Display title: session name, else the first user message, else "新对话". */
export function sessionTitle(session: Pick<SessionSummary, "name" | "firstMessage"> | undefined, max = 60): string {
	if (!session) return "新对话";
	const name = session.name?.trim();
	if (name) return truncate(name, max);
	const first = session.firstMessage?.trim();
	if (first) return truncate(first, max);
	return "新对话";
}

/** Case-insensitive search over name and first message. Empty query matches everything. */
export function matchesSessionQuery(session: Pick<SessionSummary, "name" | "firstMessage">, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return (session.name ?? "").toLowerCase().includes(q) || (session.firstMessage ?? "").toLowerCase().includes(q);
}

/** Newest first. */
export function sortSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
	return [...sessions].sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/** Live conversation (not exited) serving a session, matched by convId, session file or session id. */
export function liveConversationForSession(
	session: Pick<SessionSummary, "id" | "file" | "runningConvId">,
	conversations: readonly ConversationView[],
): ConversationView | undefined {
	const live = conversations.filter((c) => c.info.status !== "exited");
	return (
		(session.runningConvId ? live.find((c) => c.convId === session.runningConvId) : undefined) ??
		live.find((c) => c.info.sessionFile === session.file) ??
		live.find((c) => c.info.sessionId === session.id)
	);
}

/**
 * Live conversations of a workspace whose session is not (yet) in the listed sessions,
 * e.g. a new conversation before pi has written its session file.
 */
export function unlistedConversations(
	workspaceId: string,
	sessions: readonly SessionSummary[],
	conversations: readonly ConversationView[],
): ConversationView[] {
	const files = new Set(sessions.map((s) => s.file));
	const ids = new Set(sessions.map((s) => s.id));
	const convIds = new Set(sessions.map((s) => s.runningConvId).filter(Boolean));
	return conversations.filter(
		(c) =>
			c.workspaceId === workspaceId &&
			c.info.status !== "exited" &&
			!convIds.has(c.convId) &&
			!(c.info.sessionFile && files.has(c.info.sessionFile)) &&
			!(c.info.sessionId && ids.has(c.info.sessionId)),
	);
}
