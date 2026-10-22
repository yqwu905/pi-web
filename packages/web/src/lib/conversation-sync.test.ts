import type { ConvEvent, ConvSnapshot } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { applyEvents, classifyEvent, containsSettled, stateFromSessionFile, stateFromSnapshot } from "./conversation-sync";

function snapshot(partial: Partial<ConvSnapshot> = {}): ConvSnapshot {
	return {
		info: {
			convId: "c1",
			cwd: "/w",
			status: "running",
			sessionName: "修复泄漏",
			startedAt: 1,
			lastActivityAt: 2,
			lastSeq: 10,
			pendingUi: [],
			statuses: {},
			widgets: {},
		},
		state: {
			thinkingLevel: "medium",
			isStreaming: true,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "s1",
			autoCompactionEnabled: true,
			messageCount: 1,
			pendingMessageCount: 0,
		},
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
		streaming: null,
		streamingToolArgs: {},
		runningTools: [{ toolCallId: "t1", toolName: "bash", args: { command: "ls" }, status: "running" }],
		queue: { steering: ["later"], followUp: [] },
		ui: { pending: [], statuses: { meter: "18k" }, widgets: {}, notifications: [] },
		isRunning: true,
		isCompacting: false,
		seq: 10,
		...partial,
	};
}

const ev = (seq: number, record: ConvEvent["record"]): ConvEvent => ({ convId: "c1", seq, ts: seq, record });

describe("stateFromSnapshot", () => {
	it("maps snapshot fields onto ConversationState", () => {
		const s = stateFromSnapshot(snapshot());
		expect(s.seq).toBe(10);
		expect(s.messages).toHaveLength(1);
		expect(s.tools.t1.status).toBe("running");
		expect(s.queue.steering).toEqual(["later"]);
		expect(s.ui.statuses.meter).toBe("18k");
		expect(s.isRunning).toBe(true);
		expect(s.sessionName).toBe("修复泄漏");
		expect(s.thinkingLevel).toBe("medium");
		expect(s.status).toBe("running");
		expect(s.exited).toBeUndefined();
		expect(s.needsResync).toBe(false);
	});
	it("marks exited conversations", () => {
		const base = snapshot();
		const s = stateFromSnapshot({ ...base, info: { ...base.info, status: "exited", exitCode: 1 } });
		expect(s.exited).toEqual({ code: 1, signal: null, stderrTail: "" });
	});
});

describe("event application", () => {
	it("classifies events by seq", () => {
		expect(classifyEvent(10, 9)).toBe("stale");
		expect(classifyEvent(10, 10)).toBe("stale");
		expect(classifyEvent(10, 11)).toBe("apply");
		expect(classifyEvent(10, 13)).toBe("gap");
	});
	it("applies only newer events, in order", () => {
		const s0 = stateFromSnapshot(snapshot());
		const s1 = applyEvents(s0, [
			ev(12, { type: "agent_settled", aborted: false }),
			ev(9, { type: "agent_start" }),
			ev(11, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [] }, isError: false }),
		]);
		expect(s1.seq).toBe(12);
		expect(s1.tools.t1.status).toBe("done");
		expect(s1.isRunning).toBe(false);
		expect(applyEvents(s1, [])).toBe(s1);
	});
	it("flags resync on session changes", () => {
		const s = applyEvents(stateFromSnapshot(snapshot()), [ev(11, { type: "pi_web_session_changed", sessionId: "s2" })]);
		expect(s.needsResync).toBe(true);
	});
	it("detects settled batches", () => {
		expect(containsSettled([ev(1, { type: "agent_start" })])).toBe(false);
		expect(containsSettled([ev(1, { type: "agent_settled", aborted: true })])).toBe(true);
	});
});

describe("stateFromSessionFile", () => {
	it("builds messages from the active branch", () => {
		const s = stateFromSessionFile(
			{
				header: null,
				leafId: "b",
				branchIds: ["a", "b"],
				entries: [
					{ type: "message", id: "a", parentId: null, timestamp: "2026-10-22T09:00:00Z", message: { role: "user", content: "q", timestamp: 1 } },
					{ type: "message", id: "x", parentId: "a", timestamp: "2026-10-22T09:00:01Z", message: { role: "user", content: "other", timestamp: 2 } },
					{ type: "compaction", id: "b", parentId: "a", timestamp: "2026-10-22T09:00:02Z", summary: "sum", firstKeptEntryId: "a", tokensBefore: 100 },
				],
			},
			"名字",
		);
		expect(s.messages.map((m) => m.role)).toEqual(["user", "compactionSummary"]);
		expect(s.sessionName).toBe("名字");
		expect(s.seq).toBe(0);
	});
});
