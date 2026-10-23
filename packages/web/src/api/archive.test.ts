import type { SessionSummary, WorkspaceView } from "@pi-web/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ws", () => ({ wsClient: { subscribe: () => () => {}, onOpen: () => () => {} } }));

const { applyArchiveChange } = await import("./archive");
const { queryClient, queryKeys } = await import("./queryClient");
const { useUiStore } = await import("../stores/ui");

const FILE = "/home/dev/.pi-web/agent/sessions/--home-dev-p--/2026-10-22T09-14-03-123Z_0b7e3c1a-1111-4222-8333-944455556666.jsonl";
const ID = "0b7e3c1a-1111-4222-8333-944455556666";

function session(extra: Partial<SessionSummary> = {}): SessionSummary {
	return { file: FILE, id: ID, cwd: "/home/dev/p", createdMs: 1, modifiedMs: 1, messageCount: 2, firstMessage: "hi", ...extra };
}

function workspace(id: string, serverId: string): WorkspaceView {
	return { config: { id, serverId, path: "/home/dev/p", alias: "p", trust: "approve", defaults: {}, env: {}, createdAt: 0 }, runningCount: 0 };
}

const listOf = (wsId: string) => queryClient.getQueryData<SessionSummary[]>(queryKeys.sessions(wsId));

beforeEach(() => {
	// The same machine added twice: ws1 on srv1 and ws2 on srv2 list the same file.
	queryClient.setQueryData(queryKeys.workspaces, [workspace("ws1", "srv1"), workspace("ws2", "srv2")]);
	queryClient.setQueryData(queryKeys.sessions("ws1"), [session()]);
	queryClient.setQueryData(queryKeys.sessions("ws2"), [session()]);
	useUiStore.setState({ lastSession: { ws1: ID, ws2: ID }, lastVisited: { workspaceId: "ws2", sessionId: ID } });
});

afterEach(() => {
	queryClient.clear();
	useUiStore.setState({ lastSession: {}, lastVisited: null });
});

describe("applyArchiveChange", () => {
	it("marks and restores the session only in the event's server's workspaces", () => {
		applyArchiveChange({ serverId: "srv1", file: FILE, archivedAt: 100 });
		expect(listOf("ws1")?.[0]?.archivedAt).toBe(100);
		expect(listOf("ws2")?.[0]).not.toHaveProperty("archivedAt");
		// Forgotten as srv1's remembered session only.
		expect(useUiStore.getState().lastSession).toEqual({ ws2: ID });
		expect(useUiStore.getState().lastVisited).toEqual({ workspaceId: "ws2", sessionId: ID });

		queryClient.setQueryData(queryKeys.sessions("ws2"), [session({ archivedAt: 50 })]);
		applyArchiveChange({ serverId: "srv1", file: FILE, archivedAt: null });
		expect(listOf("ws1")?.[0]).not.toHaveProperty("archivedAt");
		expect(listOf("ws2")?.[0]?.archivedAt).toBe(50);
	});

	it("treats a workspace missing from the cached workspace lists as the event's server's", () => {
		queryClient.setQueryData(queryKeys.sessions("ws3"), [session()]);
		applyArchiveChange({ serverId: "srv2", file: FILE, archivedAt: 7 });
		expect(listOf("ws3")?.[0]?.archivedAt).toBe(7);
		expect(listOf("ws2")?.[0]?.archivedAt).toBe(7);
		expect(listOf("ws1")?.[0]).not.toHaveProperty("archivedAt");
		expect(useUiStore.getState().lastSession).toEqual({ ws1: ID });
		expect(useUiStore.getState().lastVisited).toBeNull();
	});

	it("does not show a deleted archived session as restored: the lists are only refetched", () => {
		queryClient.setQueryData(queryKeys.sessions("ws1"), [session({ archivedAt: 100 })]);
		applyArchiveChange({ serverId: "srv1", file: FILE, archivedAt: null, deleted: true });
		expect(listOf("ws1")?.[0]?.archivedAt).toBe(100);
		expect(queryClient.getQueryState(queryKeys.sessions("ws1"))?.isInvalidated).toBe(true);
	});
});
