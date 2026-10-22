/** Usage numbers for the side panel: from get_session_stats when live, else summed from messages. */
import type { AgentMessage, AssistantMessage, SessionStats } from "@pi-web/shared";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	toolCalls: number;
}

/** Sums assistant usage and counts tool calls (read-only sessions have no stats). */
export function usageFromMessages(messages: readonly AgentMessage[]): UsageSummary {
	const sum: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, toolCalls: 0 };
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		const a = m as AssistantMessage;
		const u = a.usage;
		if (u) {
			sum.input += u.input || 0;
			sum.output += u.output || 0;
			sum.cacheRead += u.cacheRead || 0;
			sum.cacheWrite += u.cacheWrite || 0;
			sum.cost += u.cost?.total || 0;
		}
		if (Array.isArray(a.content)) sum.toolCalls += a.content.filter((c) => c?.type === "toolCall").length;
	}
	return sum;
}

export function usageFromStats(stats: SessionStats): UsageSummary {
	return {
		input: stats.tokens?.input ?? 0,
		output: stats.tokens?.output ?? 0,
		cacheRead: stats.tokens?.cacheRead ?? 0,
		cacheWrite: stats.tokens?.cacheWrite ?? 0,
		cost: stats.cost ?? 0,
		toolCalls: stats.toolCalls ?? 0,
	};
}

export interface ContextSummary {
	/** 0–100, null when unknown (e.g. right after a compaction). */
	percent: number | null;
	tokens: number | null;
	window: number | null;
	/** Tokens left before the window is full. */
	remaining: number | null;
}

export function contextSummary(stats: SessionStats | null | undefined, fallbackWindow?: number): ContextSummary {
	const usage = stats?.contextUsage;
	const window = usage?.contextWindow || fallbackWindow || null;
	const tokens = usage?.tokens ?? null;
	let percent = usage?.percent ?? null;
	if (percent === null && tokens !== null && window) percent = (tokens / window) * 100;
	if (percent !== null) percent = Math.max(0, Math.min(100, percent));
	return { percent, tokens, window, remaining: tokens !== null && window ? Math.max(0, window - tokens) : null };
}

/**
 * Remembers when something was first seen on this client (dialog timeouts, running tools,
 * thinking blocks). Values never change once set, so calling it during render is idempotent.
 */
export class FirstSeen {
	private readonly times = new Map<string, number>();
	constructor(private readonly max = 2000) {}

	get(key: string, now: number = Date.now()): number {
		let t = this.times.get(key);
		if (t === undefined) {
			t = now;
			this.times.set(key, t);
			if (this.times.size > this.max) {
				const oldest = this.times.keys().next().value;
				if (oldest !== undefined) this.times.delete(oldest);
			}
		}
		return t;
	}

	peek(key: string): number | undefined {
		return this.times.get(key);
	}
}

/**
 * Tracks how long a streaming block (thinking) was active: `active` marks it running, the
 * first call with active=false after that records the end. Returns undefined when the block
 * was never seen active on this client (history loaded from disk).
 */
export function trackSpan(
	store: Map<string, { start: number; end?: number }>,
	key: string,
	active: boolean,
	now: number = Date.now(),
): { start: number; end?: number } | undefined {
	let span = store.get(key);
	if (active) {
		if (!span) {
			span = { start: now };
			store.set(key, span);
		}
		return span;
	}
	if (span && span.end === undefined) {
		span = { ...span, end: now };
		store.set(key, span);
	}
	return span;
}
