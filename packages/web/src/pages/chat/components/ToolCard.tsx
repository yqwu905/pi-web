import {
	ChevronDown,
	FilePen,
	FilePlus2,
	FileText,
	FolderOpen,
	FolderSearch,
	ListTodo,
	type LucideIcon,
	Search,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import { memo, type ReactNode, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { CodeBlock } from "../../../components/CodeBlock";
import { JsonView } from "../../../components/JsonView";
import { Spinner } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { diffStats, parseUnifiedDiff } from "../../../lib/diff-parse";
import { formatDuration } from "../../../lib/format";
import { paths } from "../../../lib/routes";
import { useUiStore } from "../../../stores/ui";
import { firstSeen, ScrollReleaseContext, useNow } from "../hooks";
import { type ToolView, toolViewEqual } from "../logic/messages";
import {
	countLines,
	editDiff,
	lineRangeLabel,
	parseBashResult,
	parseReadResult,
	payloadImages,
	payloadText,
	todoError,
	toolErrorLine,
	toolExpanded,
	toolOverrides,
	toolPath,
	toolTarget,
} from "../logic/tools";
import { CompactDiff } from "./CompactDiff";
import { ImageThumbs } from "./ImageThumbs";

const ICONS: Record<string, LucideIcon> = {
	bash: SquareTerminal,
	read: FileText,
	edit: FilePen,
	write: FilePlus2,
	grep: Search,
	find: FolderSearch,
	ls: FolderOpen,
	todo: ListTodo,
};

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

export interface ToolCardProps {
	tool: ToolView;
	workspaceId?: string;
}

/**
 * Collapsible card for one tool call, paired with its result or live execution state. Cards start
 * collapsed (or expanded, per the global preference in the ui store); a toggle of one card is
 * remembered by tool call id until reload or until the preference changes.
 */
export const ToolCard = memo(ToolCardImpl, (a, b) => a.workspaceId === b.workspaceId && toolViewEqual(a.tool, b.tool));

function ToolCardImpl({ tool, workspaceId }: ToolCardProps) {
	// Read from the store, not props: the memo comparators up the tree ignore everything else.
	const toolsExpanded = useUiStore((s) => s.toolsExpanded);
	const epoch = useUiStore((s) => s.toolsExpandedEpoch);
	const [override, setOverride] = useState(() => toolOverrides.get(tool.id, epoch));
	const [overrideEpoch, setOverrideEpoch] = useState(epoch);
	if (overrideEpoch !== epoch) {
		// Expand/collapse all: every card follows the new preference.
		setOverrideEpoch(epoch);
		setOverride(undefined);
	}
	const expanded = toolExpanded(override, toolsExpanded);
	const release = useContext(ScrollReleaseContext);
	const cardRef = useRef<HTMLDivElement>(null);
	const bodyId = useId();
	const toggle = () => {
		// Growing a card above the bottom must not scroll its header away while the list follows new output.
		if (!expanded) release?.(cardRef.current);
		toolOverrides.set(tool.id, !expanded, epoch);
		setOverride(!expanded);
	};
	const running = tool.status === "running";
	const busy = running || tool.status === "pending";
	const now = useNow(1000, running);
	const startedAt = running ? firstSeen.get(`tool:${tool.id}`) : undefined;
	const Icon = ICONS[tool.name] ?? Wrench;
	const text = payloadText(tool.output);
	const target = toolTarget(tool.name, tool.args);
	const rejected = tool.name === "todo" ? todoError(tool.output?.details) : undefined;
	const errorLine = expanded ? "" : toolErrorLine(tool.name, tool.isError, text, tool.output?.details);

	// While the arguments stream, every delta would re-diff the whole edit: diff once they are complete.
	const diffFiles = useMemo(
		() => (tool.name === "edit" && !tool.argsStreaming ? parseUnifiedDiff(editDiff(tool.args, tool.output?.details)) : []),
		[tool.name, tool.args, tool.output?.details, tool.argsStreaming],
	);

	let meta: ReactNode = null;
	let metaTone = "text-fg-3";
	if (tool.status === "pending") {
		const lines = tool.argsStreaming && !expanded && (tool.name === "write" || tool.name === "edit") ? streamingLines(tool) : 0;
		meta = tool.argsStreaming ? (lines ? `生成中 · ${lines} 行` : "生成参数…") : "等待执行";
	} else if (running) {
		meta = `运行中${startedAt ? ` ${formatDuration(Math.max(0, now - startedAt))}` : ""}`;
		metaTone = "text-link";
	} else if (tool.status === "interrupted") meta = text ? "已中断" : "未执行";
	else if (tool.name === "bash") {
		const r = parseBashResult(text, tool.isError);
		const head = r.status ?? (r.exitCode !== undefined ? `退出码 ${r.exitCode}` : "失败");
		meta = tool.durationMs !== undefined ? `${head} · ${formatDuration(tool.durationMs)}` : head;
		if (tool.isError) metaTone = "text-danger";
	} else if (tool.isError || rejected) {
		meta = "失败";
		metaTone = "text-danger";
	} else if (tool.name === "read") {
		const r = parseReadResult(tool.args, text);
		meta = payloadImages(tool.output).length ? "图片" : lineRangeLabel(r.startLine, r.lineCount) || "空文件";
	} else if (tool.name === "write") meta = `${countLines(str(tool.args.content))} 行`;
	else if (tool.name === "grep" || tool.name === "find" || tool.name === "ls") {
		const n = countLines(text);
		meta = !text || /^No (matches|files) found|^\(empty directory\)$/.test(text) ? "无结果" : `${n} 行`;
	} else if (tool.durationMs !== undefined) meta = formatDuration(tool.durationMs);

	const stats = tool.name === "edit" && diffFiles.length ? diffStats(diffFiles) : null;

	return (
		<div
			ref={cardRef}
			role="group"
			aria-label={`工具 ${tool.name}${target ? ` ${target}` : ""}`}
			className={cn(
				"overflow-hidden rounded-lg border bg-panel",
				running ? "border-user-border" : tool.isError ? "border-danger/40" : "border-border",
			)}
		>
			<div className="flex min-h-9 items-center gap-2 pr-3">
				<button
					type="button"
					aria-expanded={expanded}
					aria-controls={bodyId}
					onClick={toggle}
					className="flex min-h-9 min-w-0 flex-1 items-center gap-2 bg-transparent py-1.5 pl-3 text-left"
				>
					{busy ? (
						<Spinner size={12} />
					) : (
						<Icon size={14} strokeWidth={1.8} className={cn("shrink-0", tool.isError ? "text-danger" : "text-fg-2")} aria-hidden="true" />
					)}
					<span className={cn("shrink-0 text-xs font-semibold", running ? "text-link" : tool.isError ? "text-danger" : "text-fg-2")}>{tool.name}</span>
					<code className="min-w-0 flex-1 truncate text-mono text-fg" title={target}>
						{target}
					</code>
					{stats && (
						<span className="flex shrink-0 gap-1.5 text-2xs">
							<span className="text-success-fg">+{stats.additions}</span>
							<span className="text-danger">−{stats.deletions}</span>
						</span>
					)}
					{meta && <span className={cn("shrink-0 text-2xs", metaTone)}>{meta}</span>}
					<ChevronDown
						size={13}
						strokeWidth={2}
						aria-hidden="true"
						className={cn("shrink-0 text-fg-3 transition-transform", !expanded && "-rotate-90")}
					/>
				</button>
				{tool.name === "edit" && workspaceId && tool.status === "done" && (
					<Link to={paths.git(workspaceId)} className="shrink-0 text-xs">
						在 Git 中查看
					</Link>
				)}
			</div>
			{errorLine && (
				<div className="-mt-1 truncate px-3 pb-1.5 text-xs text-danger" title={errorLine}>
					{errorLine}
				</div>
			)}
			{expanded && (
				<div id={bodyId} className="border-t border-border">
					<ToolBody tool={tool} text={text} diffFiles={diffFiles} />
				</div>
			)}
		</div>
	);
}

function ErrorText({ text }: { text: string }) {
	return (
		<pre className="m-0 max-h-[240px] overflow-auto bg-danger-faint px-3 py-2.5 font-mono text-mono leading-[1.6] break-words whitespace-pre-wrap text-danger">
			{text || "工具执行失败"}
		</pre>
	);
}

function Notice({ children }: { children: ReactNode }) {
	return <div className="border-t border-border bg-panel px-3 py-1.5 text-2xs text-fg-3">{children}</div>;
}

function OutputPre({ text, follow, empty = "（无输出）", maxHeight = 360 }: { text: string; follow?: boolean; empty?: string; maxHeight?: number }) {
	const ref = useRef<HTMLPreElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!follow || !el) return;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
	}, [text, follow]);
	return (
		<pre
			ref={ref}
			tabIndex={0}
			className="m-0 overflow-auto bg-code px-3 py-2.5 font-mono text-mono leading-[1.6] break-words whitespace-pre-wrap text-fg-code"
			style={{ maxHeight }}
		>
			{text ? text : <span className="text-fg-3">{empty}</span>}
		</pre>
	);
}

/** Characters of a streaming write/edit shown as plain text (highlighting waits for the final arguments). */
const STREAMING_TAIL = 4000;

/** Content of a streaming write, or the replacement texts of a streaming edit. */
function streamingParts(tool: ToolView): string[] {
	if (tool.name === "write") return [str(tool.args.content)];
	const edits = Array.isArray(tool.args.edits) ? (tool.args.edits as Array<{ newText?: unknown }>) : [{ newText: tool.args.newText }];
	return edits.map((e) => str(e?.newText));
}

function streamingText(tool: ToolView): string {
	return streamingParts(tool).join("\n…\n");
}

/** Lines generated so far (size hint of a collapsed streaming write/edit). */
function streamingLines(tool: ToolView): number {
	return streamingParts(tool).reduce((n, part) => n + countLines(part), 0);
}

function ToolBody({ tool, text, diffFiles }: { tool: ToolView; text: string; diffFiles: ReturnType<typeof parseUnifiedDiff> }) {
	const path = toolPath(tool.args);
	if (tool.argsStreaming && (tool.name === "write" || tool.name === "edit")) {
		const content = streamingText(tool);
		return <OutputPre text={content.length > STREAMING_TAIL ? `…${content.slice(-STREAMING_TAIL)}` : content} follow empty="生成中…" />;
	}
	const details = tool.output?.details as { truncation?: { truncated?: boolean }; fullOutputPath?: string } | undefined;
	switch (tool.name) {
		case "bash": {
			const command = str(tool.args.command);
			const r = parseBashResult(text, tool.isError);
			return (
				<>
					{command.includes("\n") && (
						<pre className="m-0 border-b border-border bg-panel px-3 py-2 font-mono text-mono leading-[1.6] break-words whitespace-pre-wrap text-fg-2">
							<span className="text-fg-3 select-none">$ </span>
							{command}
						</pre>
					)}
					{tool.status === "pending" || (tool.status === "interrupted" && !text) ? (
						<OutputPre text="" empty={tool.status === "pending" ? "等待执行…" : "命令未执行"} />
					) : (
						<OutputPre text={tool.status === "running" || tool.status === "interrupted" ? text : r.output} follow={tool.status === "running"} />
					)}
					{details?.fullOutputPath && <Notice>输出过长已截断，完整输出：{details.fullOutputPath}</Notice>}
				</>
			);
		}
		case "read": {
			if (tool.isError) return <ErrorText text={text} />;
			const images = payloadImages(tool.output);
			if (images.length) return <ImageThumbs images={images} className="p-3" />;
			if (!tool.output) return <OutputPre text="" empty="读取中…" />;
			const r = parseReadResult(tool.args, text);
			return (
				<>
					{r.content ? <CodeBlock code={r.content} filename={path} lineNumbers startLine={r.startLine} maxHeight={420} /> : <OutputPre text="" empty="（空文件）" />}
					{r.notice && <Notice>{r.notice}</Notice>}
				</>
			);
		}
		case "edit":
			return (
				<>
					{tool.isError && <ErrorText text={text} />}
					{tool.isError && diffFiles.length > 0 && <div className="border-t border-border px-3 py-1.5 text-2xs text-fg-3">未应用的修改</div>}
					<CompactDiff files={diffFiles} />
				</>
			);
		case "write": {
			const content = str(tool.args.content);
			return (
				<>
					{tool.isError && <ErrorText text={text} />}
					{content ? <CodeBlock code={content} filename={path} lineNumbers maxHeight={360} /> : <OutputPre text="" empty="（空文件）" />}
				</>
			);
		}
		case "grep":
		case "find":
		case "ls":
			if (tool.isError) return <ErrorText text={text} />;
			return <OutputPre text={text} empty={tool.output ? "（无输出）" : "执行中…"} maxHeight={320} />;
		default:
			return <GenericBody tool={tool} text={text} />;
	}
}

function GenericBody({ tool, text }: { tool: ToolView; text: string }) {
	const images = payloadImages(tool.output);
	const details = tool.output?.details;
	return (
		<div className="flex flex-col">
			<div className="flex flex-col gap-1 bg-code px-3 py-2.5">
				<span className="section-label">参数</span>
				<div className="font-mono text-mono">
					<JsonView value={tool.args} collapsedDepth={2} />
				</div>
			</div>
			{(text || images.length > 0 || details !== undefined) && (
				<div className="flex flex-col gap-1 border-t border-border bg-code px-3 py-2.5">
					<span className="section-label">结果</span>
					{text && (
						<pre
							className={cn(
								"m-0 max-h-[320px] overflow-auto font-mono text-mono leading-[1.6] break-words whitespace-pre-wrap",
								tool.isError ? "text-danger" : "text-fg-code",
							)}
						>
							{text}
						</pre>
					)}
					{images.length > 0 && <ImageThumbs images={images} />}
					{details !== undefined && details !== null && (
						<div className="font-mono text-mono">
							<JsonView value={details} rootName="details" collapsedDepth={1} />
						</div>
					)}
				</div>
			)}
		</div>
	);
}
