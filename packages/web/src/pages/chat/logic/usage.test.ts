import { type AgentMessage, ZERO_USAGE } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { contextSummary, FirstSeen, trackSpan, usageFromMessages, usageFromStats } from "./usage";

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
