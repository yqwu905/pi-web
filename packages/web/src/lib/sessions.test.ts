import type { ConversationView, SessionSummary } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import {
	archiveBlockedReason,
	canRememberSession,
	filterKeepsRow,
	inProgressItems,
	isArchived,
	isInProgress,
	pickResumeTarget,
	sidebarSessionGroups,
	splitArchived,
} from "./sessions";

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

	it("keeps only sessions whose conversation is in progress with the 进行中 filter; the count ignores it", () => {
		expect(isInProgress(undefined)).toBe(false);
		expect(isInProgress("idle")).toBe(false);
		expect(isInProgress("exited")).toBe(false);
		expect(isInProgress("starting")).toBe(true);
		expect(isInProgress("running")).toBe(true);
		expect(isInProgress("waiting_ui")).toBe(true);
		const withStatus = (view: ConversationView, status: ConversationView["info"]["status"]): ConversationView => ({ ...view, info: { ...view.info, status } });
		const live = [
			withStatus(conv("c1", "w", "a", 0), "running"),
			withStatus(conv("c2", "w", "d", 0), "idle"),
			withStatus(conv("c3", "w", "e", 0), "waiting_ui"),
			withStatus(conv("c4", "w", "f", 0), "exited"),
		];
		const e = session("e", { name: "加载数据" });
		const f = session("f");
		const groups = sidebarSessionGroups([a, b, c, d, e, f], "", { live, unread: {} });
		expect(groups.active.map((s) => s.id)).toEqual(["a", "e"]);
		expect(groups.archived).toEqual([]);
		expect(groups.count).toBe(4);
		// Combined with a search query.
		expect(sidebarSessionGroups([a, b, c, d, e, f], "加载", { live, unread: {} }).active.map((s) => s.id)).toEqual(["e"]);
		expect(sidebarSessionGroups([a, d], "", { live: [], unread: {} }).active).toEqual([]);
		// Unread sessions (also without a live conversation, also archived ones) and the open session are kept too.
		const unread = { d: { serverId: "srv", workspaceId: "w" }, c: { serverId: "srv", workspaceId: "w" } };
		const withUnread = sidebarSessionGroups([a, b, c, d, e, f], "", { live, unread, openId: "f" });
		expect(withUnread.active.map((s) => s.id)).toEqual(["a", "d", "e", "f"]);
		expect(withUnread.archived.map((s) => s.id)).toEqual(["c"]);
		expect(withUnread.count).toBe(4);
	});

	it("lists where the 进行中 filter has rows, once per session", () => {
		const running = { ...conv("c1", "w1", "a", 0), info: { ...conv("c1", "w1", "a", 0).info, status: "running" as const } };
		const noWorkspace = { ...running, convId: "c2", workspaceId: null, info: { ...running.info, convId: "c2", sessionId: "x" } };
		const idle = conv("c3", "w2", "b", 0);
		const items = inProgressItems([running, noWorkspace, idle], {
			a: { serverId: "srv", workspaceId: "w1" },
			d: { serverId: "srv2", workspaceId: "w3" },
			y: { serverId: "srv", workspaceId: null },
		});
		expect(items).toEqual([
			{ serverId: "srv", workspaceId: "w1" },
			{ serverId: "srv2", workspaceId: "w3" },
		]);
		// A new conversation without a session id yet: its 未读 mark is keyed by the conversation id.
		const fresh = { ...idle, info: { ...idle.info, sessionId: undefined } };
		expect(filterKeepsRow({ live: [fresh], unread: {} }, fresh)).toBe(false);
		expect(filterKeepsRow({ live: [fresh], unread: { c3: { serverId: "srv", workspaceId: "w2" } } }, fresh)).toBe(true);
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
