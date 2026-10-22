import type { ConversationView, ServerView, SessionSummary } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { parseRoute, paths } from "./routes";
import {
	findSessionById,
	liveConversationForSession,
	matchesSessionQuery,
	sessionIdFromFile,
	sessionTitle,
	sortSessions,
	unlistedConversations,
} from "./sessions";
import { convStatusDisplay, serverStatusDisplay } from "./status";

describe("routes", () => {
	it("builds paths", () => {
		expect(paths.chat("ws1")).toBe("/w/ws1/chat");
		expect(paths.chat("ws1", "abc")).toBe("/w/ws1/chat/abc");
		expect(paths.files("ws1", "src/a b.ts")).toBe("/w/ws1/files?path=src%2Fa%20b.ts");
		expect(paths.serverSettings("s 1")).toBe("/servers/s%201/settings");
	});
	it("parses paths", () => {
		expect(parseRoute("/")).toEqual({ kind: "home" });
		expect(parseRoute("/servers/new")).toEqual({ kind: "addServer" });
		expect(paths.addServer()).toBe("/servers/new");
		expect(paths.addServer("a b")).toBe("/servers/new?server=a%20b");
		expect(parseRoute("/servers/s1")).toEqual({ kind: "server", serverId: "s1" });
		expect(parseRoute("/servers/s1/settings")).toEqual({ kind: "serverSettings", serverId: "s1" });
		expect(parseRoute("/w/ws1/chat")).toEqual({ kind: "workspace", workspaceId: "ws1", tab: "chat" });
		expect(parseRoute("/w/ws1/chat/abc/")).toEqual({ kind: "workspace", workspaceId: "ws1", tab: "chat", sessionId: "abc" });
		expect(parseRoute("/w/ws1/git")).toEqual({ kind: "workspace", workspaceId: "ws1", tab: "git" });
		expect(parseRoute("/w/ws1")).toEqual({ kind: "workspace", workspaceId: "ws1", tab: "chat" });
		expect(parseRoute("/w/ws1/nope")).toEqual({ kind: "unknown" });
		expect(parseRoute("/sync")).toEqual({ kind: "sync" });
		expect(parseRoute("/settings")).toEqual({ kind: "settings" });
		expect(parseRoute("/what")).toEqual({ kind: "unknown" });
	});
});

const UUID = "7f3c1e2a-1111-4222-8333-944455556666";

function summary(partial: Partial<SessionSummary>): SessionSummary {
	return {
		file: `/home/dev/.pi-web/agent/sessions/--x--/2026-10-22T09-14-03-000Z_${UUID}.jsonl`,
		id: UUID,
		cwd: "/home/dev/x",
		createdMs: 0,
		modifiedMs: 0,
		messageCount: 0,
		firstMessage: "",
		...partial,
	};
}

function conv(partial: Partial<ConversationView> & { status?: ConversationView["info"]["status"]; sessionFile?: string; sessionId?: string }): ConversationView {
	return {
		convId: partial.convId ?? "c1",
		serverId: "s1",
		workspaceId: partial.workspaceId ?? "ws1",
		info: {
			convId: partial.convId ?? "c1",
			cwd: "/home/dev/x",
			status: partial.status ?? "running",
			sessionFile: partial.sessionFile,
			sessionId: partial.sessionId,
			startedAt: 0,
			lastActivityAt: 0,
			lastSeq: 0,
			pendingUi: [],
			statuses: {},
			widgets: {},
		},
	};
}

describe("sessions", () => {
	it("extracts ids from file names", () => {
		expect(sessionIdFromFile(`/a/b/2026-10-22T09-14-03-000Z_${UUID}.jsonl`)).toBe(UUID);
		expect(sessionIdFromFile("/a/b/2026_abc.jsonl")).toBe("abc");
		expect(sessionIdFromFile("plain.jsonl")).toBe("plain");
	});
	it("finds sessions by route id", () => {
		const s = summary({ id: "" });
		expect(findSessionById([s], UUID)).toBe(s);
		expect(findSessionById([s], "zzz")).toBeUndefined();
		expect(findSessionById(undefined, UUID)).toBeUndefined();
	});
	it("titles, searches and sorts", () => {
		expect(sessionTitle(summary({ name: "修复内存泄漏", firstMessage: "x" }))).toBe("修复内存泄漏");
		expect(sessionTitle(summary({ firstMessage: "训练跑到\n第 3 个 epoch" }))).toBe("训练跑到 第 3 个 epoch");
		expect(sessionTitle(summary({}))).toBe("新对话");
		expect(sessionTitle(undefined)).toBe("新对话");
		expect(matchesSessionQuery(summary({ name: "Add FSDP" }), "fsdp")).toBe(true);
		expect(matchesSessionQuery(summary({ firstMessage: "dataloader 泄漏" }), "泄漏")).toBe(true);
		expect(matchesSessionQuery(summary({ name: "x" }), "y")).toBe(false);
		expect(matchesSessionQuery(summary({ name: "x" }), "  ")).toBe(true);
		const sorted = sortSessions([summary({ id: "a", modifiedMs: 1 }), summary({ id: "b", modifiedMs: 5 })]);
		expect(sorted.map((s) => s.id)).toEqual(["b", "a"]);
	});
	it("matches live conversations", () => {
		const s = summary({});
		expect(liveConversationForSession(s, [conv({ sessionFile: s.file })])?.convId).toBe("c1");
		expect(liveConversationForSession(s, [conv({ sessionId: UUID })])?.convId).toBe("c1");
		expect(liveConversationForSession({ ...s, runningConvId: "c2" }, [conv({}), conv({ convId: "c2" })])?.convId).toBe("c2");
		expect(liveConversationForSession(s, [conv({ sessionFile: s.file, status: "exited" })])).toBeUndefined();
	});
	it("lists conversations missing from the session list", () => {
		const s = summary({});
		const list = unlistedConversations("ws1", [s], [
			conv({ convId: "a", sessionFile: s.file }),
			conv({ convId: "b" }),
			conv({ convId: "c", workspaceId: "ws2" }),
			conv({ convId: "d", status: "exited" }),
		]);
		expect(list.map((c) => c.convId)).toEqual(["b"]);
	});
});

function server(status: Partial<ServerView["status"]>): ServerView {
	return {
		config: {} as ServerView["config"],
		status: {
			serverId: "s1",
			connection: "connected",
			deployState: "deployed",
			conversationsRunning: 0,
			conversationsWaiting: 0,
			pendingSync: 0,
			...status,
		},
	};
}

describe("status display", () => {
	it("describes servers", () => {
		expect(serverStatusDisplay(server({ latencyMs: 12.4 })).text).toBe("在线 · 12ms");
		expect(serverStatusDisplay(server({ pendingSync: 1 })).text).toBe("在线 · 1 个待同步");
		expect(serverStatusDisplay(server({ deployState: "not_deployed" })).tone).toBe("warning");
		expect(serverStatusDisplay(server({ connection: "disconnected" }))).toEqual({ tone: "neutral", text: "离线", hollow: true });
		expect(serverStatusDisplay(server({ connection: "error" })).tone).toBe("danger");
	});
	it("describes conversations", () => {
		expect(convStatusDisplay("running")?.pulse).toBe(true);
		expect(convStatusDisplay("waiting_ui")?.text).toBe("等待确认 · 扩展对话框");
		expect(convStatusDisplay("exited")).toBeUndefined();
		expect(convStatusDisplay(undefined)).toBeUndefined();
	});
});
