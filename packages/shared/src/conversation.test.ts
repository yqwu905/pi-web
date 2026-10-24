import { describe, expect, it } from "vitest";
import type { ConvRecord } from "./agent-protocol.js";
import {
	applyConvRecord,
	createConversationState,
	entriesToMessages,
	MAX_TIMED_MESSAGES,
	type ConversationState,
	type MessageTiming,
} from "./conversation.js";
import type { AssistantMessage, SessionEntry } from "./pi.js";

function run(records: ConvRecord[], start: ConversationState = createConversationState()): ConversationState {
	return records.reduce((s, r, i) => applyConvRecord(s, r, start.seq + i + 1), start);
}

/** Like run(), with each record's ConvEvent.ts. */
function runTimed(records: Array<[ConvRecord, number]>, start: ConversationState = createConversationState()): ConversationState {
	return records.reduce((s, [r, ts], i) => applyConvRecord(s, r, start.seq + i + 1, ts), start);
}

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const T = 1_700_000_000_000;

function assistantAt(timestamp: number, partial: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content: [], api: "x", provider: "p", model: "m", usage, stopReason: "stop", timestamp, ...partial };
}

/** One streamed assistant message (request start `timestamp`), each record at `timestamp + offset` ms. */
function timedTurn(timestamp: number, offsets = { start: 5, firstDelta: 200, delta: 400, end: 900 }): Array<[ConvRecord, number]> {
	const final = assistantAt(timestamp, { content: [{ type: "text", text: "Hello world" }] });
	return [
		[{ type: "message_start", message: assistantAt(timestamp, { stopReason: "pending" }) }, timestamp + offsets.start],
		[{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }, timestamp + offsets.start + 1],
		[{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" } }, timestamp + offsets.start + 2],
		[
			{ type: "message_update", usage: { ...usage, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " } },
			timestamp + offsets.firstDelta,
		],
		[
			{ type: "message_update", usage: { ...usage, output: 7 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" } },
			timestamp + offsets.delta,
		],
		[{ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello world" } }, timestamp + offsets.delta + 1],
		[{ type: "message_end", message: final }, timestamp + offsets.end],
	];
}

describe("conversation reducer", () => {
	it("reconstructs a streamed assistant turn with a tool call", () => {
		const user = { role: "user" as const, content: "hi", timestamp: 1 };
		const final: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "Hello world" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
			],
			api: "x",
			provider: "p",
			model: "m",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		};
		let s = run([
			{ type: "agent_start" },
			{ type: "message_start", message: user },
			{ type: "message_end", message: user },
			{ type: "message_start", message: { ...final, content: [], stopReason: "pending" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "m" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello " } },
			{ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "world" } },
			{ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "bash" } },
			{ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"command":' } },
		]);
		expect(s.isRunning).toBe(true);
		expect(s.messages).toHaveLength(1);
		expect(s.streaming?.content[0]).toEqual({ type: "thinking", thinking: "hmm" });
		expect(s.streaming?.content[1]).toEqual({ type: "text", text: "Hello world" });
		expect(s.streaming?.usage).toEqual(usage);
		expect(s.streamingToolArgs[2]).toBe('{"command":');
		s = run(
			[
				{ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: final.content[2] as never } },
				{ type: "message_end", message: final },
				{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
				{ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: { command: "ls" }, partialResult: { content: [{ type: "text", text: "a" }] } },
				{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a\nb" }] }, isError: false, durationMs: 5 },
				{ type: "agent_settled", aborted: false },
			],
			s,
		);
		expect(s.streaming).toBeNull();
		expect(s.messages).toHaveLength(2);
		expect(s.messages[1]).toEqual(final);
		expect(s.tools.c1).toMatchObject({ status: "done", durationMs: 5, args: { command: "ls" } });
		expect(s.isRunning).toBe(false);
		expect(s.streamingToolArgs).toEqual({});
	});

	it("ignores already-applied seqs and dedupes messages", () => {
		const user = { role: "user" as const, content: "x", timestamp: 5 };
		let s = applyConvRecord(createConversationState(), { type: "message_end", message: user }, 3);
		s = applyConvRecord(s, { type: "message_end", message: user }, 3);
		s = applyConvRecord(s, { type: "message_end", message: user }, 4);
		expect(s.messages).toHaveLength(1);
		expect(s.seq).toBe(4);
	});

	it("tracks extension UI dialogs, statuses and resolution", () => {
		let s = run([
			{ type: "extension_ui_request", id: "d1", method: "confirm", title: "OK?" },
			{ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "ext", statusText: "busy" },
			{ type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "pi-web:result", statusText: "{}" },
			{ type: "extension_ui_request", id: "n1", method: "notify", message: "hey", notifyType: "warning" },
		]);
		expect(s.ui.pending.map((p) => p.id)).toEqual(["d1"]);
		expect(s.ui.statuses).toEqual({ ext: "busy" });
		expect(s.ui.notifications[0]).toMatchObject({ message: "hey", notifyType: "warning" });
		s = run([{ type: "pi_web_ui_resolved", id: "d1" }], s);
		expect(s.ui.pending).toHaveLength(0);
	});

	it("builds display messages from session entries on the active branch", () => {
		const entries: SessionEntry[] = [
			{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "q", timestamp: 1 } },
			{ type: "compaction", id: "b", parentId: "a", timestamp: "2026-01-01T00:01:00Z", summary: "S", firstKeptEntryId: "a", tokensBefore: 10 },
			{ type: "message", id: "c", parentId: "b", timestamp: "2026-01-01T00:02:00Z", message: { role: "user", content: "abandoned", timestamp: 2 } },
			{ type: "message", id: "d", parentId: "b", timestamp: "2026-01-01T00:03:00Z", message: { role: "user", content: "kept", timestamp: 3 } },
		];
		const messages = entriesToMessages(entries, ["a", "b", "d"]);
		expect(messages.map((m) => m.role)).toEqual(["user", "compactionSummary", "user"]);
	});
});

describe("generation timing", () => {
	it("times a streamed assistant message from event timestamps", () => {
		const turn = timedTurn(T);
		let s = runTimed(turn.slice(0, 3));
		// Starts and empty deltas are not output.
		expect(s.timing.streaming).toEqual({ timestamp: T });
		s = runTimed(turn.slice(3, 5), s);
		expect(s.timing.streaming).toEqual({ timestamp: T, firstDeltaAt: T + 200, lastDeltaAt: T + 400, outputAtFirstDelta: 0 });
		expect(s.timing.messages).toEqual({});
		const timing = s.timing;
		s = runTimed([[{ type: "queue_update", steering: [], followUp: [] }, T + 450]], s);
		expect(s.timing).toBe(timing);
		s = runTimed(turn.slice(5), s);
		expect(s.timing.streaming).toBeNull();
		expect(s.timing.messages).toEqual({ [String(T)]: { ttftMs: 200, decodeMs: 700 } });
		expect(s.streaming).toBeNull();
		expect(s.messages).toHaveLength(1);
	});

	it("records nothing without event timestamps but still ends the streaming entry", () => {
		const records = timedTurn(T).map(([r]) => r);
		let s = run(records.slice(0, -1));
		expect(s.timing.streaming).toEqual({ timestamp: T });
		s = run(records.slice(-1), s);
		expect(s.timing).toEqual({ streaming: null, messages: {} });
		// A non-finite ts counts as none.
		s = runTimed(timedTurn(T + 10_000).map(([r]) => [r, Number.NaN]));
		expect(s.timing).toEqual({ streaming: null, messages: {} });
	});

	it("keeps the usage.output of the first delta and times thinking and tool-call deltas", () => {
		const s = runTimed([
			[{ type: "message_start", message: assistantAt(T, { stopReason: "pending" }) }, T],
			[{ type: "message_update", usage: { ...usage, output: 3 }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" } }, T + 50],
			[{ type: "message_update", usage: { ...usage, output: 40 }, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "bash" } }, T + 60],
			[{ type: "message_update", usage: { ...usage, output: 41 }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{" } }, T + 70],
		]);
		expect(s.timing.streaming).toEqual({ timestamp: T, firstDeltaAt: T + 50, lastDeltaAt: T + 70, outputAtFirstDelta: 3 });
		// Without usage on the first delta.
		const t = runTimed(
			timedTurn(T)
				.slice(0, 4)
				.map(([r, ts]): [ConvRecord, number] => [r.type === "message_update" ? { ...r, usage: undefined } : r, ts]),
		);
		expect(t.timing.streaming?.outputAtFirstDelta).toBe(0);
	});

	it("bounds finalized timings, dropping the oldest", () => {
		const messages: Record<string, MessageTiming> = {};
		for (let i = 0; i < MAX_TIMED_MESSAGES; i++) messages[String(T + i * 1000)] = { ttftMs: i, decodeMs: i };
		const start = createConversationState({ timing: { streaming: null, messages } });
		let s = runTimed(timedTurn(T + MAX_TIMED_MESSAGES * 1000), start);
		let keys = Object.keys(s.timing.messages);
		expect(keys).toHaveLength(MAX_TIMED_MESSAGES);
		expect(keys[0]).toBe(String(T + 1000));
		expect(keys.at(-1)).toBe(String(T + MAX_TIMED_MESSAGES * 1000));
		expect(start.timing.messages[String(T)]).toEqual({ ttftMs: 0, decodeMs: 0 });
		// Timing the same message again makes it the newest.
		s = runTimed(timedTurn(T + 1000, { start: 1, firstDelta: 10, delta: 20, end: 30 }), s);
		keys = Object.keys(s.timing.messages);
		expect(keys).toHaveLength(MAX_TIMED_MESSAGES);
		expect(keys[0]).toBe(String(T + 2000));
		expect(keys.at(-1)).toBe(String(T + 1000));
		expect(s.timing.messages[String(T + 1000)]).toEqual({ ttftMs: 10, decodeMs: 20 });
	});

	it("only times deltas and ends of the message being streamed", () => {
		// message_end of a different message: nothing recorded, streaming entry cleared.
		const turn = timedTurn(T);
		const other: [ConvRecord, number] = [{ type: "message_end", message: assistantAt(T + 1) }, T + 900];
		let s = runTimed([...turn.slice(0, -1), other]);
		expect(s.timing).toEqual({ streaming: null, messages: {} });

		// Streaming known (e.g. a snapshot from an older agent) but no timing entry: starts at the next delta.
		const snapshotted = createConversationState({ streaming: assistantAt(T, { stopReason: "pending" }) });
		s = runTimed(turn.slice(4), snapshotted);
		expect(s.timing.messages).toEqual({ [String(T)]: { ttftMs: 400, decodeMs: 500 } });

		// A stale entry for another message is replaced.
		const stale = createConversationState({
			streaming: assistantAt(T, { stopReason: "pending" }),
			timing: { streaming: { timestamp: T - 5000, firstDeltaAt: T - 4000, lastDeltaAt: T - 3000, outputAtFirstDelta: 9 }, messages: {} },
		});
		s = runTimed(turn.slice(3, 4), stale);
		expect(s.timing.streaming).toEqual({ timestamp: T, firstDeltaAt: T + 200, lastDeltaAt: T + 200, outputAtFirstDelta: 0 });

		// No streaming message at all: nothing to time.
		s = runTimed(turn.slice(3, 4));
		expect(s.timing.streaming).toBeNull();
	});

	it("ends the streaming entry where streaming ends and keeps finalized timings", () => {
		const done = runTimed(timedTurn(T));
		const midStream = runTimed(timedTurn(T + 10_000).slice(0, 4), done);
		expect(midStream.timing.streaming?.firstDeltaAt).toBe(T + 10_200);
		const ends: ConvRecord[] = [
			{ type: "agent_settled", aborted: true },
			{ type: "pi_web_exit", code: 1, signal: null, stderrTail: "" },
			{ type: "pi_web_session_changed", sessionId: "s2" },
		];
		for (const record of ends) {
			const s = runTimed([[record, T + 10_300]], midStream);
			expect(s.streaming).toBeNull();
			expect(s.timing).toEqual({ streaming: null, messages: done.timing.messages });
		}
		// Nothing streaming: the timing object is kept as is.
		expect(runTimed([[{ type: "agent_settled", aborted: false }, T + 1000]], done).timing).toBe(done.timing);
	});
});
