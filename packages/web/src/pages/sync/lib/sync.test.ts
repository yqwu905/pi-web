import type { OAuthProviderStatus, ServerView, SyncPlanEntry, SyncRecord, SyncServerStatus } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { buildMatrixRows, defaultSelection, MATRIX_COLUMNS, mergeCellStates, rowSubtitle } from "./matrix";
import { oauthProgress, pushedText, refreshText, remainingText } from "./oauth";
import { entryKind, entryNote, historyTime, lastRecordFor, mergeRecord, planCounts, recordChangeText, sortEntries } from "./plan";

const allItems = (state: SyncServerStatus["items"]["settings"]): SyncServerStatus["items"] => ({
	settings: state,
	models: state,
	auth: state,
	mcp: state,
	instructions: state,
	extensions: state,
	skills: state,
	prompts: state,
	themes: state,
	npm: state,
	git: state,
	agentsSkills: "disabled",
	keybindings: "disabled",
});

const status = (serverId: string, items: SyncServerStatus["items"], extra: Partial<SyncServerStatus> = {}): SyncServerStatus => ({
	serverId,
	online: true,
	auto: true,
	running: false,
	items,
	pendingCount: 0,
	...extra,
});

const view = (id: string, name: string, jumpOnly = false): ServerView => ({
	config: { id, name, ...(jumpOnly ? { jumpOnly } : {}) } as unknown as ServerView["config"],
	status: { serverId: id } as ServerView["status"],
});

describe("matrix", () => {
	it("merges cell states by severity", () => {
		expect(mergeCellStates(["synced", "pending"])).toBe("pending");
		expect(mergeCellStates(["synced", "conflict", "pending"])).toBe("conflict");
		expect(mergeCellStates(["disabled", "disabled"])).toBe("disabled");
		expect(mergeCellStates(["disabled", "synced"])).toBe("synced");
		expect(mergeCellStates([undefined])).toBe("unknown");
		expect(mergeCellStates([])).toBe("disabled");
	});

	it("covers every sync item exactly once", () => {
		const keys = MATRIX_COLUMNS.flatMap((c) => c.items);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toHaveLength(13);
	});

	it("builds rows, hides jump-only hosts and selects sensibly", () => {
		const statuses = [
			status("a", allItems("synced")),
			status("b", { ...allItems("synced"), npm: "pending", mcp: "conflict" }, { pendingCount: 3 }),
			status("c", allItems("pending"), { online: false, auto: false, pendingCount: 6 }),
			status("j", allItems("synced")),
		];
		const rows = buildMatrixRows(statuses, [view("a", "gpu-01"), view("b", "build-arm"), view("c", "staging-db"), view("j", "bastion", true)]);
		expect(rows.map((r) => r.name)).toEqual(["gpu-01", "build-arm", "staging-db"]);
		const b = rows[1];
		expect(b.cells.find((c) => c.column.id === "packages")?.state).toBe("pending");
		expect(b.cells.find((c) => c.column.id === "mcp")?.state).toBe("conflict");
		expect(b.cells.find((c) => c.column.id === "other")?.state).toBe("disabled");
		expect(b.hasConflict).toBe(true);
		expect(defaultSelection(rows, null)).toBe("b");
		expect(defaultSelection(rows, "c")).toBe("c");
		expect(defaultSelection(rows, "gone")).toBe("b");
		expect(defaultSelection([], null)).toBeNull();
		expect(defaultSelection(rows.filter((r) => r.serverId !== "b"), null)).toBe("c");
		expect(rowSubtitle(rows[2])).toBe("离线 · 手动");
		expect(rowSubtitle({ ...rows[0], running: true })).toBe("同步中…");
	});
});

describe("oauth", () => {
	const now = 1_000_000_000;
	const servers = [view("a", "gpu-01"), view("c", "staging-db")];
	const provider: OAuthProviderStatus = {
		provider: "anthropic",
		expiresAt: now + 42 * 60_000,
		lastRefreshAt: now - 18 * 60_000,
		refreshAt: now + 32 * 60_000,
		pushed: [
			{ serverId: "a", ok: true, at: now },
			{ serverId: "c", ok: false, error: "offline" },
		],
	};

	it("computes remaining validity and push coverage", () => {
		const p = oauthProgress(provider, servers, now);
		expect(p.ratio).toBeCloseTo(0.7);
		expect(p.tone).toBe("accent");
		expect(remainingText(p)).toBe("剩余 42 分钟");
		expect(refreshText(p.refreshInMs)).toBe("下次刷新约 32 分钟后");
		expect(pushedText(p, (id) => id === "c")).toBe("已推送 1/2 台（staging-db 离线）");
		expect(pushedText(p, () => false)).toBe("已推送 1/2 台（staging-db 失败）");
	});

	it("handles expiry and unknown refresh times", () => {
		const p = oauthProgress({ ...provider, expiresAt: now - 1, lastRefreshAt: undefined, pushed: [] }, servers, now);
		expect(p.expired).toBe(true);
		expect(p.ratio).toBe(0);
		expect(p.tone).toBe("danger");
		expect(remainingText(p)).toBe("已过期");
		expect(pushedText(p, () => false)).toBe("尚未推送到服务器");
		expect(refreshText(0)).toBe("即将刷新");
		expect(oauthProgress({ ...provider, expiresAt: now + 10 * 60_000, lastRefreshAt: undefined }, servers, now).tone).toBe("warning");
	});
});

describe("plans and history", () => {
	const entries: SyncPlanEntry[] = [
		{ path: "settings.json", item: "settings", action: "update", conflict: false },
		{ path: "prompts/old.md", item: "prompts", action: "delete", conflict: false },
		{ path: "AGENTS.md", item: "instructions", action: "update", conflict: true },
		{ path: "extensions/a.ts", item: "extensions", action: "add", conflict: false, bytes: 3400 },
	];

	it("classifies and orders entries", () => {
		expect(entryKind(entries[2])).toBe("conflict");
		expect(sortEntries(entries).map((e) => e.path)).toEqual(["AGENTS.md", "extensions/a.ts", "settings.json", "prompts/old.md"]);
		expect(planCounts({ entries })).toEqual({ add: 1, update: 1, delete: 1, conflict: 1 });
		expect(entryNote(entries[1])).toContain("已在 Host 删除");
		expect(entryNote(entries[2])).toContain("备份");
		expect(entryNote({ ...entries[0], note: "x" })).toBe("x");
		expect(entryNote(entries[0])).toBeUndefined();
	});

	it("summarizes and merges records", () => {
		const rec = (id: string, serverId: string, at: number): SyncRecord => ({
			id,
			serverId,
			at,
			trigger: "auto",
			added: 0,
			updated: 2,
			deleted: 0,
			conflicts: 0,
			backedUp: [],
			status: "ok",
			durationMs: 10,
		});
		expect(recordChangeText(rec("1", "a", 1))).toBe("修改 2 个文件");
		expect(recordChangeText({ added: 0, updated: 0, deleted: 0 })).toBe("无变更");
		const list = [rec("2", "a", 20), rec("1", "b", 10)];
		expect(lastRecordFor(list, "a")?.id).toBe("2");
		expect(lastRecordFor(undefined, "a")).toBeUndefined();
		expect(mergeRecord(list, rec("3", "a", 30)).map((r) => r.id)).toEqual(["3", "2", "1"]);
		expect(mergeRecord(list, { ...rec("2", "a", 25) }).map((r) => r.id)).toEqual(["2", "1"]);
		expect(mergeRecord(list, rec("3", "a", 30), 2)).toHaveLength(2);
	});
});

describe("historyTime", () => {
	it("formats today, yesterday and older days", () => {
		const now = new Date(2026, 9, 22, 14, 0).getTime();
		expect(historyTime(new Date(2026, 9, 22, 13, 38).getTime(), now)).toEqual({ time: "13:38" });
		expect(historyTime(new Date(2026, 9, 21, 21, 14).getTime(), now)).toEqual({ day: "昨天", time: "21:14" });
		expect(historyTime(new Date(2026, 9, 18, 9, 2).getTime(), now)).toEqual({ day: "10月18日", time: "09:02" });
		expect(historyTime(new Date(2025, 0, 3, 9, 2).getTime(), now)).toEqual({ day: "2025年1月3日", time: "09:02" });
	});
});
