/**
 * Turns a ConversationState into display items: consecutive assistant messages form one
 * group, tool calls are paired with their toolResult (by toolCallId) and with the live
 * execution state in `state.tools`, and hidden roles (system, display=false custom) drop out.
 */
import type {
	AgentMessage,
	AssistantMessage,
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	ConversationState,
	CustomMessage,
	ToolCall,
	ToolExecutionState,
	ToolResultMessage,
	ToolResultPayload,
	UserMessage,
} from "@pi-web/shared";
import { parsePartialJson } from "./tools";

/**
 * pending: arguments still streaming or waiting to run; running; done; error;
 * interrupted: the run ended without a result (aborted turn).
 */
export type ToolStatus = "pending" | "running" | "done" | "error" | "interrupted";

export interface ToolView {
	id: string;
	name: string;
	args: Record<string, unknown>;
	/** True while the model is still streaming the arguments (args parsed best-effort). */
	argsStreaming: boolean;
	status: ToolStatus;
	/** Final result, or the latest partial result while running. */
	output?: ToolResultPayload;
	isError: boolean;
	durationMs?: number;
}

export type AssistantPart =
	| { kind: "text"; key: string; text: string }
	| { kind: "thinking"; key: string; text: string; redacted: boolean; active: boolean }
	| { kind: "tool"; key: string; tool: ToolView };

export interface AssistantView {
	key: string;
	message: AssistantMessage;
	streaming: boolean;
	parts: AssistantPart[];
}

export type DisplayItem =
	| { kind: "user"; key: string; message: UserMessage }
	| { kind: "assistant"; key: string; messages: AssistantView[] }
	| { kind: "tool"; key: string; tool: ToolView }
	| { kind: "bash"; key: string; message: BashExecutionMessage }
	| { kind: "custom"; key: string; message: CustomMessage }
	| { kind: "compaction"; key: string; message: CompactionSummaryMessage }
	| { kind: "branchSummary"; key: string; message: BranchSummaryMessage };

export type DisplayState = Pick<ConversationState, "messages" | "streaming" | "streamingToolArgs" | "tools" | "isRunning">;

const payloads = new WeakMap<ToolResultMessage, ToolResultPayload>();

/** Result payload of a toolResult message (cached so unchanged results keep their identity). */
function resultPayload(result: ToolResultMessage): ToolResultPayload {
	let payload = payloads.get(result);
	if (!payload) {
		payload = { content: result.content ?? [], details: result.details };
		payloads.set(result, payload);
	}
	return payload;
}

const streamedArgsCache = new Map<string, { input: string; parsed: Record<string, unknown> | undefined }>();
/** Below this size the partial arguments are re-parsed on every delta. */
const ALWAYS_PARSE_BELOW = 4096;

/**
 * Partial tool-call arguments while they stream. Re-parsing the whole accumulated JSON on every
 * delta is quadratic for large write/edit calls, so a large input is parsed again only after it
 * grew by a sixteenth (the previous result, with a stable identity, is reused in between).
 * The final arguments arrive with toolcall_end and replace this view.
 */
export function parseStreamedArgs(key: string, input: string): Record<string, unknown> | undefined {
	const cached = streamedArgsCache.get(key);
	if (cached) {
		if (cached.input === input) return cached.parsed;
		const grown = input.length - cached.input.length;
		if (input.length > ALWAYS_PARSE_BELOW && grown > 0 && grown < Math.max(1024, cached.input.length / 16) && input.startsWith(cached.input.slice(0, 256))) {
			return cached.parsed;
		}
	}
	const parsed = parsePartialJson(input);
	streamedArgsCache.delete(key);
	streamedArgsCache.set(key, { input, parsed });
	if (streamedArgsCache.size > 64) streamedArgsCache.delete(streamedArgsCache.keys().next().value as string);
	return parsed;
}

/** Resolves the display state of one tool call. */
export function resolveTool(
	call: ToolCall,
	result: ToolResultMessage | undefined,
	live: ToolExecutionState | undefined,
	context: { messageStreaming: boolean; isRunning: boolean; partialArgs?: string; partKey?: string },
): ToolView {
	const hasArgs = call.arguments && Object.keys(call.arguments).length > 0;
	const streamedArgs =
		context.partialArgs !== undefined && !hasArgs ? parseStreamedArgs(call.id || context.partKey || "", context.partialArgs) : undefined;
	const args = (hasArgs ? call.arguments : (streamedArgs ?? live?.args ?? call.arguments)) ?? {};
	const base = { id: call.id, name: call.name || live?.toolName || "tool", args, argsStreaming: context.partialArgs !== undefined };
	if (result) {
		// Live timings exist only for runs this view saw; the message keeps pi's own (after a reload too).
		const durationMs = live?.durationMs ?? (typeof result.durationMs === "number" ? result.durationMs : undefined);
		return { ...base, status: result.isError ? "error" : "done", output: resultPayload(result), isError: result.isError, durationMs };
	}
	if (live) {
		const isError = live.status === "error" || Boolean(live.isError);
		// A tool cannot still be running once the agent settled (e.g. aborted without an end event).
		const status: ToolStatus = live.status === "running" ? (context.isRunning ? "running" : "interrupted") : isError ? "error" : "done";
		return {
			...base,
			status,
			output: live.result ?? live.partialResult,
			isError,
			durationMs: live.durationMs,
		};
	}
	const status: ToolStatus = context.messageStreaming || context.isRunning ? "pending" : "interrupted";
	return { ...base, status, isError: false };
}

function assistantParts(
	message: AssistantMessage,
	key: string,
	streaming: boolean,
	state: DisplayState,
	results: Map<string, ToolResultMessage>,
): AssistantPart[] {
	const parts: AssistantPart[] = [];
	const content = Array.isArray(message.content) ? message.content : [];
	content.forEach((block, index) => {
		if (!block || typeof block !== "object") return;
		const partKey = `${key}:${index}`;
		if (block.type === "text") {
			if (block.text) parts.push({ kind: "text", key: partKey, text: block.text });
		} else if (block.type === "thinking") {
			const redacted = Boolean(block.redacted);
			if (!block.thinking && !redacted && !(streaming && index === content.length - 1)) return;
			parts.push({
				kind: "thinking",
				key: partKey,
				text: block.thinking ?? "",
				redacted,
				active: streaming && index === content.length - 1,
			});
		} else if (block.type === "toolCall") {
			const tool = resolveTool(block, results.get(block.id), block.id ? state.tools[block.id] : undefined, {
				messageStreaming: streaming,
				isRunning: state.isRunning,
				partialArgs: streaming ? state.streamingToolArgs[index] : undefined,
				partKey,
			});
			parts.push({ kind: "tool", key: block.id ? `tool:${block.id}` : partKey, tool });
		}
	});
	return parts;
}

/** Builds the message list for rendering. Keys are stable across streaming → finalized. */
export function buildDisplayItems(state: DisplayState): DisplayItem[] {
	const results = new Map<string, ToolResultMessage>();
	const callIds = new Set<string>();
	const collectCalls = (m: AssistantMessage) => {
		for (const block of Array.isArray(m.content) ? m.content : []) if (block?.type === "toolCall" && block.id) callIds.add(block.id);
	};
	for (const m of state.messages) {
		if (m.role === "toolResult") results.set((m as ToolResultMessage).toolCallId, m as ToolResultMessage);
		else if (m.role === "assistant") collectCalls(m as AssistantMessage);
	}
	if (state.streaming) collectCalls(state.streaming);

	const items: DisplayItem[] = [];
	const usedKeys = new Map<string, number>();
	const keyFor = (message: AgentMessage | { role: string; timestamp?: number }, index: number) => {
		const base = `${message.role}-${message.timestamp ?? `i${index}`}`;
		const n = usedKeys.get(base) ?? 0;
		usedKeys.set(base, n + 1);
		return n === 0 ? base : `${base}-${n}`;
	};
	const pushAssistant = (view: AssistantView) => {
		const last = items[items.length - 1];
		if (last && last.kind === "assistant") last.messages.push(view);
		else items.push({ kind: "assistant", key: view.key, messages: [view] });
	};

	state.messages.forEach((m, index) => {
		switch (m.role) {
			case "user":
				items.push({ kind: "user", key: keyFor(m, index), message: m as UserMessage });
				break;
			case "assistant": {
				const key = keyFor(m, index);
				pushAssistant({ key, message: m as AssistantMessage, streaming: false, parts: assistantParts(m as AssistantMessage, key, false, state, results) });
				break;
			}
			case "toolResult": {
				const r = m as ToolResultMessage;
				if (callIds.has(r.toolCallId)) break;
				const tool = resolveTool(
					{ type: "toolCall", id: r.toolCallId, name: r.toolName, arguments: state.tools[r.toolCallId]?.args ?? {} },
					r,
					state.tools[r.toolCallId],
					{ messageStreaming: false, isRunning: state.isRunning },
				);
				items.push({ kind: "tool", key: `tool:${r.toolCallId || keyFor(m, index)}`, tool });
				break;
			}
			case "bashExecution":
				items.push({ kind: "bash", key: keyFor(m, index), message: m as BashExecutionMessage });
				break;
			case "custom":
				if ((m as CustomMessage).display) items.push({ kind: "custom", key: keyFor(m, index), message: m as CustomMessage });
				break;
			case "compactionSummary":
				items.push({ kind: "compaction", key: keyFor(m, index), message: m as CompactionSummaryMessage });
				break;
			case "branchSummary":
				items.push({ kind: "branchSummary", key: keyFor(m, index), message: m as BranchSummaryMessage });
				break;
			default:
				break;
		}
	});

	if (state.streaming) {
		const m = state.streaming;
		const key = keyFor(m, state.messages.length);
		pushAssistant({ key, message: m, streaming: true, parts: assistantParts(m, key, true, state, results) });
	}
	return items;
}

/** Shallow equality of two tool views (lets memoized cards skip unchanged tools). */
export function toolViewEqual(a: ToolView, b: ToolView): boolean {
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.status === b.status &&
		a.args === b.args &&
		a.output === b.output &&
		a.isError === b.isError &&
		a.durationMs === b.durationMs &&
		a.argsStreaming === b.argsStreaming
	);
}

/** Equality of assistant groups for memoization: same messages, flags and tool states. */
export function assistantViewsEqual(a: readonly AssistantView[], b: readonly AssistantView[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.message !== y.message || x.streaming !== y.streaming || x.parts.length !== y.parts.length) return false;
		for (let j = 0; j < x.parts.length; j++) {
			const p = x.parts[j];
			const q = y.parts[j];
			if (p.kind !== q.kind) return false;
			if (p.kind === "tool" && q.kind === "tool" && !toolViewEqual(p.tool, q.tool)) return false;
		}
	}
	return true;
}

/** Text of an assistant group (for copying). */
export function assistantGroupText(messages: readonly AssistantView[]): string {
	return messages
		.flatMap((m) => m.parts)
		.filter((p): p is Extract<AssistantPart, { kind: "text" }> => p.kind === "text")
		.map((p) => p.text)
		.join("\n\n");
}

/** True when some tool call of the state is executing right now. */
export function hasRunningTool(state: Pick<ConversationState, "tools">): boolean {
	return Object.values(state.tools).some((t) => t.status === "running");
}
