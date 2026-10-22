import { type AgentMessage, type AssistantMessage, createConversationState, ZERO_USAGE } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { assistantGroupText, assistantViewsEqual, buildDisplayItems, hasRunningTool, parseStreamedArgs, resolveTool, toolViewEqual } from "./messages";

function assistant(ts: number, content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content, api: "x", provider: "p", model: "m", usage: ZERO_USAGE, stopReason: "toolUse", timestamp: ts, ...extra };
}

const user = (ts: number, text: string): AgentMessage => ({ role: "user", content: text, timestamp: ts });

describe("buildDisplayItems", () => {
	it("groups consecutive assistant messages and pairs tool results", () => {
		const messages: AgentMessage[] = [
			user(1, "hi"),
			assistant(2, [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "Looking" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			]),
			{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a\nb" }], isError: false, timestamp: 3 },
			assistant(4, [{ type: "text", text: "Done" }], { stopReason: "stop" }),
			{ role: "system", content: "x", timestamp: 5 },
			{ role: "custom", customType: "c", content: "hidden", display: false, timestamp: 6 },
			{ role: "custom", customType: "c", content: "shown", display: true, timestamp: 7 },
			{ role: "compactionSummary", summary: "s", tokensBefore: 10, timestamp: 8 },
		];
		const items = buildDisplayItems(createConversationState({ messages }));
		expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "custom", "compaction"]);
		const group = items[1];
		if (group.kind !== "assistant") throw new Error("expected assistant group");
		expect(group.messages).toHaveLength(2);
		expect(group.key).toBe("assistant-2");
		const parts = group.messages[0].parts;
		expect(parts.map((p) => p.kind)).toEqual(["thinking", "text", "tool"]);
		const tool = parts[2];
		if (tool.kind !== "tool") throw new Error("expected tool");
		expect(tool.tool.status).toBe("done");
		expect(tool.tool.output?.content).toEqual([{ type: "text", text: "a\nb" }]);
		expect(assistantGroupText(group.messages)).toBe("Looking\n\nDone");
	});

	it("uses live tool state and streaming arguments", () => {
		const streaming = assistant(10, [
			{ type: "text", text: "" },
			{ type: "toolCall", id: "t2", name: "bash", arguments: {} },
		]);
		const state = createConversationState({
			messages: [user(9, "go")],
			streaming,
			streamingToolArgs: { 1: '{"command": "npm te' },
			isRunning: true,
		});
		const items = buildDisplayItems(state);
		const group = items[1];
		if (group.kind !== "assistant") throw new Error("expected group");
		expect(group.messages[0].streaming).toBe(true);
		expect(group.messages[0].parts).toHaveLength(1);
		const tool = group.messages[0].parts[0];
		if (tool.kind !== "tool") throw new Error("expected tool");
		expect(tool.tool.status).toBe("pending");
		expect(tool.tool.argsStreaming).toBe(true);
		expect(tool.tool.args).toEqual({ command: "npm te" });
	});

	it("keeps the streaming message key when it is finalized", () => {
		const m = assistant(20, [{ type: "text", text: "x" }]);
		const before = buildDisplayItems(createConversationState({ messages: [user(19, "q")], streaming: m, isRunning: true }));
		const after = buildDisplayItems(createConversationState({ messages: [user(19, "q"), m] }));
		expect(before[1].key).toBe(after[1].key);
	});

	it("renders orphan tool results and marks unfinished calls as interrupted", () => {
		const messages: AgentMessage[] = [
			assistant(1, [{ type: "toolCall", id: "a", name: "read", arguments: { path: "x" } }], { stopReason: "aborted" }),
			{ role: "toolResult", toolCallId: "zzz", toolName: "ls", content: [], isError: true, timestamp: 2 },
		];
		const items = buildDisplayItems(createConversationState({ messages }));
		const group = items[0];
		if (group.kind !== "assistant") throw new Error("expected group");
		const part = group.messages[0].parts[0];
		if (part.kind !== "tool") throw new Error("expected tool");
		expect(part.tool.status).toBe("interrupted");
		expect(items[1]).toMatchObject({ kind: "tool", tool: { name: "ls", status: "error" } });
	});

	it("de-duplicates keys of messages with the same timestamp", () => {
		const items = buildDisplayItems(createConversationState({ messages: [user(1, "a"), assistant(2, [{ type: "text", text: "x" }]), user(1, "b")] }));
		expect(new Set(items.map((i) => i.key)).size).toBe(3);
	});
});

describe("resolveTool", () => {
	const call = { type: "toolCall" as const, id: "t", name: "bash", arguments: { command: "x" } };
	it("reports running partial output", () => {
		const view = resolveTool(
			call,
			undefined,
			{ toolCallId: "t", toolName: "bash", args: {}, status: "running", partialResult: { content: [{ type: "text", text: "..." }] } },
			{ messageStreaming: false, isRunning: true },
		);
		expect(view.status).toBe("running");
		expect(view.output?.content[0]).toEqual({ type: "text", text: "..." });
		const stale = resolveTool(
			call,
			undefined,
			{ toolCallId: "t", toolName: "bash", args: {}, status: "running" },
			{ messageStreaming: false, isRunning: false },
		);
		expect(stale.status).toBe("interrupted");
	});

	it("reports errors from the live state", () => {
		const view = resolveTool(
			call,
			undefined,
			{ toolCallId: "t", toolName: "bash", args: {}, status: "error", isError: true, result: { content: [] }, durationMs: 5 },
			{ messageStreaming: false, isRunning: true },
		);
		expect(view).toMatchObject({ status: "error", isError: true, durationMs: 5 });
	});
});

describe("hasRunningTool", () => {
	it("detects running executions", () => {
		expect(hasRunningTool({ tools: {} })).toBe(false);
		expect(hasRunningTool({ tools: { a: { toolCallId: "a", toolName: "bash", args: {}, status: "running" } } })).toBe(true);
	});
});

describe("memo helpers", () => {
	it("keeps tool views equal across rebuilds of an unchanged state", () => {
		const messages: AgentMessage[] = [
			assistant(1, [{ type: "toolCall", id: "t", name: "ls", arguments: { path: "." } }]),
			{ role: "toolResult", toolCallId: "t", toolName: "ls", content: [{ type: "text", text: "a" }], isError: false, timestamp: 2 },
		];
		const state = createConversationState({ messages });
		const a = buildDisplayItems(state)[0];
		const b = buildDisplayItems({ ...state, isRunning: true })[0];
		if (a.kind !== "assistant" || b.kind !== "assistant") throw new Error("expected groups");
		expect(assistantViewsEqual(a.messages, b.messages)).toBe(true);
		const pa = a.messages[0].parts[0];
		const pb = b.messages[0].parts[0];
		if (pa.kind !== "tool" || pb.kind !== "tool") throw new Error("expected tools");
		expect(toolViewEqual(pa.tool, pb.tool)).toBe(true);
		expect(toolViewEqual(pa.tool, { ...pb.tool, status: "error" })).toBe(false);
	});
});

describe("parseStreamedArgs", () => {
	it("re-parses large streaming arguments only after they grew noticeably", () => {
		const body = "x".repeat(20_000);
		const first = parseStreamedArgs("call-1", `{"path":"a.ts","content":"${body}`);
		expect(first).toEqual({ path: "a.ts", content: body });
		// A few more characters: the previous result is reused as is (stable identity, no re-parse).
		const next = parseStreamedArgs("call-1", `{"path":"a.ts","content":"${body}yyyy`);
		expect(next).toBe(first);
		const grown = parseStreamedArgs("call-1", `{"path":"a.ts","content":"${body}${"z".repeat(5000)}`);
		expect(grown).not.toBe(first);
		expect((grown?.content as string).length).toBe(25_000);
		// Small arguments are always current.
		expect(parseStreamedArgs("call-2", '{"command":"ls')).toEqual({ command: "ls" });
		expect(parseStreamedArgs("call-2", '{"command":"ls -la')).toEqual({ command: "ls -la" });
	});
});
