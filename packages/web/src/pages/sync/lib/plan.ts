/** Sync plan and history display helpers (pure). */
import type { SyncPlan, SyncPlanEntry, SyncRecord } from "@pi-web/shared";

export type EntryKind = "add" | "update" | "delete" | "conflict";

export const ENTRY_KIND_LABELS: Record<EntryKind, string> = {
	add: "新增",
	update: "修改",
	delete: "删除",
	conflict: "冲突",
};

/** Conflicts are shown as their own kind (they are backed up, then overwritten or deleted). */
export function entryKind(entry: Pick<SyncPlanEntry, "action" | "conflict">): EntryKind {
	return entry.conflict ? "conflict" : entry.action;
}

/** Ordering in the preview list: conflicts first, then add, update, delete; by path within a kind. */
export function sortEntries(entries: readonly SyncPlanEntry[]): SyncPlanEntry[] {
	const rank: Record<EntryKind, number> = { conflict: 0, add: 1, update: 2, delete: 3 };
	return [...entries].sort((a, b) => rank[entryKind(a)] - rank[entryKind(b)] || a.path.localeCompare(b.path));
}

/** Summary counts with conflicts split out of add/update/delete. */
export function planCounts(plan: Pick<SyncPlan, "entries">): Record<EntryKind, number> {
	const counts: Record<EntryKind, number> = { add: 0, update: 0, delete: 0, conflict: 0 };
	for (const e of plan.entries) counts[entryKind(e)]++;
	return counts;
}

export function isPlanEmpty(plan: Pick<SyncPlan, "entries">): boolean {
	return plan.entries.length === 0;
}

/** Default explanation for an entry without a host-provided note. */
export function entryNote(entry: SyncPlanEntry): string | undefined {
	if (entry.note) return entry.note;
	if (entry.conflict) return entry.action === "delete" ? "服务器上被修改过，将备份后删除" : "服务器上被修改过，将备份后覆盖";
	if (entry.action === "delete") return "已在 Host 删除，且由同步写入";
	return undefined;
}

export const TRIGGER_LABELS: Record<SyncRecord["trigger"], string> = {
	manual: "手动",
	auto: "自动（文件变更）",
	connect: "连接时",
	oauth: "OAuth 推送",
	deploy: "部署",
};

/** "修改 2 个文件" style summary of a record. */
export function recordChangeText(r: Pick<SyncRecord, "added" | "updated" | "deleted">): string {
	const parts = [r.added && `新增 ${r.added}`, r.updated && `修改 ${r.updated}`, r.deleted && `删除 ${r.deleted}`].filter(Boolean);
	return parts.length ? `${parts.join("、")} 个文件` : "无变更";
}

/** The newest record of a server (history is newest first, but do not rely on it). */
export function lastRecordFor(records: readonly SyncRecord[] | undefined, serverId: string): SyncRecord | undefined {
	let best: SyncRecord | undefined;
	for (const r of records ?? []) if (r.serverId === serverId && (!best || r.at > best.at)) best = r;
	return best;
}

/** Merges a pushed record into a history list (newest first, deduplicated by id, capped). */
export function mergeRecord(records: readonly SyncRecord[] | undefined, record: SyncRecord, cap = 100): SyncRecord[] {
	const rest = (records ?? []).filter((r) => r.id !== record.id);
	return [record, ...rest].sort((a, b) => b.at - a.at).slice(0, cap);
}

/** History timestamp: "13:38" today, "昨天 21:14", else "10月18日 09:02" (or with the year). */
export function historyTime(ms: number, now: number = Date.now()): { day?: string; time: string } {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
	const startOf = (t: number) => {
		const x = new Date(t);
		x.setHours(0, 0, 0, 0);
		return x.getTime();
	};
	const days = Math.round((startOf(now) - startOf(ms)) / 86_400_000);
	if (days <= 0) return { time };
	if (days === 1) return { day: "昨天", time };
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return { day: `${sameYear ? "" : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`, time };
}
