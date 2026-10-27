import {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	type CustomMessage,
	contentToText,
	type ImageContent,
	type MessageTiming,
	type StreamingTiming,
	type UserMessage,
} from "@pi-web/shared";
import { Ban, Brain, ChevronDown, Gauge, GitBranch, GitFork, Layers, Puzzle, SquareTerminal } from "lucide-react";
import { memo, type ReactNode, useMemo, useState } from "react";
import { Markdown } from "../../../components/Markdown";
import { Badge, Callout, Spinner } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { formatDuration, formatDurationZh, formatTokens } from "../../../lib/format";
import { thinkingSpans, useNow, useThrottledValue } from "../hooks";
import { type AssistantPart, type AssistantView, assistantViewsEqual } from "../logic/messages";
import {
	groupThroughput,
	groupThroughputTitle,
	liveThroughput,
	liveThroughputText,
	sameMessageTimings,
	throughputText,
	trackSpan,
} from "../logic/usage";
import { ImageThumbs } from "./ImageThumbs";
import { ToolCard } from "./ToolCard";

function contentImages(content: UserMessage["content"] | CustomMessage["content"]): ImageContent[] {
	return Array.isArray(content) ? content.filter((c): c is ImageContent => c.type === "image") : [];
}

// ---------- user ----------

/** `navKey`: the message's anchor for the jump rail (data-nav-key). */
export const UserMessageView = memo(function UserMessageView({ message, navKey }: { message: UserMessage; navKey?: string }) {
	const text = contentToText(message.content);
	const images = contentImages(message.content);
	return (
		<div
			data-nav-key={navKey}
			className="flex max-w-[80%] flex-col gap-2 self-end rounded-xl border border-user-border bg-user px-3.5 py-2.5 text-base leading-[1.6] break-words whitespace-pre-wrap text-fg"
		>
			{text && <div>{text}</div>}
			{images.length > 0 && <ImageThumbs images={images} size={120} />}
		</div>
	);
});

// ---------- assistant ----------

function ThinkingBlock({ part }: { part: Extract<AssistantPart, { kind: "thinking" }> }) {
	const [open, setOpen] = useState(false);
	const span = trackSpan(thinkingSpans, part.key, part.active);
	const now = useNow(1000, part.active);
	let label: string;
	if (part.active) label = span ? `思考中 ${formatDurationZh(Math.max(0, now - span.start))}` : "思考中…";
	else if (span?.end !== undefined) label = `思考 ${formatDurationZh(span.end - span.start)}`;
	else label = part.redacted && !part.text ? "思考内容已隐藏" : "思考过程";
	const canOpen = Boolean(part.text);
	return (
		<div className="flex flex-col gap-2">
			<button
				type="button"
				onClick={() => canOpen && setOpen((o) => !o)}
				aria-expanded={canOpen ? open : undefined}
				disabled={!canOpen}
				className="flex h-[26px] items-center gap-1.5 self-start rounded-full border border-border bg-panel px-2.5 text-xs text-fg-2 disabled:cursor-default"
			>
				{part.active ? <Spinner size={11} /> : <Brain size={12} strokeWidth={2} aria-hidden="true" />}
				{label}
				{canOpen && <span className="text-fg-3">{open ? "收起" : "展开"}</span>}
			</button>
			{open && canOpen && (
				<div className="border-l-2 border-thinking px-3.5 py-2.5 text-sm leading-[1.7] break-words whitespace-pre-wrap text-fg-2">{part.text}</div>
			)}
		</div>
	);
}

/** The reply that is still streaming: its Markdown is re-parsed at most every 120ms, not on every token. */
function StreamingText({ text, active }: { text: string; active: boolean }) {
	const shown = useThrottledValue(text, 120, active);
	return (
		<Markdown className={cn(active && CARET)} streaming={active}>
			{shown}
		</Markdown>
	);
}

const CARET = "[&>*:last-child]:after:ml-0.5 [&>*:last-child]:after:inline-block [&>*:last-child]:after:animate-pulse-dot [&>*:last-child]:after:text-accent [&>*:last-child]:after:content-['▍']";

function AssistantMessageView({ view, workspaceId }: { view: AssistantView; workspaceId?: string }) {
	const { message, parts, streaming } = view;
	const lastPart = parts[parts.length - 1];
	return (
		<>
			{parts.map((part) => {
				switch (part.kind) {
					case "thinking":
						return <ThinkingBlock key={part.key} part={part} />;
					case "text":
						return streaming ? (
							<StreamingText key={part.key} text={part.text} active={part === lastPart} />
						) : (
							<Markdown key={part.key}>{part.text}</Markdown>
						);
					case "tool":
						return <ToolCard key={part.key} tool={part.tool} workspaceId={workspaceId} />;
					default:
						return null;
				}
			})}
			{streaming && parts.length === 0 && (
				<div className="flex items-center gap-2 text-sm text-fg-3" role="status">
					<Spinner size={12} />
					正在生成…
				</div>
			)}
			{message.stopReason === "error" && (
				<Callout tone="danger" title="请求失败">
					<span className="break-words whitespace-pre-wrap">{message.errorMessage || "模型请求出错"}</span>
				</Callout>
			)}
			{message.stopReason === "aborted" && (
				<div className="flex items-center gap-1.5 text-xs text-fg-3">
					<Ban size={12} strokeWidth={2} aria-hidden="true" />
					已中止{message.errorMessage && message.errorMessage !== "Request was aborted" ? `：${message.errorMessage}` : ""}
				</div>
			)}
			{message.stopReason === "length" && <div className="text-xs text-warning">输出达到长度上限，回复可能不完整</div>}
		</>
	);
}

function ThroughputLine({ text, title }: { text: string; title: string }) {
	return (
		<div className="flex items-center gap-1 text-2xs text-fg-3 tabular-nums" title={title}>
			<Gauge size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
			{text}
		</div>
	);
}

/** Output throughput of the group's finished messages (hidden when none has one). */
function GroupThroughputLine({ views, timings }: { views: AssistantView[]; timings?: Readonly<Record<string, MessageTiming>> }) {
	const throughput = useMemo(() => groupThroughput(views.map((v) => v.message), timings), [views, timings]);
	if (!throughput) return null;
	return <ThroughputLine text={throughputText(throughput)} title={groupThroughputTitle(throughput)} />;
}

/**
 * Forks a new session that continues after the reply (spinner until it is done). It takes the
 * throughput line's 16px in the layout: the footer keeps its height when a reply finishes.
 */
function ForkReplyButton({ onFork, blocked }: { onFork: () => Promise<void>; blocked?: string }) {
	const [busy, setBusy] = useState(false);
	const fork = () => {
		if (busy) return;
		setBusy(true);
		void onFork().finally(() => setBusy(false));
	};
	return (
		<button
			type="button"
			onClick={fork}
			disabled={Boolean(blocked) || busy}
			aria-label="从这条回复 Fork 新对话"
			title={blocked ?? "从这条回复 Fork 新对话"}
			className="group/fork -my-1 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs text-fg-3 transition-[color,background-color,scale] duration-150 hover:bg-raised hover:text-fg active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-3 motion-reduce:transition-none"
		>
			{busy ? (
				<Spinner size={11} />
			) : (
				<GitFork
					size={12}
					strokeWidth={1.9}
					aria-hidden="true"
					className="shrink-0 transition-transform duration-200 group-enabled/fork:group-hover/fork:-rotate-12 motion-reduce:transition-none"
				/>
			)}
			Fork
		</button>
	);
}

/** Tool-call arguments parsed so far, by call id: the streaming message holds `{}` until toolcall_end. */
function streamedToolArgs(parts: readonly AssistantPart[]): Record<string, unknown> | undefined {
	let args: Record<string, unknown> | undefined;
	for (const part of parts) {
		if (part.kind !== "tool" || !part.tool.argsStreaming || !part.tool.id) continue;
		args ??= {};
		args[part.tool.id] = part.tool.args;
	}
	return args;
}

/** Estimated throughput of the reply that is streaming, recomputed at most twice a second. */
function LiveThroughputLine({ view, timing, calibration }: { view: AssistantView; timing: StreamingTiming | null; calibration: number }) {
	const input = useMemo(() => ({ view, timing, calibration }), [view, timing, calibration]);
	const shown = useThrottledValue(input, 500, true);
	const live = useMemo(() => liveThroughput(shown.view.message, shown.timing, shown.calibration, streamedToolArgs(shown.view.parts)), [shown]);
	if (!live) return null;
	return <ThroughputLine text={liveThroughputText(live)} title={live.estimated ? "生成中，按已输出的内容估算" : "生成中，按模型实时返回的用量计算"} />;
}

export interface AssistantGroupProps {
	messages: AssistantView[];
	workspaceId?: string;
	/** ConversationTiming.messages: only the entries of this group's messages are compared. */
	timings?: Readonly<Record<string, MessageTiming>>;
	/** For the group whose last message is streaming: its timing and throughputCalibration. */
	streamingTiming?: StreamingTiming | null;
	calibration?: number;
	/** Fork after the finished group; called with the group's key (its first message's). */
	onFork?: (key: string) => Promise<void>;
	/** Why forking is unavailable right now (the button's tooltip); undefined when it is available. */
	forkBlocked?: string;
}

export const AssistantGroupView = memo(
	function AssistantGroupView({ messages, workspaceId, timings, streamingTiming, calibration, onFork, forkBlocked }: AssistantGroupProps) {
		const last = messages[messages.length - 1];
		return (
			<div className="flex min-w-0 flex-col gap-3">
				{messages.map((view) => (
					<AssistantMessageView key={view.key} view={view} workspaceId={workspaceId} />
				))}
				<div className="flex items-center gap-2 self-start empty:hidden">
					{last?.streaming ? (
						<LiveThroughputLine view={last} timing={streamingTiming ?? null} calibration={calibration ?? 1} />
					) : (
						<>
							{onFork && messages.length > 0 && <ForkReplyButton onFork={() => onFork(messages[0].key)} blocked={forkBlocked} />}
							<GroupThroughputLine views={messages} timings={timings} />
						</>
					)}
				</div>
			</div>
		);
	},
	(a, b) =>
		a.workspaceId === b.workspaceId &&
		assistantViewsEqual(a.messages, b.messages) &&
		sameMessageTimings(a.messages, a.timings, b.timings) &&
		a.streamingTiming === b.streamingTiming &&
		a.calibration === b.calibration &&
		a.onFork === b.onFork &&
		a.forkBlocked === b.forkBlocked,
);

// ---------- bash executions (! commands) ----------

export interface BashRunView {
	command: string;
	output: string;
	running: boolean;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
	startedAt?: number;
	/** The RPC call itself failed (output holds the error). */
	failed?: boolean;
}

export function bashRunFromMessage(m: BashExecutionMessage): BashRunView {
	return {
		command: m.command,
		output: m.output,
		running: false,
		exitCode: m.exitCode,
		cancelled: m.cancelled,
		truncated: m.truncated,
		fullOutputPath: m.fullOutputPath,
		excludeFromContext: m.excludeFromContext,
	};
}

/** A user-run "!cmd" / "!!cmd" with its output (live while running). */
export const BashRunCard = memo(function BashRunCard({ run }: { run: BashRunView }) {
	const [open, setOpen] = useState(true);
	const now = useNow(1000, run.running);
	const failed = run.failed || (!run.running && !run.cancelled && run.exitCode !== undefined && run.exitCode !== 0);
	let meta: ReactNode;
	if (run.running) meta = <span className="text-link">运行中{run.startedAt ? ` ${formatDuration(Math.max(0, now - run.startedAt))}` : ""}</span>;
	else if (run.failed) meta = <span className="text-danger">失败</span>;
	else if (run.cancelled) meta = <span className="text-fg-3">已取消</span>;
	else if (run.exitCode !== undefined) meta = <span className={failed ? "text-danger" : "text-fg-3"}>退出码 {run.exitCode}</span>;
	return (
		<div className={cn("overflow-hidden rounded-lg border bg-panel", run.running ? "border-user-border" : failed ? "border-danger/40" : "border-border")}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="flex min-h-9 w-full items-center gap-2 bg-transparent px-3 py-1.5 text-left"
			>
				{run.running ? <Spinner size={12} /> : <SquareTerminal size={14} strokeWidth={1.8} className="shrink-0 text-fg-2" aria-hidden="true" />}
				<span className={cn("shrink-0 font-mono text-xs font-semibold", run.running ? "text-link" : "text-fg-2")}>{run.excludeFromContext ? "!!" : "!"}</span>
				<code className="min-w-0 flex-1 truncate text-mono text-fg" title={run.command}>
					{run.command}
				</code>
				{run.excludeFromContext && <Badge>不计入上下文</Badge>}
				<span className="shrink-0 text-2xs">{meta}</span>
				<ChevronDown size={13} strokeWidth={2} aria-hidden="true" className={cn("shrink-0 text-fg-3 transition-transform", !open && "-rotate-90")} />
			</button>
			{open && (
				<div className="border-t border-border">
					<pre className="m-0 max-h-[360px] overflow-auto bg-code px-3 py-2.5 font-mono text-mono leading-[1.6] break-words whitespace-pre-wrap text-fg-code" tabIndex={0}>
						{run.output || <span className="text-fg-3">{run.running ? "等待输出…" : "（无输出）"}</span>}
					</pre>
					{run.truncated && (
						<div className="border-t border-border px-3 py-1.5 text-2xs text-fg-3">
							输出已截断{run.fullOutputPath ? `，完整输出：${run.fullOutputPath}` : ""}
						</div>
					)}
				</div>
			)}
		</div>
	);
});

/** A bashExecution message from the session (memoized by message identity). */
export const BashMessageCard = memo(function BashMessageCard({ message }: { message: BashExecutionMessage }) {
	return <BashRunCard run={bashRunFromMessage(message)} />;
});

// ---------- custom messages & summaries ----------

export const CustomMessageView = memo(function CustomMessageView({ message }: { message: CustomMessage }) {
	const text = contentToText(message.content);
	const images = contentImages(message.content);
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-dashed border-border-strong bg-panel px-3.5 py-2.5">
			<span className="flex items-center gap-1.5 text-2xs font-semibold text-fg-3">
				<Puzzle size={12} strokeWidth={1.8} aria-hidden="true" />
				扩展消息
				<code className="font-normal text-fg-2">{message.customType}</code>
			</span>
			{text && <Markdown className="text-sm">{text}</Markdown>}
			{images.length > 0 && <ImageThumbs images={images} size={120} />}
		</div>
	);
});

function SummaryDivider({ icon, label, summary }: { icon: ReactNode; label: string; summary: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-3">
				<span className="h-px flex-1 bg-border" aria-hidden="true" />
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
					className="flex h-[26px] items-center gap-1.5 rounded-full border border-dashed border-border-strong bg-panel px-2.5 text-xs text-fg-2 hover:text-fg"
				>
					{icon}
					{label}
					<span className="text-fg-3">{open ? "收起" : "查看摘要"}</span>
				</button>
				<span className="h-px flex-1 bg-border" aria-hidden="true" />
			</div>
			{open && (
				<div className="rounded-lg border border-border bg-panel px-3.5 py-3">
					<Markdown className="text-sm">{summary || "（摘要为空）"}</Markdown>
				</div>
			)}
		</div>
	);
}

export const CompactionDivider = memo(function CompactionDivider({ message }: { message: CompactionSummaryMessage }) {
	const label = message.tokensBefore ? `上下文已压缩 · 压缩前 ${formatTokens(message.tokensBefore)} tokens` : "上下文已压缩";
	return <SummaryDivider icon={<Layers size={12} strokeWidth={1.9} aria-hidden="true" />} label={label} summary={message.summary} />;
});

export const BranchSummaryDivider = memo(function BranchSummaryDivider({ message }: { message: BranchSummaryMessage }) {
	return <SummaryDivider icon={<GitBranch size={12} strokeWidth={1.9} aria-hidden="true" />} label="分支摘要" summary={message.summary} />;
});
