import { type AgentMessage, type AssistantMessage, type MessageTiming, type Usage, ZERO_USAGE } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import {
	contextSummary,
	estimateMessageTokens,
	estimateTextTokens,
	FirstSeen,
	groupThroughput,
	groupThroughputTitle,
	liveThroughput,
	liveThroughputText,
	messageThroughput,
	sameMessageTimings,
	sessionThroughput,
	throughputBasisNote,
	throughputCalibration,
	throughputText,
	trackSpan,
	usageFromMessages,
	usageFromStats,
} from "./usage";

describe("usageFromMessages", () => {
	it("sums assistant usage and counts tool calls", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "x", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "a" },
					{ type: "toolCall", id: "1", name: "bash", arguments: {} },
					{ type: "toolCall", id: "2", name: "read", arguments: {} },
				],
				api: "a",
				provider: "p",
				model: "m",
				usage: { ...ZERO_USAGE, input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: { ...ZERO_USAGE.cost, total: 0.25 } },
				stopReason: "toolUse",
				timestamp: 2,
			},
		];
		expect(usageFromMessages(messages)).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: 0.25, toolCalls: 2 });
	});

	it("maps session stats", () => {
		expect(
			usageFromStats({
				sessionId: "s",
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 4,
				toolResults: 4,
				totalMessages: 6,
				tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				cost: 0.5,
			}),
		).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, toolCalls: 4 });
	});
});

describe("contextSummary", () => {
	const base = { sessionId: "s", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
	it("uses pi's context usage", () => {
		expect(contextSummary({ ...base, contextUsage: { tokens: 68_100, contextWindow: 200_000, percent: 34 } })).toEqual({
			percent: 34,
			tokens: 68_100,
			window: 200_000,
			remaining: 131_900,
		});
	});

	it("tolerates unknown values", () => {
		expect(contextSummary({ ...base, contextUsage: { tokens: null, contextWindow: 200_000, percent: null } })).toEqual({
			percent: null,
			tokens: null,
			window: 200_000,
			remaining: null,
		});
		expect(contextSummary(null, 1000)).toEqual({ percent: null, tokens: null, window: 1000, remaining: null });
		expect(contextSummary({ ...base, contextUsage: { tokens: 500, contextWindow: 1000, percent: null } }).percent).toBe(50);
	});
});

describe("FirstSeen", () => {
	it("keeps the first time and evicts the oldest entry", () => {
		const seen = new FirstSeen(2);
		expect(seen.get("a", 1)).toBe(1);
		expect(seen.get("a", 5)).toBe(1);
		seen.get("b", 2);
		seen.get("c", 3);
		expect(seen.peek("a")).toBeUndefined();
		expect(seen.peek("c")).toBe(3);
	});
});

describe("trackSpan", () => {
	it("records start and end of an active block", () => {
		const store = new Map<string, { start: number; end?: number }>();
		expect(trackSpan(store, "k", false, 0)).toBeUndefined();
		expect(trackSpan(store, "k", true, 10)).toEqual({ start: 10 });
		expect(trackSpan(store, "k", true, 20)).toEqual({ start: 10 });
		expect(trackSpan(store, "k", false, 42)).toEqual({ start: 10, end: 42 });
		expect(trackSpan(store, "k", false, 99)).toEqual({ start: 10, end: 42 });
	});
});

function reply(ts: number, content: AssistantMessage["content"], usage: Partial<Usage> = {}, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content, api: "a", provider: "p", model: "m", usage: { ...ZERO_USAGE, ...usage }, stopReason: "stop", timestamp: ts, ...extra };
}

const text = (t: string) => [{ type: "text" as const, text: t }];

describe("messageThroughput", () => {
	it("uses the decode window of timed messages", () => {
		expect(messageThroughput(reply(1, text("a"), { output: 100 }, { durationMs: 9000 }), { ttftMs: 800, decodeMs: 2000 })).toEqual({
			tokens: 100,
			seconds: 2,
			rate: 50,
			ttftMs: 800,
			basis: "decode",
		});
	});

	it("leaves out reasoning that did not stream", () => {
		const timing: MessageTiming = { ttftMs: 3000, decodeMs: 1000 };
		expect(messageThroughput(reply(1, text("a"), { output: 300, reasoning: 200 }), timing)?.tokens).toBe(100);
		expect(messageThroughput(reply(1, [{ type: "thinking", thinking: "", redacted: true }, ...text("a")], { output: 300, reasoning: 200 }), timing)?.tokens).toBe(100);
		expect(
			messageThroughput(reply(1, [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }, ...text("a")], { output: 300, reasoning: 200 }), timing)?.tokens,
		).toBe(100);
		expect(messageThroughput(reply(1, [{ type: "thinking", thinking: "hmm" }, ...text("a")], { output: 300, reasoning: 200 }), timing)?.tokens).toBe(300);
		// Nothing visible left: the end-to-end duration over all output instead.
		expect(messageThroughput(reply(1, text(""), { output: 200, reasoning: 200 }, { durationMs: 4000 }), timing)).toEqual({
			tokens: 200,
			seconds: 4,
			rate: 50,
			ttftMs: 3000,
			basis: "total",
		});
	});

	it("falls back to durationMs", () => {
		expect(messageThroughput(reply(1, text("a"), { output: 100 }, { durationMs: 4000 }))).toEqual({ tokens: 100, seconds: 4, rate: 25, ttftMs: undefined, basis: "total" });
		// A decode window that is too short to measure.
		expect(messageThroughput(reply(1, text("a"), { output: 100 }, { durationMs: 4000 }), { ttftMs: 3900, decodeMs: 100 })).toEqual({
			tokens: 100,
			seconds: 4,
			rate: 25,
			ttftMs: 3900,
			basis: "total",
		});
	});

	it("is null without output, time or a complete response", () => {
		expect(messageThroughput(reply(1, text("a"), { output: 0 }, { durationMs: 4000 }), { ttftMs: 1, decodeMs: 1000 })).toBeNull();
		expect(messageThroughput(reply(1, text("a"), { output: 10 }))).toBeNull();
		expect(messageThroughput(reply(1, text("a"), { output: 10 }, { durationMs: 0 }), { ttftMs: 1, decodeMs: 50 })).toBeNull();
		expect(messageThroughput(reply(1, text("a"), { output: 3 }, { stopReason: "aborted", durationMs: 4000 }), { ttftMs: 1, decodeMs: 1000 })).toBeNull();
		expect(messageThroughput(reply(1, text("a"), { output: 3 }, { stopReason: "error", durationMs: 4000 }))).toBeNull();
	});
});

describe("groupThroughput / sessionThroughput", () => {
	const timings: Record<string, MessageTiming> = { "1": { ttftMs: 1000, decodeMs: 2000 }, "3": { ttftMs: 500, decodeMs: 1000 } };
	const messages: AgentMessage[] = [
		{ role: "user", content: "x", timestamp: 0 },
		reply(1, text("a"), { output: 100 }, { stopReason: "toolUse" }),
		{ role: "toolResult", toolCallId: "t", toolName: "bash", content: [], isError: false, timestamp: 2 },
		reply(3, text("b"), { output: 50 }, { stopReason: "toolUse" }),
		reply(4, text(""), { output: 0 }),
	];

	it("sums tokens and time and lists each counted message", () => {
		expect(groupThroughput(messages, timings)).toEqual({
			tokens: 150,
			seconds: 3,
			rate: 50,
			ttftMs: 750,
			basis: "decode",
			mixed: false,
			turns: [
				{ tokens: 100, seconds: 2, rate: 50, ttftMs: 1000, basis: "decode", index: 0 },
				{ tokens: 50, seconds: 1, rate: 50, ttftMs: 500, basis: "decode", index: 1 },
			],
		});
	});

	it("is an estimate as soon as one message is not timed", () => {
		const untimed = [...messages, reply(5, text("c"), { output: 150 }, { durationMs: 3000 })];
		const group = groupThroughput(untimed, timings);
		expect(group).toMatchObject({ tokens: 300, seconds: 6, rate: 50, ttftMs: 750, basis: "total", mixed: true });
		expect(group?.turns.map((t) => t.index)).toEqual([0, 1, 3]);
		expect(groupThroughput([reply(5, text("c"), { output: 150 }, { durationMs: 3000 })], undefined)).toMatchObject({ basis: "total", mixed: false, ttftMs: undefined });
		expect(sessionThroughput(untimed, timings)).toEqual({ tokens: 300, seconds: 6, rate: 50, ttftMs: 750, basis: "total", mixed: true });
	});

	it("is null when nothing has a throughput", () => {
		expect(groupThroughput([reply(1, text("a"), { output: 10 })], {})).toBeNull();
		expect(sessionThroughput([{ role: "user", content: "x", timestamp: 0 }], {})).toBeNull();
	});
});

describe("token heuristic", () => {
	it("counts CJK characters as one token and others as a quarter", () => {
		expect(estimateTextTokens("")).toBe(0);
		expect(estimateTextTokens("abcd")).toBe(1);
		expect(estimateTextTokens("你好")).toBe(2);
		expect(estimateTextTokens("你好，世界。abcdefgh")).toBe(8);
		expect(estimateTextTokens("こんにちは안녕")).toBe(7);
	});

	it("covers text, thinking and tool-call arguments", () => {
		const m = reply(1, [
			{ type: "thinking", thinking: "abcd" },
			{ type: "text", text: "你好" },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { a: 1 } },
		]);
		// '{"a":1}' is 7 characters.
		expect(estimateMessageTokens(m)).toBe(1 + 2 + 7 / 4);
		expect(estimateMessageTokens(reply(1, [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }]))).toBe(0);
		// Arguments still streaming replace the empty ones of the message.
		const streaming = reply(1, [{ type: "toolCall", id: "t1", name: "write", arguments: {} }]);
		expect(estimateMessageTokens(streaming)).toBe(0.5);
		expect(estimateMessageTokens(streaming, { t1: { path: "abcdefghi" } })).toBe(5);
	});
});

describe("throughputCalibration", () => {
	// 400 characters ≈ 100 estimated tokens.
	const long = text("x".repeat(400));

	it("is 1 without data", () => {
		expect(throughputCalibration([])).toBe(1);
		expect(throughputCalibration([reply(1, text("short"), { output: 30 })])).toBe(1);
		expect(throughputCalibration([reply(1, long, { output: 0 })])).toBe(1);
		expect(throughputCalibration([reply(1, long, { output: 3 }, { stopReason: "aborted" })])).toBe(1);
	});

	it("takes the median ratio of the latest messages, clamped", () => {
		expect(throughputCalibration([reply(1, long, { output: 120 }), reply(2, long, { output: 200 }), reply(3, long, { output: 80 })])).toBe(1.2);
		expect(throughputCalibration([reply(1, long, { output: 120 }), reply(2, long, { output: 80 })])).toBe(1);
		expect(throughputCalibration([reply(1, long, { output: 10_000 })])).toBe(4);
		expect(throughputCalibration([reply(1, long, { output: 1 })])).toBe(0.25);
		// Hidden reasoning is not part of the content.
		expect(throughputCalibration([reply(1, long, { output: 250, reasoning: 100 })])).toBe(1.5);
		// Only the last 10 assistant messages count.
		const old = Array.from({ length: 5 }, (_, i) => reply(i, long, { output: 400 }));
		const recent = Array.from({ length: 10 }, (_, i) => reply(10 + i, long, { output: 50 }));
		expect(throughputCalibration([...old, ...recent])).toBe(0.5);
	});
});

describe("liveThroughput", () => {
	const message = reply(100, text("x".repeat(400)), { output: 1 });

	it("waits for a measurable window after the first delta", () => {
		expect(liveThroughput(message, null)).toBeNull();
		expect(liveThroughput(message, { timestamp: 100 })).toBeNull();
		expect(liveThroughput(message, { timestamp: 100, firstDeltaAt: 1000, lastDeltaAt: 1299, outputAtFirstDelta: 1 })).toBeNull();
		expect(liveThroughput(message, { timestamp: 99, firstDeltaAt: 1000, lastDeltaAt: 3000, outputAtFirstDelta: 1 })).toBeNull();
	});

	it("estimates from the streamed content and the calibration", () => {
		expect(liveThroughput(message, { timestamp: 100, firstDeltaAt: 1000, lastDeltaAt: 3000, outputAtFirstDelta: 1 })).toEqual({
			tokens: 100,
			seconds: 2,
			rate: 50,
			estimated: true,
		});
		expect(liveThroughput(message, { timestamp: 100, firstDeltaAt: 1000, lastDeltaAt: 3000, outputAtFirstDelta: 1 }, 1.5)?.rate).toBe(75);
		const tool = reply(100, [{ type: "toolCall", id: "t1", name: "write", arguments: {} }]);
		expect(liveThroughput(tool, { timestamp: 100, firstDeltaAt: 0, lastDeltaAt: 1000, outputAtFirstDelta: 0 }, 1, { t1: { content: "x".repeat(386) } })?.tokens).toBe(100);
	});

	it("uses streamed usage once the provider updates it", () => {
		const updated = { ...message, usage: { ...message.usage, output: 61 } };
		expect(liveThroughput(updated, { timestamp: 100, firstDeltaAt: 1000, lastDeltaAt: 3000, outputAtFirstDelta: 1 })).toEqual({
			tokens: 60,
			seconds: 2,
			rate: 30,
			estimated: false,
		});
	});

	it("is null without content", () => {
		expect(liveThroughput(reply(100, text(""), { output: 0 }), { timestamp: 100, firstDeltaAt: 0, lastDeltaAt: 1000, outputAtFirstDelta: 0 })).toBeNull();
	});
});

describe("sameMessageTimings", () => {
	it("compares only the entries of the given messages", () => {
		const t1 = { ttftMs: 1, decodeMs: 2 };
		const views = [{ message: reply(1, text("a")) }];
		const a = { "1": t1 };
		expect(sameMessageTimings(views, a, a)).toBe(true);
		expect(sameMessageTimings(views, a, { "1": t1, "2": { ttftMs: 3, decodeMs: 4 } })).toBe(true);
		expect(sameMessageTimings(views, a, { "1": { ...t1 } })).toBe(false);
		expect(sameMessageTimings(views, {}, undefined)).toBe(true);
		expect(sameMessageTimings(views, a, undefined)).toBe(false);
	});
});

describe("throughput labels", () => {
	it("formats the meta line", () => {
		expect(throughputText({ tokens: 1234, seconds: 23.7, rate: 52.1, ttftMs: 800, basis: "decode" })).toBe("52 tok/s · 1.2k tokens · 首字 0.8s");
		expect(throughputText({ tokens: 320, seconds: 40, rate: 8, basis: "total" })).toBe("≈ 8.0 tok/s · 320 tokens");
		expect(liveThroughputText({ tokens: 96, seconds: 2, rate: 48, estimated: true })).toBe("≈ 48 tok/s · 生成中");
	});

	it("explains the basis and lists the turns", () => {
		expect(throughputBasisNote({ tokens: 1, seconds: 1, rate: 1, basis: "total" })).toBe("按总耗时估算，包含首字延迟");
		expect(throughputBasisNote({ tokens: 1, seconds: 1, rate: 1, basis: "total", mixed: true })).toBe("部分回复按总耗时估算，包含首字延迟");
		const group = groupThroughput(
			[reply(1, text("a"), { output: 320 }, { durationMs: 9000 }), reply(2, text("b"), { output: 100 }, { durationMs: 4000 })],
			{ "1": { ttftMs: 1100, decodeMs: 7111 } },
		);
		if (!group) throw new Error("expected a throughput");
		expect(groupThroughputTitle(group)).toBe(
			["部分回复按总耗时估算，包含首字延迟", "第 1 轮：320 tokens · 45 tok/s · 首字 1.1s", "第 2 轮：100 tokens · ≈ 25 tok/s"].join("\n"),
		);
		const single = groupThroughput([reply(1, text("a"), { output: 320 })], { "1": { ttftMs: 1100, decodeMs: 7111 } });
		if (!single) throw new Error("expected a throughput");
		expect(groupThroughputTitle(single)).toBe("按生成阶段计算：从首个输出到回复结束，不含首字延迟");
	});
});
