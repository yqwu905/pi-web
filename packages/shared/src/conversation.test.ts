import { describe, expect, it } from "vitest";
import type { ConvRecord } from "./agent-protocol.js";
import { applyConvRecord, createConversationState, entriesToMessages, type ConversationState } from "./conversation.js";
import type { AssistantMessage, SessionEntry } from "./pi.js";

function run(records: ConvRecord[], start: ConversationState = createConversationState()): ConversationState {
	return records.reduce((s, r, i) => applyConvRecord(s, r, start.seq + i + 1), start);
}

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

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
