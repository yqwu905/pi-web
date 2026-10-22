/**
 * Pure conversation-state reducer over pi RPC events. Used by:
 * - the remote agent, to keep an always-current view of each conversation so it can
 *   hand out atomic snapshots (`conv.snapshot`) tagged with the event seq they reflect;
 * - the browser, to render a conversation from a snapshot plus subsequent events.
 *
 * All functions return new objects for changed parts (React-friendly) and never mutate inputs.
 */
import type { ConvRecord, ConvStatus } from "./agent-protocol.js";
import type {
	AgentMessage,
	AssistantMessage,
	ExtensionUIRequest,
	ImageContent,
	SessionEntry,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
	ToolResultPayload,
	Usage,
} from "./pi.js";
import { EXTENSION_UI_DIALOG_METHODS } from "./pi.js";
import { COMPANION_STATUS_KEY } from "./agent-protocol.js";

export interface ToolExecutionState {
	toolCallId: string;
	toolName: string;
	args: Record<string, any>;
	status: "running" | "done" | "error";
	partialResult?: ToolResultPayload;
	result?: ToolResultPayload;
	isError?: boolean;
	durationMs?: number;
}

export interface UiNotification {
	id: string;
	message: string;
	notifyType: "info" | "warning" | "error";
	ts: number;
}

export interface ConversationUiState {
	/** Pending dialog requests (select/confirm/input/editor), oldest first. */
	pending: ExtensionUIRequest[];
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	notifications: UiNotification[];
	title?: string;
	/** Latest set_editor_text request; `nonce` changes on every request. */
	editorText?: { text: string; nonce: string };
}

export interface ConversationState {
	/** Finalized messages, in order. */
	messages: AgentMessage[];
	/** Assistant message currently streaming (stopReason "pending"), if any. */
	streaming: AssistantMessage | null;
	/** Raw, possibly incomplete JSON of tool-call arguments being streamed, by content index. */
	streamingToolArgs: Record<number, string>;
	tools: Record<string, ToolExecutionState>;
	queue: { steering: string[]; followUp: string[] };
	/** True between agent_start and agent_settled. */
	isRunning: boolean;
	isCompacting: boolean;
	retry: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null;
	lastError?: string;
	sessionName?: string;
	thinkingLevel?: ThinkingLevel;
	/** Output of direct RPC `bash` commands, by RPC request id. */
	bashOutput: Record<string, string>;
	ui: ConversationUiState;
	status?: ConvStatus;
	exited?: { code: number | null; signal: string | null; stderrTail: string };
	/**
	 * Set when the event stream implies the message list changed in a way events do not
	 * describe (compaction, session switch/fork/new). Consumers should refetch a snapshot.
	 */
	needsResync: boolean;
	/** Seq of the last applied event (0 = none). */
	seq: number;
}

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MAX_NOTIFICATIONS = 50;
const DEDUPE_WINDOW = 64;

export function createConversationState(init?: Partial<ConversationState>): ConversationState {
	return {
		messages: [],
		streaming: null,
		streamingToolArgs: {},
		tools: {},
		queue: { steering: [], followUp: [] },
		isRunning: false,
		isCompacting: false,
		retry: null,
		bashOutput: {},
		ui: { pending: [], statuses: {}, widgets: {}, notifications: [] },
		needsResync: false,
		seq: 0,
		...init,
	};
}

/** Insert or replace (same role + timestamp among the last messages) a finalized message. */
export function upsertMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
	const ts = (message as { timestamp?: number }).timestamp;
	const start = Math.max(0, messages.length - DEDUPE_WINDOW);
	for (let i = messages.length - 1; i >= start; i--) {
		const m = messages[i] as { role: string; timestamp?: number };
		if (m.role === message.role && ts !== undefined && m.timestamp === ts) {
			const next = messages.slice();
			next[i] = message;
			return next;
		}
	}
	return [...messages, message];
}

function placeholderAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "",
		provider: "",
		model: "",
		usage: ZERO_USAGE,
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function cloneAssistant(message: AssistantMessage): AssistantMessage {
	return { ...message, content: message.content.map((c) => ({ ...c })) as AssistantMessage["content"] };
}

function setContent(
	message: AssistantMessage,
	index: number,
	block: TextContent | ThinkingContent | ToolCall,
): AssistantMessage {
	const content = message.content.slice() as Array<TextContent | ThinkingContent | ToolCall>;
	while (content.length < index) content.push({ type: "text", text: "" });
	content[index] = block;
	return { ...message, content };
}

function applyAssistantEvent(
	state: ConversationState,
	event: Extract<ConvRecord, { type: "message_update" }>,
): ConversationState {
	let streaming = state.streaming ?? placeholderAssistant();
	let streamingToolArgs = state.streamingToolArgs;
	if (event.usage) streaming = { ...streaming, usage: event.usage };
	const e = event.assistantMessageEvent;
	switch (e.type) {
		case "text_start":
			streaming = setContent(streaming, e.contentIndex, { type: "text", text: "" });
			break;
		case "text_delta": {
			const current = streaming.content[e.contentIndex];
			const text = current && current.type === "text" ? current.text : "";
			streaming = setContent(streaming, e.contentIndex, { ...(current as TextContent), type: "text", text: text + e.delta });
			break;
		}
		case "text_end":
			streaming = setContent(streaming, e.contentIndex, { type: "text", text: e.content });
			break;
		case "thinking_start":
			streaming = setContent(streaming, e.contentIndex, { type: "thinking", thinking: "" });
			break;
		case "thinking_delta": {
			const current = streaming.content[e.contentIndex];
			const thinking = current && current.type === "thinking" ? current.thinking : "";
			streaming = setContent(streaming, e.contentIndex, {
				...(current as ThinkingContent),
				type: "thinking",
				thinking: thinking + e.delta,
			});
			break;
		}
		case "thinking_end":
			streaming = setContent(streaming, e.contentIndex, { type: "thinking", thinking: e.content });
			break;
		case "toolcall_start":
			streaming = setContent(streaming, e.contentIndex, { type: "toolCall", id: e.id, name: e.toolName, arguments: {} });
			streamingToolArgs = { ...streamingToolArgs, [e.contentIndex]: "" };
			break;
		case "toolcall_delta":
			streamingToolArgs = { ...streamingToolArgs, [e.contentIndex]: (streamingToolArgs[e.contentIndex] ?? "") + e.delta };
			break;
		case "toolcall_end": {
			streaming = setContent(streaming, e.contentIndex, e.toolCall);
			const { [e.contentIndex]: _removed, ...rest } = streamingToolArgs;
			streamingToolArgs = rest;
			break;
		}
		case "done":
			if (e.message) streaming = cloneAssistant(e.message);
			break;
		case "error":
		case "start":
		default:
			break;
	}
	return { ...state, streaming, streamingToolArgs };
}

function applyUiRequest(state: ConversationState, request: ExtensionUIRequest): ConversationState {
	const ui = state.ui;
	if (EXTENSION_UI_DIALOG_METHODS.includes(request.method)) {
		if (ui.pending.some((p) => p.id === request.id)) return state;
		return { ...state, ui: { ...ui, pending: [...ui.pending, request] } };
	}
	switch (request.method) {
		case "notify": {
			const notifications = [
				...ui.notifications,
				{ id: request.id, message: request.message, notifyType: request.notifyType ?? "info", ts: Date.now() },
			].slice(-MAX_NOTIFICATIONS);
			return { ...state, ui: { ...ui, notifications } };
		}
		case "setStatus": {
			if (request.statusKey === COMPANION_STATUS_KEY) return state;
			const statuses = { ...ui.statuses };
			if (request.statusText === undefined || request.statusText === null) delete statuses[request.statusKey];
			else statuses[request.statusKey] = request.statusText;
			return { ...state, ui: { ...ui, statuses } };
		}
		case "setWidget": {
			const widgets = { ...ui.widgets };
			if (!request.widgetLines) delete widgets[request.widgetKey];
			else widgets[request.widgetKey] = { lines: request.widgetLines, placement: request.widgetPlacement ?? "aboveEditor" };
			return { ...state, ui: { ...ui, widgets } };
		}
		case "setTitle":
			return { ...state, ui: { ...ui, title: request.title } };
		case "set_editor_text":
			return { ...state, ui: { ...ui, editorText: { text: request.text, nonce: request.id } } };
		default:
			return state;
	}
}

/** Remove a dialog request (answered locally, by another client, or timed out). */
export function resolveUiRequest(state: ConversationState, id: string): ConversationState {
	if (!state.ui.pending.some((p) => p.id === id)) return state;
	return { ...state, ui: { ...state.ui, pending: state.ui.pending.filter((p) => p.id !== id) } };
}

export function dismissNotification(state: ConversationState, id: string): ConversationState {
	return { ...state, ui: { ...state.ui, notifications: state.ui.notifications.filter((n) => n.id !== id) } };
}

/**
 * Apply one record. `seq`, when given, is recorded and records with seq <= state.seq are ignored
 * (so replaying overlapping ranges is harmless).
 */
export function applyConvRecord(state: ConversationState, record: ConvRecord, seq?: number): ConversationState {
	if (seq !== undefined) {
		if (seq <= state.seq) return state;
		state = { ...state, seq };
	}
	switch (record.type) {
		case "agent_start":
			return { ...state, isRunning: true, lastError: undefined, exited: undefined };
		case "agent_settled":
			return { ...state, isRunning: false, streaming: null, streamingToolArgs: {}, retry: null };
		case "agent_end":
		case "turn_start":
		case "turn_end":
		case "entry_appended":
		case "summarization_retry_scheduled":
		case "summarization_retry_attempt_start":
		case "summarization_retry_finished":
			return state;
		case "message_start": {
			const message = record.message;
			if (message.role === "assistant") {
				return { ...state, streaming: cloneAssistant(message as AssistantMessage), streamingToolArgs: {} };
			}
			return { ...state, messages: upsertMessage(state.messages, message) };
		}
		case "message_update":
			return applyAssistantEvent(state, record);
		case "message_end": {
			const message = record.message;
			const next = { ...state, messages: upsertMessage(state.messages, message) };
			if (message.role === "assistant") {
				next.streaming = null;
				next.streamingToolArgs = {};
				const m = message as AssistantMessage;
				if (m.stopReason === "error" && m.errorMessage) next.lastError = m.errorMessage;
			}
			return next;
		}
		case "tool_execution_start":
			return {
				...state,
				tools: {
					...state.tools,
					[record.toolCallId]: {
						toolCallId: record.toolCallId,
						toolName: record.toolName,
						args: record.args,
						status: "running",
					},
				},
			};
		case "tool_execution_update": {
			const prev = state.tools[record.toolCallId];
			return {
				...state,
				tools: {
					...state.tools,
					[record.toolCallId]: {
						...prev,
						toolCallId: record.toolCallId,
						toolName: record.toolName,
						args: prev?.args ?? record.args,
						status: "running",
						partialResult: record.partialResult,
					},
				},
			};
		}
		case "tool_execution_end": {
			const prev = state.tools[record.toolCallId];
			return {
				...state,
				tools: {
					...state.tools,
					[record.toolCallId]: {
						...prev,
						toolCallId: record.toolCallId,
						toolName: record.toolName,
						args: prev?.args ?? {},
						status: record.isError ? "error" : "done",
						result: record.result,
						isError: record.isError,
						durationMs: record.durationMs,
					},
				},
			};
		}
		case "queue_update":
			return { ...state, queue: { steering: record.steering ?? [], followUp: record.followUp ?? [] } };
		case "session_info_changed":
			return { ...state, sessionName: record.name };
		case "thinking_level_changed":
			return { ...state, thinkingLevel: record.level };
		case "compaction_start":
			return { ...state, isCompacting: true };
		case "compaction_end":
			return {
				...state,
				isCompacting: false,
				needsResync: state.needsResync || Boolean(record.result),
				lastError: record.errorMessage ?? state.lastError,
			};
		case "auto_retry_start":
			return {
				...state,
				retry: {
					attempt: record.attempt,
					maxAttempts: record.maxAttempts,
					delayMs: record.delayMs,
					errorMessage: record.errorMessage,
				},
			};
		case "auto_retry_end":
			return { ...state, retry: null, lastError: record.success ? state.lastError : (record.finalError ?? state.lastError) };
		case "bash_execution_update": {
			const key = record.id ?? "_";
			return { ...state, bashOutput: { ...state.bashOutput, [key]: (state.bashOutput[key] ?? "") + record.delta } };
		}
		case "extension_error":
			return {
				...state,
				ui: {
					...state.ui,
					notifications: [
						...state.ui.notifications,
						{
							id: `ext-error-${seq ?? Date.now()}`,
							message: `扩展错误（${record.extensionPath}，${record.event}）：${record.error}`,
							notifyType: "error" as const,
							ts: Date.now(),
						},
					].slice(-MAX_NOTIFICATIONS),
				},
			};
		case "extension_ui_request":
			return applyUiRequest(state, record);
		case "pi_web_status":
			return { ...state, status: record.status };
		case "pi_web_exit":
			return {
				...state,
				status: "exited",
				isRunning: false,
				streaming: null,
				streamingToolArgs: {},
				ui: { ...state.ui, pending: [] },
				exited: { code: record.code, signal: record.signal, stderrTail: record.stderrTail },
			};
		case "pi_web_ui_resolved":
			return resolveUiRequest(state, record.id);
		case "pi_web_session_changed":
			return { ...state, needsResync: true, tools: {}, streaming: null, streamingToolArgs: {} };
		case "pi_web_stderr":
			return state;
		default:
			return state;
	}
}

/**
 * Build the display message list for a session file's active branch, without a pi process.
 * Includes entries before compactions (the full history), marking compactions with a
 * compactionSummary message at the point they happened.
 */
export function entriesToMessages(entries: SessionEntry[], branchIds: string[]): AgentMessage[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const out: AgentMessage[] = [];
	for (const id of branchIds) {
		const entry = byId.get(id);
		if (!entry) continue;
		const ts = Date.parse(entry.timestamp) || 0;
		switch (entry.type) {
			case "message":
				out.push(entry.message);
				break;
			case "compaction":
				out.push({ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: ts });
				break;
			case "branch_summary":
				out.push({ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: ts });
				break;
			case "custom_message":
				out.push({
					role: "custom",
					customType: entry.customType,
					content: entry.content as string | Array<TextContent | ImageContent>,
					display: entry.display,
					details: entry.details,
					timestamp: ts,
				});
				break;
			default:
				break;
		}
	}
	return out;
}

/** Plain text of a user/custom message content (images omitted). */
export function contentToText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}
