import { FileText } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { cn } from "../lib/cn";
import { type DiffFile, type DiffHunk, type DiffLine, diffFilePath, parseUnifiedDiff, toSplitRows } from "../lib/diff-parse";
import { Badge } from "./ui/Display";

export type DiffMode = "inline" | "split";

export interface DiffViewProps {
	/** Unified diff text (git diff, or makeUnifiedDiff() for edit tool calls). */
	diff?: string;
	/** Pre-parsed files (takes precedence over `diff`). */
	files?: DiffFile[];
	/** "inline" (行内) or "split" (并排). */
	mode?: DiffMode;
	/** Per-file header bars (default: shown when there is more than one file). */
	showFileHeaders?: boolean;
	/** Sticky column titles in split mode, e.g. ["旧 · 暂存区", "新 · 工作区"]. */
	splitLabels?: [ReactNode, ReactNode];
	/** Soft-wrap long lines in inline mode (split mode always wraps, as in the Git artboard). */
	wrap?: boolean;
	maxHeight?: number | string;
	emptyText?: ReactNode;
	/** Extra content on the right of each file header (e.g. "发给 pi 审阅"). */
	fileActions?: (file: DiffFile) => ReactNode;
	className?: string;
	/** Accessible name of the scroll region. */
	"aria-label"?: string;
}

const STATUS_LABEL: Record<DiffFile["status"], { text: string; tone: "success" | "danger" | "info" | "neutral" }> = {
	added: { text: "新增", tone: "success" },
	deleted: { text: "删除", tone: "danger" },
	renamed: { text: "重命名", tone: "info" },
	copied: { text: "复制", tone: "info" },
	modified: { text: "修改", tone: "neutral" },
};

type Kind = DiffLine["type"] | "empty";

/** Row tone: text color + background (Git artboard TONE). */
const TONE: Record<Kind, string> = {
	context: "text-fg-code",
	del: "bg-danger-soft text-danger",
	add: "bg-success-soft text-success-fg",
	note: "text-fg-3",
	empty: "bg-panel text-fg-3",
};
/** Extra gutter tint layered on the row (inline: faint; split: tint). */
const GUTTER_INLINE: Record<Kind, string> = { context: "", del: "bg-danger-faint", add: "bg-success-faint", note: "", empty: "" };
const GUTTER_SPLIT: Record<Kind, string> = { context: "", del: "bg-danger-tint", add: "bg-success-tint", note: "", empty: "bg-panel" };
const SIGN: Record<Kind, string> = { context: "", del: "−", add: "+", note: "", empty: "" };

const GUTTER = "w-[52px] shrink-0 pr-2.5 text-right text-fg-3 select-none";

function hunkTitle(hunk: DiffHunk): string {
	return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.section ? ` ${hunk.section}` : ""}`;
}

function HunkRow({ hunk, first, split }: { hunk: DiffHunk; first: boolean; split?: boolean }) {
	return (
		<div
			className={cn(
				"flex min-h-7 items-center border-b border-border bg-panel pr-3 text-fg-3",
				!first && "border-t",
				split ? "pl-[72px] whitespace-pre-wrap" : "whitespace-pre",
			)}
		>
			{!split && <span className="w-[124px] shrink-0" aria-hidden="true" />}
			{hunkTitle(hunk)}
		</div>
	);
}

function InlineHunk({ hunk, first, wrap }: { hunk: DiffHunk; first: boolean; wrap: boolean }) {
	return (
		<>
			<HunkRow hunk={hunk} first={first} />
			{hunk.lines.map((line, i) =>
				line.type === "note" ? (
					<div key={i} className="flex min-h-5 text-fg-3">
						<span className="w-[124px] shrink-0" aria-hidden="true" />
						<span className="pr-6 whitespace-pre">\ {line.content}</span>
					</div>
				) : (
					<div key={i} className={cn("flex min-h-5 items-start", TONE[line.type])}>
						<span className={cn(GUTTER, GUTTER_INLINE[line.type])} aria-hidden="true">
							{line.type === "add" ? "" : line.oldNo}
						</span>
						<span className={cn(GUTTER, GUTTER_INLINE[line.type])} aria-hidden="true">
							{line.type === "del" ? "" : line.newNo}
						</span>
						<span className="w-5 shrink-0 text-center select-none" aria-hidden="true">
							{SIGN[line.type]}
						</span>
						<span className={cn("pr-6", wrap ? "min-w-0 flex-1 break-words whitespace-pre-wrap" : "whitespace-pre")}>{line.content}</span>
					</div>
				),
			)}
		</>
	);
}

function SplitCells({ line, right }: { line: DiffLine | null; right?: boolean }) {
	const kind: Kind = line ? line.type : "empty";
	const no = !line ? "" : line.type === "add" ? line.newNo : line.type === "del" ? line.oldNo : right ? line.newNo : line.oldNo;
	return (
		<>
			<span className={cn("pr-2.5 text-right text-fg-3 select-none", TONE[kind], GUTTER_SPLIT[kind], right && "border-l border-border")} aria-hidden="true">
				{no}
			</span>
			<span className={cn("text-center select-none", TONE[kind])} aria-hidden="true">
				{SIGN[kind]}
			</span>
			<span className={cn("pr-3 break-all whitespace-pre-wrap", TONE[kind])}>{line?.content ?? ""}</span>
		</>
	);
}

function SplitHunk({ hunk, first }: { hunk: DiffHunk; first: boolean }) {
	const rows = useMemo(() => toSplitRows(hunk), [hunk]);
	return (
		<>
			<HunkRow hunk={hunk} first={first} split />
			{rows.map((row, i) =>
				row.kind === "note" ? (
					<div key={i} className="min-h-5 pl-[72px] text-fg-3">
						\ {row.text}
					</div>
				) : (
					<div key={i} className="grid min-h-5 grid-cols-[52px_20px_minmax(0,1fr)_52px_20px_minmax(0,1fr)]">
						<SplitCells line={row.left} />
						<SplitCells line={row.right} right />
					</div>
				),
			)}
		</>
	);
}

function FileHeader({ file, actions }: { file: DiffFile; actions?: ReactNode }) {
	const status = STATUS_LABEL[file.status];
	return (
		<div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-bg px-4 py-1.5 font-sans">
			<FileText size={14} strokeWidth={1.8} className="shrink-0 text-fg-2" aria-hidden="true" />
			<code className="min-w-0 truncate text-sm text-fg">{diffFilePath(file)}</code>
			{file.status !== "modified" && <Badge tone={status.tone}>{status.text}</Badge>}
			<span className="flex gap-1.5 font-mono text-xs">
				{file.additions > 0 && <span className="text-success-fg">+{file.additions}</span>}
				{file.deletions > 0 && <span className="text-danger">−{file.deletions}</span>}
			</span>
			<span className="flex-1" />
			{actions}
		</div>
	);
}

function FileBody({ file, mode, wrap, splitLabels }: { file: DiffFile; mode: DiffMode; wrap: boolean; splitLabels?: [ReactNode, ReactNode] }) {
	if (file.binary) return <div className="px-4 py-2 font-sans text-xs text-fg-3">二进制文件，无法显示差异</div>;
	if (file.hunks.length === 0) {
		const text =
			file.status === "renamed"
				? `文件已重命名${file.similarity !== undefined ? `（相似度 ${file.similarity}%）` : ""}`
				: file.oldMode && file.newMode && file.oldMode !== file.newMode
					? `文件权限变更：${file.oldMode} → ${file.newMode}`
					: "没有内容变更";
		return <div className="px-4 py-2 font-sans text-xs text-fg-3">{text}</div>;
	}
	if (mode === "split") {
		return (
			<div className="flex flex-col">
				{splitLabels && (
					<div className="sticky top-0 z-[1] grid grid-cols-2 border-b border-border bg-panel font-sans section-label">
						<span className="py-1.5 pr-3 pl-[72px]">{splitLabels[0]}</span>
						<span className="border-l border-border py-1.5 pr-3 pl-[72px]">{splitLabels[1]}</span>
					</div>
				)}
				{file.hunks.map((h, i) => (
					<SplitHunk key={i} hunk={h} first={i === 0 && !splitLabels} />
				))}
			</div>
		);
	}
	return (
		<div className={cn("flex flex-col", !wrap && "min-w-max")}>
			{file.hunks.map((h, i) => (
				<InlineHunk key={i} hunk={h} first={i === 0} wrap={wrap} />
			))}
		</div>
	);
}

/**
 * Unified diff renderer (Git artboard): inline (行内) with old/new line-number gutters and a
 * sign column, or side-by-side (并排) on a 52/20/1fr grid. Additions teal on
 * rgba(60,200,180,.12), deletions salmon on rgba(242,118,107,.12).
 */
export function DiffView({
	diff,
	files: filesProp,
	mode = "inline",
	showFileHeaders,
	splitLabels,
	wrap = false,
	maxHeight,
	emptyText = "没有差异",
	fileActions,
	className,
	"aria-label": ariaLabel,
}: DiffViewProps) {
	const files = useMemo(() => filesProp ?? parseUnifiedDiff(diff ?? ""), [filesProp, diff]);
	const headers = showFileHeaders ?? files.length > 1;
	const style: CSSProperties | undefined = maxHeight !== undefined ? { maxHeight } : undefined;
	if (files.length === 0) {
		return <div className={cn("bg-code px-4 py-2 text-xs text-fg-3", className)}>{emptyText}</div>;
	}
	return (
		<div
			role="region"
			aria-label={ariaLabel ?? `差异（${mode === "split" ? "并排" : "行内"}）`}
			tabIndex={0}
			className={cn("overflow-auto bg-code font-mono text-mono", className)}
			style={style}
		>
			{files.map((file, i) => (
				<div key={`${diffFilePath(file)}-${i}`} className={cn(i > 0 && "border-t border-border")}>
					{headers && <FileHeader file={file} actions={fileActions?.(file)} />}
					<FileBody file={file} mode={mode} wrap={wrap} splitLabels={splitLabels} />
				</div>
			))}
		</div>
	);
}
