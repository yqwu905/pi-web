/** Diff of the desired tree against the agent's sync.manifest. */
import type { SyncManifestResult, SyncPlan, SyncPlanEntry } from "@pi-web/shared";
import type { DesiredEntry, DesiredTree } from "./desired.js";
import { isUnderRoots, itemForPath } from "./items.js";

export interface ComputedPlan {
	plan: SyncPlan;
	writes: DesiredEntry[];
	deletes: string[];
	/** Remote files already identical to the host but not recorded as managed (adopted without a write). */
	adopt: Array<{ path: string; sha256: string }>;
}

// Backups go to R/state/backup/, or <agentDir>/.pi-web-backup/ for a shared agent dir (kept by uninstall).
const NOTE_MODIFIED = "服务器上的文件已被修改，会先备份再覆盖";
const NOTE_UNMANAGED = "服务器上已有同名文件（不是由同步写入的），会先备份再覆盖";
const NOTE_DELETE_MODIFIED = "服务器上的文件已被修改，会先备份再删除";

export function computePlan(serverId: string, desired: DesiredTree, manifest: SyncManifestResult, now = Date.now()): ComputedPlan {
	const entries: SyncPlanEntry[] = [];
	const writes: DesiredEntry[] = [];
	const deletes: string[] = [];
	const adopt: Array<{ path: string; sha256: string }> = [];
	const remote = manifest.files ?? {};
	const managed = manifest.managed ?? {};
	const protectedRoots = desired.protectedRoots ?? [];

	for (const entry of desired.entries.values()) {
		const current = remote[entry.path];
		if (current && current.sha256 === entry.sha256) {
			if (managed[entry.path] !== entry.sha256) adopt.push({ path: entry.path, sha256: entry.sha256 });
			continue;
		}
		const conflict = Boolean(current) && managed[entry.path] !== current.sha256;
		const planEntry: SyncPlanEntry = {
			path: entry.path,
			item: entry.item,
			action: current ? "update" : "add",
			conflict,
			bytes: entry.size,
		};
		if (conflict) planEntry.note = managed[entry.path] === undefined ? NOTE_UNMANAGED : NOTE_MODIFIED;
		entries.push(planEntry);
		writes.push(entry);
	}

	for (const [path, managedSha] of Object.entries(managed)) {
		if (desired.entries.has(path) || !isUnderRoots(path, desired.roots)) continue;
		// The host source could not be read: absence from the desired tree does not mean "deleted".
		if (isUnderRoots(path, protectedRoots)) continue;
		const current = remote[path];
		if (!current) continue;
		const item = itemForPath(path);
		if (!item) continue;
		const conflict = managedSha !== current.sha256;
		const planEntry: SyncPlanEntry = { path, item, action: "delete", conflict, bytes: current.size };
		if (conflict) planEntry.note = NOTE_DELETE_MODIFIED;
		entries.push(planEntry);
		deletes.push(path);
	}

	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const summary = { add: 0, update: 0, delete: 0, conflict: 0 };
	for (const entry of entries) {
		summary[entry.action]++;
		if (entry.conflict) summary.conflict++;
	}
	return {
		plan: { serverId, entries, summary, warnings: [...new Set(desired.warnings)], generatedAt: now },
		writes,
		deletes,
		adopt,
	};
}
