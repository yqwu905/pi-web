import type { FsReadResult, GitFileStatus } from "@pi-web/shared";
import { Check, Copy, Download, File as FileIcon, FileQuestion, FileWarning, Lock, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { errorMessage, workspaceDownloadUrl } from "../../api/client";
import { CodeBlock, copyText } from "../../components/CodeBlock";
import { Markdown } from "../../components/Markdown";
import { Button, buttonClass } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/Choice";
import { Callout, EmptyState } from "../../components/ui/Display";
import { LoadingBlock } from "../../components/ui/Spinner";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { isImagePath } from "../../lib/languages";
import { useUiStore } from "../../stores/ui";
import { fileMetaText, imageDataUrl, previewKind } from "./lib/file-view";
import { gitBadge, gitStateText } from "./lib/git";
import { chatPrefillPath, gitFilePath, mentionText } from "./lib/links";
import { baseName, displayPath, pathSegments, relativePath } from "./lib/remote-path";
import type { Tone } from "../../lib/status";
import { useFileRead } from "./queries";

const ACTION = buttonClass({ variant: "secondary", size: "sm", className: "[&_svg]:shrink-0" });

export interface FileViewerProps {
	workspaceId: string;
	root: string;
	/** Absolute path of the file, or undefined when nothing is selected. */
	path?: string;
	gitMark?: GitFileStatus;
}

function Breadcrumb({ root, path }: { root: string; path: string }) {
	const segments = pathSegments(displayPath(root, path));
	return (
		<nav aria-label="文件路径" className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-sm">
			{segments.map((seg, i) => (
				<span key={seg.path} className="flex min-w-0 items-center gap-1.5">
					{(i > 0 || seg.path.startsWith("/")) && (
						<span aria-hidden="true" className="text-fg-3">
							/
						</span>
					)}
					<span className={cn("truncate whitespace-nowrap", i === segments.length - 1 ? "font-semibold text-fg" : "text-fg-2")} aria-current={i === segments.length - 1 ? "page" : undefined}>
						{seg.name}
					</span>
				</span>
			))}
		</nav>
	);
}

function CopyPathButton({ path }: { path: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => setCopied(false), [path]);
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(t);
	}, [copied]);
	return (
		<button type="button" title={path} className={ACTION} onClick={() => void copyText(path).then((ok) => ok && setCopied(true))}>
			{copied ? <Check size={13} className="text-success" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
			<span aria-live="polite">{copied ? "已复制" : "复制路径"}</span>
		</button>
	);
}

function DownloadLink({ workspaceId, path, className, label = "下载" }: { workspaceId: string; path: string; className?: string; label?: string }) {
	return (
		<a href={workspaceDownloadUrl(workspaceId, path)} download={baseName(path)} className={cn(ACTION, "text-fg hover:text-fg", className)}>
			<Download size={13} aria-hidden="true" />
			{label}
		</a>
	);
}

const CHIP_TONES: Record<Tone, string> = {
	warning: "border-warning-border bg-warning-soft text-warning-fg",
	success: "border-success/30 bg-success-soft text-success-fg",
	danger: "border-danger/40 bg-danger-soft text-danger",
	accent: "border-user-border bg-user text-link",
	neutral: "border-border bg-chip text-fg-2",
};

/** "M 已修改，未暂存" chip in the meta line. */
function GitStateChip({ file }: { file: GitFileStatus }) {
	const badge = gitBadge(file);
	return (
		<span className={cn("inline-flex h-5 items-center gap-1.5 rounded-sm border px-2 text-2xs font-semibold", CHIP_TONES[badge.tone])}>
			<span aria-hidden="true" className="font-mono">
				{badge.letter}
			</span>
			{gitStateText(file)}
		</span>
	);
}

function ImagePreview({ src, name }: { src: string; name: string }) {
	const [size, setSize] = useState<{ w: number; h: number } | null>(null);
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6">
			<img
				src={src}
				alt={name}
				onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
				className="max-h-full max-w-full rounded-md border border-border bg-raised object-contain"
			/>
			{size && (
				<span className="font-mono text-xs text-fg-3">
					{size.w} × {size.h}
				</span>
			)}
		</div>
	);
}

function FileBody({ workspaceId, path, read, mode }: { workspaceId: string; path: string; read: FsReadResult; mode: "preview" | "source" }) {
	const kind = previewKind(path, read);
	if (kind === "binary") {
		return (
			<EmptyState
				icon={<FileWarning />}
				title={isImagePath(path) && read.truncated ? "图片超过预览上限（2 MB）" : "二进制文件，无法预览"}
				description={`文件大小 ${formatBytes(read.size)}。可以下载后在本地打开。`}
				actions={<DownloadLink workspaceId={workspaceId} path={path} label="下载文件" />}
			/>
		);
	}
	if ((kind === "image" || kind === "svg") && mode === "preview") {
		const src = imageDataUrl(path, read);
		if (src) return <ImagePreview src={src} name={baseName(path)} />;
	}
	if (kind === "markdown" && mode === "preview") {
		return (
			<div className="min-h-0 flex-1 overflow-y-auto bg-bg px-8 py-6">
				<article aria-label={`${baseName(path)} 预览`} className="max-w-[760px]">
					<Markdown className="text-fg-code">{read.content}</Markdown>
				</article>
			</div>
		);
	}
	return (
		<div className="relative min-h-0 flex-1">
			<div className="absolute inset-0">
				<CodeBlock code={read.content} filename={path} lineNumbers className="h-full" maxHeight="100%" autoDetect={false} />
			</div>
		</div>
	);
}

/** Right column of the Files view: breadcrumb, actions, meta line and the preview. */
export function FileViewer({ workspaceId, root, path, gitMark }: FileViewerProps) {
	const read = useFileRead(workspaceId, path);
	const [mode, setMode] = useState<"preview" | "source">("preview");
	const lastSession = useUiStore((s) => s.lastSession[workspaceId]);

	if (!path) {
		return (
			<section aria-label="文件内容" className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
				<EmptyState icon={<FileIcon />} title="选择文件以预览" description="文件浏览为只读；单文件预览上限 2 MB。" />
			</section>
		);
	}

	const rel = relativePath(root, path);
	const mentionPath = rel || path;
	const data = read.data;
	const kind = data ? previewKind(path, data) : undefined;
	const toggleable = kind === "markdown" || kind === "svg";

	return (
		<section aria-label="文件内容" className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
			<div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-2.5">
				<div className="flex min-h-[30px] flex-wrap items-center gap-x-3 gap-y-2">
					<div className="flex min-w-0 items-center gap-2">
						<FileIcon size={14} strokeWidth={1.7} className="shrink-0 text-fg-3" aria-hidden="true" />
						<Breadcrumb root={root} path={path} />
						<span
							title="文件浏览为只读；单文件预览上限 2 MB"
							className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 text-2xs text-fg-3"
						>
							<Lock size={10} strokeWidth={2} aria-hidden="true" />
							只读
						</span>
					</div>
					<div className="flex-1" />
					<div className="flex flex-wrap items-center gap-2">
						<Link to={chatPrefillPath(workspaceId, mentionText(mentionPath), lastSession)} title={`在输入框插入 ${mentionText(mentionPath)}`} className={cn(ACTION, "text-fg hover:text-fg")}>
							<span aria-hidden="true" className="font-mono text-sm font-semibold text-accent">
								@
							</span>
							在对话中引用
						</Link>
						<CopyPathButton path={path} />
						<DownloadLink workspaceId={workspaceId} path={path} />
					</div>
				</div>
				<div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-3">
					<span>{data ? fileMetaText(path, data) : read.isPending ? "读取中…" : ""}</span>
					{gitMark && (
						<>
							<GitStateChip file={gitMark} />
							<Link to={gitFilePath(workspaceId, gitMark.path, gitMark.area)} className="text-xs">
								查看 diff
							</Link>
						</>
					)}
					<div className="flex-1" />
					{toggleable && (
						<Segmented
							aria-label={kind === "markdown" ? "Markdown 显示方式" : "SVG 显示方式"}
							options={[
								{ value: "preview", label: "预览" },
								{ value: "source", label: "源码" },
							]}
							value={mode}
							onChange={setMode}
						/>
					)}
				</div>
			</div>
			<div className="flex min-h-0 flex-1 flex-col bg-code">
				{read.isPending && <LoadingBlock text="读取文件…" />}
				{read.isError && (
					<EmptyState
						icon={<FileQuestion />}
						title="无法读取文件"
						description={errorMessage(read.error)}
						actions={
							<Button icon={<RefreshCw size={13} />} onClick={() => void read.refetch()}>
								重试
							</Button>
						}
					/>
				)}
				{data && (
					<>
						{data.truncated && kind !== "binary" && (
							<Callout tone="warning" className="m-3 mb-0" actions={<DownloadLink workspaceId={workspaceId} path={path} label="下载完整文件" />}>
								文件大小 {formatBytes(data.size)}，超过预览上限 2 MB，只显示开头部分。
							</Callout>
						)}
						<FileBody workspaceId={workspaceId} path={path} read={data} mode={toggleable ? mode : "preview"} />
					</>
				)}
			</div>
		</section>
	);
}

