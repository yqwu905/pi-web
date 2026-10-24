/**
 * Structural subset of pi's RPC protocol (`pi --mode rpc`) and session file format,
 * written against @earendil-works/pi-coding-agent 1.4.x (docs: rpc-commands.md,
 * json.md, rpc-extension-ui.md, message-types.md, session-format.md).
 *
 * Kept dependency-free so the browser bundle can use it. Every union tolerates
 * unknown members because pi extensions can add roles, entries and events.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// ---------- content & messages ----------

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}
export interface ImageContent {
	type: "image";
	/** base64 */
	data: string;
	mimeType: string;
}
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string;
	namespace?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: Array<{ name: string; description?: string; parameters?: unknown }>;
	toolsRemoved?: Array<{ name: string }>;
	timestamp: number;
}
export interface UserMessage {
	role: "user";
	content: string | Array<TextContent | ImageContent>;
	timestamp: number;
}
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
export interface AssistantMessage {
	role: "assistant";
	content: Array<TextContent | ThinkingContent | ToolCall>;
	api: string;
	provider: string;
	model: string;
	responseModel?: string;
	thinkingLevel?: ThinkingLevel;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
	/** Request start (`timestamp`) → end of the response, ms, end-to-end (pi-ai 1.4; absent for legacy messages). */
	durationMs?: number;
}
export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextContent | ImageContent>;
	details?: TDetails;
	usage?: Usage;
	isError: boolean;
	timestamp: number;
	/** Execution time of the tool, ms (absent for legacy results). */
	durationMs?: number;
}
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
	timestamp: number;
}
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | Array<TextContent | ImageContent>;
	display: boolean;
	details?: T;
	timestamp: number;
}
export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}
export interface UnknownMessage {
	role: string;
	timestamp?: number;
	[key: string]: unknown;
}
export type AgentMessage =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| BashExecutionMessage
	| CustomMessage
	| BranchSummaryMessage
	| CompactionSummaryMessage;

// ---------- models & state ----------

export interface PiModel {
	id: string;
	name?: string;
	api: string;
	provider: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	[key: string]: unknown;
}

export interface RpcSessionState {
	model?: PiModel;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface SessionStats {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo?: { path?: string; source?: string; scope?: string; origin?: string; baseDir?: string };
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

export interface CompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	usage?: Usage;
	details?: unknown;
}

// ---------- RPC commands (stdin) ----------

export type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" };

export type RpcCommandType = RpcCommand["type"];

/** Response record (stdout). `data` shape depends on `command`; see RpcResponseData. */
export interface RpcResponse<TData = any> {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: TData;
	error?: string;
}

/** Typed `data` of successful responses, by command. */
export interface RpcResponseData {
	prompt: { disposition: "started" | "queued" | "handled" };
	steer: { disposition: "queued" | "handled" };
	follow_up: { disposition: "queued" | "handled" };
	abort: undefined;
	clear_queue: { steering: string[]; followUp: string[] };
	new_session: { cancelled: boolean };
	get_state: RpcSessionState;
	set_model: PiModel;
	cycle_model: { model: PiModel; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	get_available_models: { models: PiModel[] };
	set_thinking_level: undefined;
	cycle_thinking_level: { level: ThinkingLevel } | null;
	get_available_thinking_levels: { levels: ThinkingLevel[] };
	set_steering_mode: undefined;
	set_follow_up_mode: undefined;
	compact: CompactionResult;
	set_auto_compaction: undefined;
	set_auto_retry: undefined;
	abort_retry: undefined;
	bash: BashResult;
	abort_bash: undefined;
	get_session_stats: SessionStats;
	export_html: { path: string };
	switch_session: { cancelled: boolean };
	fork: { text?: string; cancelled: boolean };
	clone: { cancelled: boolean };
	get_fork_messages: { messages: Array<{ entryId: string; text: string }> };
	get_entries: { entries: SessionEntry[]; leafId: string | null };
	get_tree: { tree: SessionTreeNode[]; leafId: string | null };
	get_last_assistant_text: { text: string | null };
	set_session_name: undefined;
	get_messages: { messages: AgentMessage[] };
	get_commands: { commands: RpcSlashCommand[] };
}

// ---------- session events (stdout) ----------

export type AssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| { type: "done"; reason: string; message?: AssistantMessage }
	| { type: "error"; reason: string; error?: unknown };

export interface ToolResultPayload {
	content: Array<TextContent | ImageContent>;
	details?: any;
}

export type PiSessionEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[]; willRetry?: boolean }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; usage?: Usage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, any> }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, any>;
			partialResult: ToolResultPayload;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: ToolResultPayload;
			isError: boolean;
			durationMs?: number;
	  }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result?: CompactionResult;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "summarization_retry_attempt_start"; source: "compaction" | "branchSummary"; reason?: string }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| { type: "extension_error"; extensionPath: string; event: string; error: string };

export type PiSessionEventType = PiSessionEvent["type"];

// ---------- extension UI sub-protocol ----------

export type ExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines?: string[];
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type ExtensionUIDialogMethod = "select" | "confirm" | "input" | "editor";
export const EXTENSION_UI_DIALOG_METHODS: readonly string[] = ["select", "confirm", "input", "editor"];

export type ExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

/** Any record pi writes to stdout in RPC mode. */
export type PiOutputRecord = RpcResponse | PiSessionEvent | ExtensionUIRequest;

// ---------- session file ----------

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

interface EntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}
export type SessionEntry =
	| (EntryBase & { type: "message"; message: AgentMessage })
	| (EntryBase & { type: "model_change"; provider: string; modelId: string })
	| (EntryBase & { type: "thinking_level_change"; thinkingLevel: ThinkingLevel })
	| (EntryBase & { type: "usage"; kind: string; provider?: string; model?: string; usage: Usage })
	| (EntryBase & {
			type: "compaction";
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			usage?: Usage;
			details?: unknown;
			fromHook?: boolean;
	  })
	| (EntryBase & { type: "context_edit"; targetId: string; replacement: unknown })
	| (EntryBase & { type: "branch_summary"; fromId: string; summary: string; usage?: Usage; details?: unknown })
	| (EntryBase & { type: "custom"; customType: string; data?: unknown })
	| (EntryBase & {
			type: "custom_message";
			customType: string;
			content: string | Array<TextContent | ImageContent>;
			display: boolean;
			details?: unknown;
	  })
	| (EntryBase & { type: "label"; targetId: string; label?: string })
	| (EntryBase & { type: "session_info"; name?: string });

export type SessionEntryType = SessionEntry["type"];

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}
