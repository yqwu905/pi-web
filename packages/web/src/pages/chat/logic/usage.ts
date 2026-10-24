/** Usage numbers for the side panel: from get_session_stats when live, else summed from messages. */
import type { AgentMessage, AssistantMessage, MessageTiming, SessionStats, StreamingTiming } from "@pi-web/shared";
import { formatDuration, formatTokenRate, formatTokens } from "../../../lib/format";

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

// ---------- throughput ----------

/** Output throughput of an assistant message, or of several summed. */
export interface Throughput {
	tokens: number;
	seconds: number;
	/** tokens / seconds. */
	rate: number;
	/** Request start → first streamed output, ms (the average for several); timed messages only. */
	ttftMs?: number;
	/**
	 * decode: first streamed output → end of the message (agent host clock);
	 * total: pi's end-to-end durationMs, which also covers the time to first token and retries.
	 */
	basis: "decode" | "total";
}

export interface TurnThroughput extends Throughput {
	/** Position of the message among the assistant messages it was aggregated with (0-based). */
	index: number;
}

/** Σtokens / Σseconds over the counted messages; basis "decode" only when every one was. */
export interface AggregateThroughput extends Throughput {
	/** Some, but not all, counted messages were measured on the decode basis. */
	mixed: boolean;
}

export interface GroupThroughput extends AggregateThroughput {
	/** Each counted message, in order (tooltip). */
	turns: TurnThroughput[];
}

export interface LiveThroughput {
	tokens: number;
	seconds: number;
	rate: number;
	/** True when the tokens come from the content heuristic (the provider does not stream usage). */
	estimated: boolean;
}

/** Shorter decode windows are too noisy (tiny or non-streamed responses): durationMs is used instead. */
const MIN_DECODE_MS = 200;
/** A live estimate needs at least this much time between the first and the latest delta. */
const MIN_LIVE_WINDOW_MS = 300;
/** Finalized messages the live estimate is calibrated on, and the bounds of that ratio. */
const CALIBRATION_MESSAGES = 10;
const CALIBRATION_MIN = 0.25;
const CALIBRATION_MAX = 4;
/** Messages with less estimated content do not calibrate: their per-message overhead tokens dominate. */
const CALIBRATION_MIN_ESTIMATE = 16;

/** Usage of an interrupted response is incomplete (often only the provider's initial value). */
function interrupted(message: AssistantMessage): boolean {
	return message.stopReason === "aborted" || message.stopReason === "error";
}

/**
 * Output tokens that streamed as visible content: usage.output (which includes reasoning) minus
 * the reasoning tokens when the provider kept that reasoning hidden (no thinking text; a redacted
 * block only holds pi's placeholder).
 */
function visibleOutputTokens(message: AssistantMessage): number {
	const output = message.usage?.output ?? 0;
	const reasoning = message.usage?.reasoning ?? 0;
	if (!(reasoning > 0)) return output;
	const content = Array.isArray(message.content) ? message.content : [];
	return content.some((c) => c?.type === "thinking" && !c.redacted && Boolean(c.thinking)) ? output : output - reasoning;
}

/**
 * Throughput of a finalized assistant message: over its decode window when it was timed (and the
 * window is long enough), else over pi's end-to-end durationMs. Null without output or time.
 */
export function messageThroughput(message: AssistantMessage, timing?: MessageTiming): Throughput | null {
	const output = message.usage?.output ?? 0;
	if (!(output > 0) || interrupted(message)) return null;
	const ttftMs = timing && Number.isFinite(timing.ttftMs) ? timing.ttftMs : undefined;
	if (timing && timing.decodeMs >= MIN_DECODE_MS) {
		const tokens = visibleOutputTokens(message);
		if (tokens > 0) {
			const seconds = timing.decodeMs / 1000;
			return { tokens, seconds, rate: tokens / seconds, ttftMs, basis: "decode" };
		}
	}
	const duration = message.durationMs;
	if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return null;
	const seconds = duration / 1000;
	return { tokens: output, seconds, rate: output / seconds, ttftMs, basis: "total" };
}

function aggregateThroughput(list: readonly Throughput[]): AggregateThroughput | null {
	let tokens = 0;
	let seconds = 0;
	let ttftSum = 0;
	let ttftCount = 0;
	let decoded = 0;
	for (const t of list) {
		tokens += t.tokens;
		seconds += t.seconds;
		if (t.ttftMs !== undefined) {
			ttftSum += t.ttftMs;
			ttftCount++;
		}
		if (t.basis === "decode") decoded++;
	}
	if (list.length === 0 || seconds <= 0) return null;
	return {
		tokens,
		seconds,
		rate: tokens / seconds,
		ttftMs: ttftCount > 0 ? ttftSum / ttftCount : undefined,
		basis: decoded === list.length ? "decode" : "total",
		mixed: decoded > 0 && decoded < list.length,
	};
}

function assistantThroughputs(messages: readonly AgentMessage[], timings: Readonly<Record<string, MessageTiming>> | undefined): TurnThroughput[] {
	const turns: TurnThroughput[] = [];
	let index = 0;
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		const a = m as AssistantMessage;
		const t = messageThroughput(a, timings?.[String(a.timestamp)]);
		if (t) turns.push({ ...t, index });
		index++;
	}
	return turns;
}

/** Throughput of an assistant group (one agent run) with each counted message; null when none has one. */
export function groupThroughput(
	messages: readonly AgentMessage[],
	timings: Readonly<Record<string, MessageTiming>> | undefined,
): GroupThroughput | null {
	const turns = assistantThroughputs(messages, timings);
	const total = aggregateThroughput(turns);
	return total ? { ...total, turns } : null;
}

/** Average throughput over every assistant message of the session (side panel). */
export function sessionThroughput(
	messages: readonly AgentMessage[],
	timings: Readonly<Record<string, MessageTiming>> | undefined,
): AggregateThroughput | null {
	return aggregateThroughput(assistantThroughputs(messages, timings));
}

/** CJK ideographs and punctuation, kana, hangul and full-width forms: about one token per character. */
function isCjk(code: number): boolean {
	return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef);
}

/** Rough token count of a text: CJK characters ≈ 1 token each, other characters ≈ 1/4 token each. */
export function estimateTextTokens(text: string): number {
	let cjk = 0;
	for (let i = 0; i < text.length; i++) if (isCjk(text.charCodeAt(i))) cjk++;
	return cjk + (text.length - cjk) / 4;
}

/**
 * estimateTextTokens of what an assistant message generated: text, thinking text (not the placeholder
 * of redacted thinking) and tool-call arguments as JSON. `toolArgs` (by tool-call id) stands in for
 * arguments that are still streaming.
 */
export function estimateMessageTokens(message: AssistantMessage, toolArgs?: Readonly<Record<string, unknown>>): number {
	let tokens = 0;
	for (const block of Array.isArray(message.content) ? message.content : []) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text") tokens += estimateTextTokens(block.text ?? "");
		else if (block.type === "thinking") tokens += block.redacted ? 0 : estimateTextTokens(block.thinking ?? "");
		else if (block.type === "toolCall") {
			const args = (block.id ? toolArgs?.[block.id] : undefined) ?? block.arguments ?? {};
			tokens += estimateTextTokens(JSON.stringify(args) || "");
		}
	}
	return tokens;
}

const finalEstimates = new WeakMap<AssistantMessage, number>();

/** estimateMessageTokens of a finalized (immutable) message, computed once. */
function finalEstimate(message: AssistantMessage): number {
	let n = finalEstimates.get(message);
	if (n === undefined) {
		n = estimateMessageTokens(message);
		finalEstimates.set(message, n);
	}
	return n;
}

/**
 * Real-to-estimated output tokens of this model and content: the median over the last up to 10
 * finalized assistant messages, clamped to [0.25, 4]; 1 without data. Live estimates use it.
 */
export function throughputCalibration(messages: readonly AgentMessage[]): number {
	const ratios: number[] = [];
	let seen = 0;
	for (let i = messages.length - 1; i >= 0 && seen < CALIBRATION_MESSAGES; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		seen++;
		const a = m as AssistantMessage;
		if (interrupted(a)) continue;
		const tokens = visibleOutputTokens(a);
		const estimate = finalEstimate(a);
		if (tokens > 0 && estimate >= CALIBRATION_MIN_ESTIMATE) ratios.push(tokens / estimate);
	}
	if (ratios.length === 0) return 1;
	ratios.sort((x, y) => x - y);
	const mid = Math.floor(ratios.length / 2);
	const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
	return Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, median));
}

/**
 * Throughput of the message being streamed, over its first → latest delta (null until that window
 * reaches 300 ms). Tokens are the provider's own when its streamed usage grew since the first
 * delta, else the content heuristic times `calibration`.
 */
export function liveThroughput(
	message: AssistantMessage | null | undefined,
	timing: StreamingTiming | null | undefined,
	calibration = 1,
	toolArgs?: Readonly<Record<string, unknown>>,
): LiveThroughput | null {
	if (!message || !timing || timing.timestamp !== message.timestamp) return null;
	const { firstDeltaAt, lastDeltaAt, outputAtFirstDelta } = timing;
	if (firstDeltaAt === undefined || lastDeltaAt === undefined || !(lastDeltaAt - firstDeltaAt >= MIN_LIVE_WINDOW_MS)) return null;
	const seconds = (lastDeltaAt - firstDeltaAt) / 1000;
	const output = message.usage?.output ?? 0;
	if (outputAtFirstDelta !== undefined && output > outputAtFirstDelta) {
		// Only what streamed after the first delta: hidden reasoning before it is not in the window.
		const tokens = output - outputAtFirstDelta;
		return { tokens, seconds, rate: tokens / seconds, estimated: false };
	}
	const tokens = estimateMessageTokens(message, toolArgs) * calibration;
	if (!(tokens > 0)) return null;
	return { tokens, seconds, rate: tokens / seconds, estimated: true };
}

/** True when both timing maps hold the same entry for each message (memo comparators of assistant groups). */
export function sameMessageTimings(
	views: ReadonlyArray<{ message: AssistantMessage }>,
	a: Readonly<Record<string, MessageTiming>> | undefined,
	b: Readonly<Record<string, MessageTiming>> | undefined,
): boolean {
	if (a === b) return true;
	for (const { message } of views) {
		const key = String(message.timestamp);
		if (a?.[key] !== b?.[key]) return false;
	}
	return true;
}

/** "52 tok/s", or "≈ 52 tok/s" when (partly) measured over the end-to-end duration. */
export function throughputRateText(t: Throughput): string {
	return `${t.basis === "decode" ? "" : "≈ "}${formatTokenRate(t.rate)}`;
}

/** Meta line of an assistant group: "52 tok/s · 1.2k tokens · 首字 0.8s". */
export function throughputText(t: Throughput): string {
	const parts = [throughputRateText(t), `${formatTokens(t.tokens)} tokens`];
	if (t.ttftMs !== undefined) parts.push(`首字 ${formatDuration(t.ttftMs)}`);
	return parts.join(" · ");
}

/** What the rate is measured over (tooltips). */
export function throughputBasisNote(t: Throughput & { mixed?: boolean }): string {
	if (t.basis === "decode") return "按生成阶段计算：从首个输出到回复结束，不含首字延迟";
	return t.mixed ? "部分回复按总耗时估算，包含首字延迟" : "按总耗时估算，包含首字延迟";
}

/** Tooltip of a group's meta line: the basis, then each turn ("第 1 轮：320 tokens · 45 tok/s · 首字 1.1s"). */
export function groupThroughputTitle(t: GroupThroughput): string {
	const lines = [throughputBasisNote(t)];
	if (t.turns.length > 1) {
		for (const turn of t.turns) {
			const parts = [`${formatTokens(turn.tokens)} tokens`, throughputRateText(turn)];
			if (turn.ttftMs !== undefined) parts.push(`首字 ${formatDuration(turn.ttftMs)}`);
			lines.push(`第 ${turn.index + 1} 轮：${parts.join(" · ")}`);
		}
	}
	return lines.join("\n");
}

/** Meta line while a reply streams: "≈ 48 tok/s · 生成中". */
export function liveThroughputText(t: LiveThroughput): string {
	return `≈ ${formatTokenRate(t.rate)} · 生成中`;
}
