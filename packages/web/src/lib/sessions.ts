/**
 * Session helpers. The chat route param is the session id (the uuid in pi's session file
 * name `<timestamp>_<uuid>.jsonl`, equal to SessionSummary.id and ConvInfo.sessionId).
 */
import type { ConversationView, ConvStatus, SessionSummary } from "@pi-web/shared";
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

// ---------- archived sessions (hidden in Pi-Web; the host sets SessionSummary.archivedAt) ----------

export function isArchived(session: Pick<SessionSummary, "archivedAt"> | undefined): boolean {
	return session?.archivedAt !== undefined;
}

/** Splits a session list into active sessions (order kept) and archived ones (most recently archived first). */
export function splitArchived(sessions: readonly SessionSummary[]): { active: SessionSummary[]; archived: SessionSummary[] } {
	const active: SessionSummary[] = [];
	const archived: SessionSummary[] = [];
	for (const s of sessions) (isArchived(s) ? archived : active).push(s);
	archived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
	return { active, archived };
}

/**
 * A workspace's sessions in the sidebar for a search query: the matching active and archived
 * sessions, and the number shown next to the workspace (active sessions only, ignoring the query).
 */
export function sidebarSessionGroups(
	sessions: readonly SessionSummary[],
	query: string,
): { active: SessionSummary[]; archived: SessionSummary[]; count: number } {
	const { active, archived } = splitArchived(sessions);
	return {
		active: active.filter((s) => matchesSessionQuery(s, query)),
		archived: archived.filter((s) => matchesSessionQuery(s, query)),
		count: active.length,
	};
}

/** Why a session cannot be archived now (its live conversation is running or waits for a dialog), else null. */
export function archiveBlockedReason(status: ConvStatus | undefined): string | null {
	if (status === "running" || status === "starting") return "会话正在运行，结束后才能归档";
	if (status === "waiting_ui") return "会话正在等待确认，结束后才能归档";
	return null;
}

/**
 * Whether the open chat session may be remembered (the 对话 tab, "/" and the Files/Git links lead
 * back to it): never an archived one, so not before the workspace's session list has answered.
 * A failed list or a session it does not contain yet (just started) is remembered.
 */
export function canRememberSession(
	sessionId: string | undefined,
	list: { isPending: boolean; data?: readonly SessionSummary[] },
): sessionId is string {
	return Boolean(sessionId) && !list.isPending && !isArchived(findSessionById(list.data, sessionId));
}

export interface ResumeTarget {
	workspaceId: string;
	sessionId: string;
}

/**
 * Where "/" continues: the last visited session (if its workspace still exists), else the most
 * recently active live conversation. Sessions known to be archived are skipped; a workspace
 * missing from `sessionsByWorkspace` has an unknown list and counts as having none archived.
 */
export function pickResumeTarget(
	lastVisited: ResumeTarget | null,
	workspaceIds: ReadonlySet<string>,
	live: readonly ConversationView[],
	sessionsByWorkspace: Readonly<Record<string, readonly SessionSummary[] | undefined>>,
): ResumeTarget | undefined {
	if (lastVisited && workspaceIds.has(lastVisited.workspaceId)) {
		const session = findSessionById(sessionsByWorkspace[lastVisited.workspaceId], lastVisited.sessionId);
		if (!isArchived(session)) return lastVisited;
	}
	const candidates = live
		.filter((c) => c.workspaceId && c.info.sessionId)
		.sort((a, b) => b.info.lastActivityAt - a.info.lastActivityAt);
	for (const c of candidates) {
		const sessions = sessionsByWorkspace[c.workspaceId as string] ?? [];
		const session = sessions.find((s) => (c.info.sessionFile && s.file === c.info.sessionFile) || s.id === c.info.sessionId);
		if (!isArchived(session)) return { workspaceId: c.workspaceId as string, sessionId: c.info.sessionId as string };
	}
	return undefined;
}
