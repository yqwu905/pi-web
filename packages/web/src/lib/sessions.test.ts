import type { ConversationView, SessionSummary } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { archiveBlockedReason, canRememberSession, isArchived, pickResumeTarget, sidebarSessionGroups, splitArchived } from "./sessions";

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		file: `/home/dev/.pi-web/agent/sessions/--w--/2026-10-22T09-14-03-123Z_${id}.jsonl`,
		id,
		cwd: "/w",
		createdMs: 1,
		modifiedMs: 1,
		messageCount: 2,
		firstMessage: `first ${id}`,
		...extra,
	};
}

function conv(convId: string, workspaceId: string, sessionId: string, lastActivityAt: number, sessionFile?: string): ConversationView {
	return {
		convId,
		serverId: "srv",
		workspaceId,
		info: { convId, cwd: "/w", sessionId, sessionFile, status: "idle", startedAt: 0, lastActivityAt, lastSeq: 0, pendingUi: [], statuses: {}, widgets: {} },
	};
}

describe("archived sessions", () => {
	const a = session("a");
	const b = session("b", { archivedAt: 100, name: "数据加载器" });
	const c = session("c", { archivedAt: 300 });
	const d = session("d", { name: "加载 bug" });

	it("splits active sessions (order kept) from archived ones (latest archived first)", () => {
		expect(isArchived(a)).toBe(false);
		expect(isArchived(b)).toBe(true);
		expect(isArchived(undefined)).toBe(false);
		const { active, archived } = splitArchived([a, b, c, d]);
		expect(active.map((s) => s.id)).toEqual(["a", "d"]);
		expect(archived.map((s) => s.id)).toEqual(["c", "b"]);
	});

	it("filters both groups by the search query; the count is the active total", () => {
		expect(sidebarSessionGroups([a, b, c, d], "")).toMatchObject({ count: 2 });
		const groups = sidebarSessionGroups([a, b, c, d], "加载");
		expect(groups.active.map((s) => s.id)).toEqual(["d"]);
		expect(groups.archived.map((s) => s.id)).toEqual(["b"]);
		expect(groups.count).toBe(2);
		expect(sidebarSessionGroups([a, b, c, d], "FIRST C").archived.map((s) => s.id)).toEqual(["c"]);
		expect(sidebarSessionGroups([], "x")).toEqual({ active: [], archived: [], count: 0 });
	});

	it("blocks archiving while the conversation runs or waits for a dialog", () => {
		expect(archiveBlockedReason(undefined)).toBeNull();
		expect(archiveBlockedReason("idle")).toBeNull();
		expect(archiveBlockedReason("exited")).toBeNull();
		expect(archiveBlockedReason("running")).toContain("正在运行");
		expect(archiveBlockedReason("starting")).toContain("正在运行");
		expect(archiveBlockedReason("waiting_ui")).toContain("等待确认");
	});

	it("remembers the open session only once the list shows it is not archived (or failed)", () => {
		// Still loading: it may turn out archived, and remembering it would replace the previous session.
		expect(canRememberSession("b", { isPending: true })).toBe(false);
		expect(canRememberSession("b", { isPending: false, data: [a, b] })).toBe(false);
		expect(canRememberSession("a", { isPending: false, data: [a, b] })).toBe(true);
		// Not listed yet (just started) or the list failed: remembered as before.
		expect(canRememberSession("new", { isPending: false, data: [a, b] })).toBe(true);
		expect(canRememberSession("b", { isPending: false })).toBe(true);
		expect(canRememberSession(undefined, { isPending: false, data: [a] })).toBe(false);
	});

	it("resumes the last visited session unless it is archived, then the latest live conversation that is not", () => {
		const workspaceIds = new Set(["w1", "w2"]);
		const last = { workspaceId: "w1", sessionId: "b" };
		const live = [conv("c1", "w1", "a", 10), conv("c2", "w2", "x", 30, "/x.jsonl"), conv("c3", "w1", "c", 50, c.file)];
		// Unknown lists: nothing counts as archived.
		expect(pickResumeTarget(last, workspaceIds, live, {})).toEqual(last);
		// The last visited session and the most recent live one (matched by file) are archived.
		expect(pickResumeTarget(last, workspaceIds, live, { w1: [a, b, c] })).toEqual({ workspaceId: "w2", sessionId: "x" });
		expect(pickResumeTarget(null, workspaceIds, live, { w1: [a, b, c], w2: [session("x", { file: "/x.jsonl", archivedAt: 1 })] })).toEqual({
			workspaceId: "w1",
			sessionId: "a",
		});
		// A removed workspace is skipped as before.
		expect(pickResumeTarget({ workspaceId: "gone", sessionId: "a" }, workspaceIds, [], {})).toBeUndefined();
	});
});
