/**
 * "Fork" under an assistant reply: a new session that continues right after that reply.
 * pi's RPC forks only at a user message (the new session ends just before it) or clones the
 * current leaf, so a reply is forked at the user message that follows it on the branch, and
 * cloned when it belongs to the last turn.
 */
import type { SessionEntry } from "@pi-web/shared";
import type { DisplayItem } from "./messages";

export type ReplyForkTarget =
	| { type: "clone" }
	/** Fork at the user message sent at `timestamp` (the next one after the reply). */
	| { type: "fork"; timestamp: number };

/** How to fork after the assistant group `key`; undefined when it is not in `items`. */
export function replyForkTarget(items: readonly DisplayItem[], key: string): ReplyForkTarget | undefined {
	const index = items.findIndex((item) => item.key === key);
	if (index < 0) return undefined;
	for (let i = index + 1; i < items.length; i++) {
		const item = items[i];
		if (item.kind === "user") return { type: "fork", timestamp: item.message.timestamp };
	}
	return { type: "clone" };
}

/** Entry id of the user message sent at `timestamp` on the branch that ends at `leafId`. */
export function userEntryOnBranch(entries: readonly SessionEntry[], leafId: string | null, timestamp: number): string | undefined {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const seen = new Set<string>();
	for (let id = leafId; id && !seen.has(id); ) {
		seen.add(id);
		const entry = byId.get(id);
		if (!entry) return undefined;
		if (entry.type === "message" && entry.message.role === "user" && entry.message.timestamp === timestamp) return entry.id;
		id = entry.parentId;
	}
	return undefined;
}
