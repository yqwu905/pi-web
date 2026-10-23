/**
 * Archived sessions: a host-only "hidden in Pi-Web" mark per (server, absolute session file path).
 * The session file on the server is never moved or changed, so archiving needs no agent call and
 * works while the server is offline. Records live in the store's keyed state as `archived:<serverId>`.
 */
import { posix as posixPath } from "node:path";
import type { SessionSummary } from "@pi-web/shared";
import type { Store } from "./types.js";

export interface ArchivedRecord {
	archivedAt: number;
	/**
	 * Path of the workspace whose session list last contained the file. A later successful list of
	 * that workspace that read the file's directory but did not return the file means the file is
	 * gone, and the record is dropped.
	 */
	cwd?: string;
}

/** Session file path → record. */
export type ArchivedSessions = Record<string, ArchivedRecord>;

export function archiveStateKey(serverId: string): string {
	return `archived:${serverId}`;
}

/** The archive records of one server (a copy). */
export function archivedSessions(store: Store, serverId: string): ArchivedSessions {
	const value = store.getState<ArchivedSessions>(archiveStateKey(serverId));
	return value && typeof value === "object" ? { ...value } : {};
}

function save(store: Store, serverId: string, records: ArchivedSessions): Promise<void> {
	return store.setState(archiveStateKey(serverId), Object.keys(records).length > 0 ? records : undefined);
}

/** Marks a session archived and returns its archive time (an already archived session keeps its time). */
export async function archiveSession(store: Store, serverId: string, file: string, now = Date.now()): Promise<number> {
	const records = archivedSessions(store, serverId);
	const existing = records[file];
	if (existing) return existing.archivedAt;
	records[file] = { archivedAt: now };
	await save(store, serverId, records);
	return now;
}

/** Removes a session's archive record (restored or deleted). Returns whether there was one. */
export async function unarchiveSession(store: Store, serverId: string, file: string): Promise<boolean> {
	const records = archivedSessions(store, serverId);
	if (!records[file]) return false;
	delete records[file];
	await save(store, serverId, records);
	return true;
}

/** Drops every archive record of a server (the server was deleted). */
export async function forgetArchivedServer(store: Store, serverId: string): Promise<void> {
	if (store.getState(archiveStateKey(serverId)) !== undefined) await store.setState(archiveStateKey(serverId), undefined);
}

/** How many of these session files of a server are not archived. */
export function activeSessionCount(store: Store, serverId: string, files: readonly string[]): number {
	const records = archivedSessions(store, serverId);
	return files.filter((file) => !records[file]).length;
}

/**
 * Applies the archive records to a successful `sessions.list` of the workspace at `cwd`: fills
 * `archivedAt` on archived sessions, remembers `cwd` on their records, and drops the records of
 * this workspace whose file is no longer listed. Records created after `listedSince` (when the
 * list call started) are kept, since the list may predate their file. So are records whose
 * directory the list did not show (no listed session lives there): the agent lists the directory
 * its config points to (agentDirMode, sessionDir), which can change while the old files remain.
 */
export async function applyArchiveMarks(
	store: Store,
	serverId: string,
	cwd: string,
	sessions: readonly SessionSummary[],
	listedSince: number,
): Promise<SessionSummary[]> {
	const records = archivedSessions(store, serverId);
	const listed = new Set(sessions.map((s) => s.file));
	const listedDirs = new Set(sessions.map((s) => posixPath.dirname(s.file)));
	let changed = false;
	for (const [file, record] of Object.entries(records)) {
		if (listed.has(file)) {
			if (record.cwd !== cwd) {
				records[file] = { ...record, cwd };
				changed = true;
			}
		} else if (record.cwd === cwd && record.archivedAt < listedSince && listedDirs.has(posixPath.dirname(file))) {
			delete records[file];
			changed = true;
		}
	}
	// A failed write must not fail the listing: the store logs it and already holds the new records.
	if (changed) await save(store, serverId, records).catch(() => undefined);
	return sessions.map((s) => {
		const record = records[s.file];
		return record ? { ...s, archivedAt: record.archivedAt } : s;
	});
}
