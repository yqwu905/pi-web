/**
 * Sync matrix derivation (pure): servers × item groups with one merged cell state per group,
 * the default selected row, and display metadata for cell states.
 */
import type { ServerView, SyncCellState, SyncItemKey, SyncServerStatus } from "@pi-web/shared";

export interface MatrixColumn {
	id: string;
	label: string;
	items: readonly SyncItemKey[];
	/** Tooltip listing the underlying items. */
	title: string;
}

/** Column grouping of the artboard (extensions → 扩展, npm + git → 插件包), plus 主题 and 其他. */
export const MATRIX_COLUMNS: readonly MatrixColumn[] = [
	{ id: "settings", label: "settings", items: ["settings"], title: "settings.json" },
	{ id: "models", label: "models", items: ["models"], title: "models.json" },
	{ id: "auth", label: "auth", items: ["auth"], title: "auth.json" },
	{ id: "mcp", label: "mcp", items: ["mcp"], title: "mcp.json" },
	{ id: "instructions", label: "指令", items: ["instructions"], title: "AGENTS.md / SYSTEM.md 等指令文件" },
	{ id: "extensions", label: "扩展", items: ["extensions"], title: "extensions/" },
	{ id: "skills", label: "skills", items: ["skills"], title: "skills/" },
	{ id: "prompts", label: "prompts", items: ["prompts"], title: "prompts/" },
	{ id: "themes", label: "主题", items: ["themes"], title: "themes/" },
	{ id: "packages", label: "插件包", items: ["npm", "git"], title: "npm/、git/" },
	{ id: "other", label: "其他", items: ["agentsSkills", "keybindings"], title: "~/.agents/skills、keybindings.json" },
];

/** Higher wins when merging cells of one column. */
const SEVERITY: Record<SyncCellState, number> = { disabled: 0, synced: 1, unknown: 2, pending: 3, conflict: 4 };

/** Merges item states: the most severe enabled state wins; all disabled → disabled. */
export function mergeCellStates(states: readonly (SyncCellState | undefined)[]): SyncCellState {
	let best: SyncCellState = "disabled";
	for (const s of states) {
		const state = s ?? "unknown";
		if (SEVERITY[state] > SEVERITY[best]) best = state;
	}
	return best;
}

export interface MatrixRow {
	serverId: string;
	name: string;
	online: boolean;
	auto: boolean;
	running: boolean;
	pendingCount: number;
	lastSyncAt?: number;
	cells: Array<{ column: MatrixColumn; state: SyncCellState }>;
	hasConflict: boolean;
	hasPending: boolean;
}

export function buildMatrixRows(statuses: readonly SyncServerStatus[], servers: readonly ServerView[]): MatrixRow[] {
	const byId = new Map(servers.map((s) => [s.config.id, s]));
	return statuses
		.filter((s) => !byId.get(s.serverId)?.config.jumpOnly)
		.map((s) => {
			const cells = MATRIX_COLUMNS.map((column) => ({ column, state: mergeCellStates(column.items.map((k) => s.items[k])) }));
			return {
				serverId: s.serverId,
				name: byId.get(s.serverId)?.config.name ?? s.serverId,
				online: s.online,
				auto: s.auto,
				running: s.running,
				pendingCount: s.pendingCount,
				lastSyncAt: s.lastSyncAt,
				cells,
				hasConflict: cells.some((c) => c.state === "conflict"),
				hasPending: s.pendingCount > 0 || cells.some((c) => c.state === "pending"),
			};
		});
}

/** Keeps a valid selection, else picks the first row with conflicts, then pending changes, then the first row. */
export function defaultSelection(rows: readonly MatrixRow[], current: string | null): string | null {
	if (current && rows.some((r) => r.serverId === current)) return current;
	return (rows.find((r) => r.hasConflict) ?? rows.find((r) => r.hasPending && r.online) ?? rows.find((r) => r.hasPending) ?? rows[0])?.serverId ?? null;
}

export const CELL_STATE_LABELS: Record<SyncCellState, string> = {
	synced: "已同步",
	pending: "待同步",
	conflict: "冲突",
	disabled: "未启用",
	unknown: "未计算",
};

export function rowSubtitle(row: Pick<MatrixRow, "online" | "auto" | "running">): string {
	if (row.running) return "同步中…";
	return `${row.online ? "在线" : "离线"} · ${row.auto ? "自动" : "手动"}`;
}
