import type { ConvEvent, ConversationSnapshot } from "@pi-web/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	const handlers = new Map<string, (data: unknown) => void>();
	const openListeners = new Set<(info: { reconnect: boolean }) => void>();
	const status = { state: "open" as "open" | "connecting" | "reconnecting" };
	return {
		handlers,
		openListeners,
		status,
		wsClient: {
			getStatus: () => ({ state: status.state, attempt: 0, nextRetryAt: null, generation: 1 }),
			subscribe: (topic: string, handler: (data: unknown) => void) => {
				handlers.set(topic, handler);
				return () => handlers.delete(topic);
			},
			onOpen: (listener: (info: { reconnect: boolean }) => void) => {
				openListeners.add(listener);
				return () => openListeners.delete(listener);
			},
		},
	};
});

vi.mock("../api/ws", () => ({ wsClient: fake.wsClient }));
vi.mock("../api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/client")>()),
	getConversationSnapshot: vi.fn(),
	replayConversation: vi.fn(),
	conversationRpc: vi.fn(),
}));

import { ApiError, conversationRpc, getConversationSnapshot, replayConversation } from "../api/client";
import { queryClient } from "../api/queryClient";
import { getLiveConversation } from "./conversation";

const snapshotMock = vi.mocked(getConversationSnapshot);
const replayMock = vi.mocked(replayConversation);
const rpcMock = vi.mocked(conversationRpc);

function snap(seq: number, convId = "c1"): ConversationSnapshot {
	return {
		convId,
		serverId: "s1",
		workspaceId: "w1",
		configStale: false,
		snapshot: {
			info: { convId, cwd: "/w", status: "running", startedAt: 0, lastActivityAt: 0, lastSeq: seq, pendingUi: [], statuses: {}, widgets: {} },
			state: {
				thinkingLevel: "medium",
				isStreaming: true,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionId: "sess",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
			},
			messages: [],
			streaming: null,
			streamingToolArgs: {},
			runningTools: [],
			queue: { steering: [], followUp: [] },
			ui: { pending: [], statuses: {}, widgets: {}, notifications: [] },
			isRunning: true,
			isCompacting: false,
			seq,
		},
	};
}

const ev = (seq: number, record: ConvEvent["record"], convId = "c1"): ConvEvent => ({ convId, seq, ts: seq, record });
const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("live conversation registry", () => {
	let release: (() => void) | null = null;
	let n = 0;
	let convId = "";

	beforeEach(() => {
		vi.useFakeTimers();
		snapshotMock.mockReset();
		replayMock.mockReset();
		rpcMock.mockReset();
		fake.status.state = "open";
		convId = `c${++n}`;
	});
	afterEach(async () => {
		release?.();
		release = null;
		await vi.advanceTimersByTimeAsync(60_000);
		vi.useRealTimers();
	});

	it("buffers events during the snapshot load and applies only newer ones", async () => {
		let resolve!: (s: ConversationSnapshot) => void;
		snapshotMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		expect(entry.getView().phase).toBe("loading");
		const push = fake.handlers.get(`conv:${convId}`);
		expect(push).toBeDefined();
		push?.(ev(9, { type: "agent_start" }, convId));
		push?.(ev(11, { type: "agent_settled", aborted: false }, convId));
		resolve(snap(10, convId));
		await settle();
		const view = entry.getView();
		expect(view.phase).toBe("ready");
		expect(view.state.seq).toBe(11);
		expect(view.state.isRunning).toBe(false);
		expect(view.serverId).toBe("s1");
		expect(view.rpcState?.sessionId).toBe("sess");

		// agent_settled schedules a stats refresh
		rpcMock.mockResolvedValueOnce({ type: "response", command: "get_session_stats", success: true, data: { sessionId: "sess", cost: 1 }, seq: 11 } as never);
		await vi.advanceTimersByTimeAsync(500);
		expect(rpcMock).toHaveBeenCalledWith(convId, { command: { type: "get_session_stats" } });
		expect(entry.getView().stats?.cost).toBe(1);
	});

	it("fills gaps through /replay", async () => {
		snapshotMock.mockResolvedValueOnce(snap(5, convId));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		await settle();
		const push = fake.handlers.get(`conv:${convId}`);
		replayMock.mockResolvedValueOnce({ events: [ev(6, { type: "agent_start" }, convId)], complete: true, lastSeq: 7 });
		push?.(ev(7, { type: "queue_update", steering: ["x"], followUp: [] }, convId));
		await settle();
		expect(replayMock).toHaveBeenCalledWith(convId, 5);
		const state = entry.getView().state;
		expect(state.seq).toBe(7);
		expect(state.queue.steering).toEqual(["x"]);
	});

	it("falls back to a snapshot when the replay is incomplete", async () => {
		snapshotMock.mockResolvedValueOnce(snap(5, convId));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		await settle();
		replayMock.mockResolvedValueOnce({ events: [], complete: false, lastSeq: 40 });
		snapshotMock.mockResolvedValueOnce(snap(40, convId));
		fake.handlers.get(`conv:${convId}`)?.(ev(41, { type: "agent_start" }, convId));
		await settle();
		await settle();
		expect(snapshotMock).toHaveBeenCalledTimes(2);
		expect(entry.getView().state.seq).toBe(41);
	});

	it("resyncs on needsResync and on WS reconnect", async () => {
		snapshotMock.mockResolvedValue(snap(3, convId));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		await settle();
		fake.handlers.get(`conv:${convId}`)?.(ev(4, { type: "pi_web_session_changed", sessionId: "new" }, convId));
		expect(entry.getView().state.needsResync).toBe(true);
		snapshotMock.mockResolvedValueOnce(snap(4, convId));
		await vi.advanceTimersByTimeAsync(300);
		expect(snapshotMock).toHaveBeenCalledTimes(2);
		expect(entry.getView().state.needsResync).toBe(false);

		for (const l of fake.openListeners) l({ reconnect: true });
		await settle();
		expect(snapshotMock).toHaveBeenCalledTimes(3);
	});

	it("resyncs on the first open when the socket was still connecting at load", async () => {
		fake.status.state = "connecting";
		snapshotMock.mockResolvedValue(snap(3, convId));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		await settle();
		expect(snapshotMock).toHaveBeenCalledTimes(1);
		for (const l of fake.openListeners) l({ reconnect: false });
		await settle();
		expect(snapshotMock).toHaveBeenCalledTimes(2);
		// later first-generation opens (none in practice) and duplicates do not resync again
		for (const l of fake.openListeners) l({ reconnect: false });
		await settle();
		expect(snapshotMock).toHaveBeenCalledTimes(2);
		expect(entry.getView().phase).toBe("ready");
	});

	it("does not resync on the first open when the socket was already open", async () => {
		snapshotMock.mockResolvedValue(snap(3, convId));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		await settle();
		for (const l of fake.openListeners) l({ reconnect: false });
		await settle();
		expect(snapshotMock).toHaveBeenCalledTimes(1);
	});

	it("marks the conversation stale when its server's config is updated", async () => {
		snapshotMock.mockResolvedValue(snap(3, convId));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		await settle();
		const sync = fake.handlers.get("sync");
		expect(sync).toBeDefined();
		sync?.({ kind: "configUpdated", serverId: "other", at: 1 });
		expect(entry.getView().configStale).toBe(false);
		sync?.({ kind: "record", record: {} });
		sync?.({ kind: "configUpdated", serverId: "s1", at: 2 });
		expect(entry.getView().configStale).toBe(true);
	});

	it("keeps a config update that arrives while a snapshot is loading", async () => {
		let resolve!: (s: ConversationSnapshot) => void;
		snapshotMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		fake.handlers.get("sync")?.({ kind: "configUpdated", serverId: "s1", at: 2 });
		resolve(snap(3, convId)); // computed before the change: configStale false
		await settle();
		expect(entry.getView().configStale).toBe(true);
	});

	it("refreshes the workspace's file and git views after a tool finishes", async () => {
		snapshotMock.mockResolvedValue(snap(3, convId));
		const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
		try {
			const entry = getLiveConversation(convId);
			release = entry.retain();
			await settle();
			const push = fake.handlers.get(`conv:${convId}`);
			push?.(ev(4, { type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: {} }, convId));
			push?.(ev(5, { type: "tool_execution_end", toolCallId: "t1", toolName: "write", result: { content: [] }, isError: false }, convId));
			push?.(ev(6, { type: "agent_settled", aborted: false }, convId));
			expect(invalidate).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(400);
			// One debounced refresh for both records.
			expect(invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey)).toEqual([
				["workspaces", "w1", "git"],
				["workspaces", "w1", "fs"],
			]);
		} finally {
			invalidate.mockRestore();
		}
	});

	it("retries a snapshot that failed because the server was offline", async () => {
		snapshotMock.mockRejectedValueOnce(new ApiError(503, "AGENT_UNAVAILABLE", "服务器未连接"));
		snapshotMock.mockRejectedValueOnce(new ApiError(503, "AGENT_UNAVAILABLE", "服务器未连接"));
		snapshotMock.mockResolvedValue(snap(4, convId));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		await settle();
		expect(entry.getView()).toMatchObject({ phase: "error", error: "服务器未连接" });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(snapshotMock).toHaveBeenCalledTimes(2);
		expect(entry.getView().phase).toBe("error");
		await vi.advanceTimersByTimeAsync(4_000); // backoff doubles
		expect(entry.getView()).toMatchObject({ phase: "ready", error: null });
		expect(entry.getView().state.seq).toBe(4);
	});

	it("does not retry errors that will not go away", async () => {
		snapshotMock.mockRejectedValue(new ApiError(404, "NOT_FOUND", "对话不存在"));
		const entry = getLiveConversation(convId);
		release = entry.retain();
		await settle();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(snapshotMock).toHaveBeenCalledTimes(1);
		expect(entry.getView().error).toBe("对话不存在");
	});

	it("disposes 30s after the last release", async () => {
		snapshotMock.mockResolvedValue(snap(1, convId));
		const entry = getLiveConversation(convId);
		const r1 = entry.retain();
		await settle();
		r1();
		await vi.advanceTimersByTimeAsync(29_000);
		expect(getLiveConversation(convId)).toBe(entry);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fake.handlers.has(`conv:${convId}`)).toBe(false);
		expect(getLiveConversation(convId)).not.toBe(entry);
	});
});
