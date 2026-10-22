import type { GitArea, GitCommit, GitFileStatus, GitStatusResult, ServerView, WorkspaceConfig } from "@pi-web/shared";
import { CircleCheck, FileText, GitBranch, Lock, MessageSquare, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { errorMessage } from "../../api/client";
import { useGitStatus } from "../../api/hooks";
import { CodeBlock } from "../../components/CodeBlock";
import { DiffView } from "../../components/DiffView";
import { Button } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/Choice";
import { Callout, EmptyState } from "../../components/ui/Display";
import { IconButton } from "../../components/ui/IconButton";
import { LoadingBlock, Spinner } from "../../components/ui/Spinner";
import { cn } from "../../lib/cn";
import { parseUnifiedDiff } from "../../lib/diff-parse";
import { formatRelativeTime } from "../../lib/format";
import { paths } from "../../lib/routes";
import { useUiStore } from "../../stores/ui";
import { GitStatusLetter } from "./GitStatusLetter";
import {
	buildReviewPrompt,
	changedFileCount,
	diffCommand,
	diffModeText,
	GIT_AREA_LABELS,
	GIT_AREA_ORDER,
	groupGitFiles,
	parseRefs,
	splitDirName,
	splitLabelsFor,
	unpushedHashes,
} from "./lib/git";
import { chatPrefillPath } from "./lib/links";
import { joinPath, relativePath } from "./lib/remote-path";
import { useWorkspacePrefs } from "./prefs";
import { invalidateWorkspaceGit, useGitDiff, useGitLog } from "./queries";
import { WorkspaceGate } from "./WorkspaceGate";

type Selection = { path: string; area: GitArea };

const AREA_VALUES: readonly string[] = GIT_AREA_ORDER;

function sameFile(a: Selection | undefined, b: GitFileStatus): boolean {
	return Boolean(a && a.path === b.path && a.area === b.area);
}

function BranchInfo({ status, readAt }: { status: GitStatusResult; readAt: number }) {
	const branchLabel = status.detached ? `分离 HEAD${status.headShort ? ` · ${status.headShort}` : ""}` : (status.branch ?? "（无分支）");
	return (
		<>
			<span
				className="flex h-[30px] items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 font-mono text-mono text-fg"
				title={status.root ? `仓库：${status.root}` : undefined}
			>
				<GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />
				<span className="sr-only">当前分支</span>
				{branchLabel}
			</span>
			<span className="text-mono text-fg-2">
				{status.upstream ? (
					<>
						领先 <code className="text-xs text-fg-code">{status.upstream}</code> {status.ahead} 个提交 · 落后 {status.behind}
					</>
				) : (
					"未设置上游分支"
				)}
			</span>
			{readAt > 0 && <span className="text-xs text-fg-3">状态读取于 {formatRelativeTime(readAt)}</span>}
		</>
	);
}

function FileRow({ file, selected, onSelect }: { file: GitFileStatus; selected: boolean; onSelect: () => void }) {
	const { dir, name } = splitDirName(file.path);
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-current={selected ? "true" : undefined}
			title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
			className={cn(
				"relative flex h-[30px] w-full items-center gap-2 rounded-md border-0 px-2 text-left text-fg",
				selected ? "bg-selected" : "bg-transparent hover:bg-raised",
			)}
		>
			<GitStatusLetter file={file} variant="list" />
			<span className="min-w-0 flex-1 truncate font-mono text-xs">
				<span className="text-fg-3">{dir}</span>
				<span className="text-fg">{name}</span>
			</span>
			{file.binary ? (
				<span className="shrink-0 text-2xs text-fg-3">二进制</span>
			) : (
				<>
					<span className="min-w-7 shrink-0 text-right font-mono text-2xs text-success-fg">{file.additions !== undefined ? `+${file.additions}` : ""}</span>
					<span className="min-w-6 shrink-0 text-right font-mono text-2xs text-danger">{file.deletions ? `−${file.deletions}` : ""}</span>
				</>
			)}
		</button>
	);
}

function ChangeGroup({ area, files, selection, onSelect }: { area: GitArea; files: GitFileStatus[]; selection?: Selection; onSelect: (f: GitFileStatus) => void }) {
	return (
		<div className="flex flex-col gap-0.5">
			<h3 className="m-0 px-2 pb-1 section-label">
				{GIT_AREA_LABELS[area]}（{files.length}）
			</h3>
			{files.length === 0 ? (
				<p className="m-0 px-2 py-0.5 text-xs text-fg-3">无</p>
			) : (
				files.map((f) => <FileRow key={`${f.area}:${f.path}`} file={f} selected={sameFile(selection, f)} onSelect={() => onSelect(f)} />)
			)}
		</div>
	);
}

function CommitList({ commits, unpushed, loading, error }: { commits: GitCommit[]; unpushed: Set<string>; loading: boolean; error?: string }) {
	return (
		<div className="flex flex-col gap-0.5 border-t border-border pt-3">
			<h3 className="m-0 px-2 pb-1 section-label">最近提交</h3>
			{loading && (
				<span className="flex items-center gap-2 px-2 py-1 text-xs text-fg-3">
					<Spinner size={11} /> 读取提交记录…
				</span>
			)}
			{error && <p className="m-0 px-2 py-0.5 text-xs text-danger">{error}</p>}
			{!loading && !error && commits.length === 0 && <p className="m-0 px-2 py-0.5 text-xs text-fg-3">还没有提交</p>}
			<ol className="m-0 flex list-none flex-col gap-0.5 p-0">
				{commits.map((c) => (
					<li key={c.hash} className="flex flex-col gap-0.5 px-2 py-1.5" title={`${c.hash}\n${c.author} <${c.email}>`}>
						<span className="flex min-w-0 items-center gap-2">
							<code className="w-14 shrink-0 text-xs text-link">{c.short}</code>
							<span className="min-w-0 flex-1 truncate text-mono text-fg">{c.subject}</span>
							{parseRefs(c.refs).map((r) => (
								<span key={r.label} className="shrink-0 rounded-sm border border-border-strong px-[5px] font-mono text-[10.5px] leading-4 text-fg-2">
									{r.kind === "tag" ? `tag: ${r.label}` : r.label}
								</span>
							))}
						</span>
						<span className="pl-16 text-[11.5px] text-fg-3">
							{c.author} · {formatRelativeTime(c.dateMs)}
							{unpushed.has(c.hash) && " · 未推送"}
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}

function DiffPanel({
	workspace,
	server,
	status,
	file,
	mode,
}: {
	workspace: WorkspaceConfig;
	server: ServerView;
	status: GitStatusResult;
	file?: GitFileStatus;
	mode: "inline" | "split";
}) {
	const diff = useGitDiff(workspace.id, file ? { path: file.path, area: file.area } : undefined);
	const raw = diff.data?.diff ?? "";
	const parsed = useMemo(() => parseUnifiedDiff(raw), [raw]);
	const df = parsed[0];

	if (!file) {
		return (
			<section aria-label="Diff" className="flex min-h-0 min-w-0 flex-1 flex-col bg-code">
				<EmptyState icon={<CircleCheck />} title="工作区没有未提交的变更" description="git status 显示工作区是干净的。" />
			</section>
		);
	}

	const absolute = status.root ? joinPath(status.root, file.path) : undefined;
	const inWorkspace = absolute ? relativePath(workspace.path, absolute) : null;
	const additions = df?.additions ?? file.additions ?? 0;
	const deletions = df?.deletions ?? file.deletions ?? 0;
	const modeText = diffModeText(df, raw);

	return (
		<section aria-label="Diff" className="flex min-h-0 min-w-0 flex-1 flex-col bg-code">
			<div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-bg px-4 py-2">
				<FileText size={14} strokeWidth={1.8} className="shrink-0 text-fg-2" aria-hidden="true" />
				<code className="min-w-0 truncate text-sm text-fg">{file.origPath ? `${file.origPath} → ${file.path}` : file.path}</code>
				<span className="rounded-sm border border-border bg-raised px-1.5 text-2xs leading-[18px] text-fg-2">{GIT_AREA_LABELS[file.area]}</span>
				<span className="flex gap-1.5 font-mono text-xs">
					<span className="text-success-fg">+{additions}</span>
					{deletions > 0 && <span className="text-danger">−{deletions}</span>}
				</span>
				{modeText && <span className="font-mono text-xs text-fg-3">{modeText}</span>}
				{df && df.hunks.length > 0 && <span className="text-xs text-fg-3">{df.hunks.length} 个变更块</span>}
				<div className="flex-1" />
				{inWorkspace && file.code !== "D" && (
					<Link to={paths.files(workspace.id, inWorkspace)} className="text-xs">
						在文件中打开
					</Link>
				)}
			</div>
			{diff.data?.truncated && (
				<Callout tone="warning" className="m-3 mb-0">
					diff 超过 4 MB，已截断显示。
				</Callout>
			)}
			<div className="relative min-h-0 flex-1">
				{diff.isPending && <LoadingBlock text="读取 diff…" />}
				{diff.isError && (
					<EmptyState
						compact
						title="无法读取 diff"
						description={errorMessage(diff.error)}
						actions={
							<Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void diff.refetch()}>
								重试
							</Button>
						}
					/>
				)}
				{diff.data &&
					(parsed.length > 0 ? (
						<DiffView
							files={parsed}
							mode={mode}
							showFileHeaders={parsed.length > 1}
							splitLabels={mode === "split" ? splitLabelsFor(file.area) : undefined}
							className="absolute inset-0 pb-4"
							aria-label={`${file.path} 的 diff（${mode === "split" ? "并排" : "行内"}）`}
						/>
					) : raw.trim() ? (
						<div className="absolute inset-0">
							<CodeBlock code={raw} language="diff" className="h-full" maxHeight="100%" />
						</div>
					) : (
						<div className="px-4 py-3 text-xs text-fg-3">没有可显示的差异</div>
					))}
			</div>
			<div className="flex min-h-7 shrink-0 items-center gap-3 border-t border-border bg-bg px-4 text-2xs text-fg-3">
				<code className="min-w-0 flex-1 truncate text-2xs text-fg-3">{diffCommand(file.area, file.path)}</code>
				<span className="shrink-0">pi-web-agent · {server.config.name}</span>
			</div>
		</section>
	);
}

function GitView({ workspace, server }: { workspace: WorkspaceConfig; server: ServerView }) {
	const wsId = workspace.id;
	const navigate = useNavigate();
	const [params, setParams] = useSearchParams();
	const status = useGitStatus(wsId, { retry: false });
	const isRepo = status.data?.isRepo === true;
	const log = useGitLog(wsId, isRepo);
	const mode = useWorkspacePrefs((s) => s.diffMode);
	const setPrefs = useWorkspacePrefs((s) => s.set);
	const lastSession = useUiStore((s) => s.lastSession[wsId]);
	const [refreshing, setRefreshing] = useState(false);

	const files = status.data?.files ?? [];
	const groups = useMemo(() => groupGitFiles(files), [files]);
	const ordered = useMemo(() => GIT_AREA_ORDER.flatMap((a) => groups[a]), [groups]);

	const requested: Selection | undefined = useMemo(() => {
		const path = params.get("path");
		const area = params.get("area");
		if (!path) return undefined;
		return { path, area: area && AREA_VALUES.includes(area) ? (area as GitArea) : "unstaged" };
	}, [params]);
	const selectedFile =
		(requested && (ordered.find((f) => sameFile(requested, f)) ?? ordered.find((f) => f.path === requested.path))) || ordered[0];

	const diff = useGitDiff(wsId, selectedFile ? { path: selectedFile.path, area: selectedFile.area } : undefined);
	const unpushed = useMemo(
		() => unpushedHashes(log.data?.commits ?? [], status.data?.upstream, status.data?.ahead ?? 0),
		[log.data, status.data?.upstream, status.data?.ahead],
	);

	const select = (f: GitFileStatus) =>
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.set("path", f.path);
				next.set("area", f.area);
				return next;
			},
			{ replace: true },
		);

	const refresh = async () => {
		setRefreshing(true);
		try {
			await invalidateWorkspaceGit(wsId);
		} finally {
			setRefreshing(false);
		}
	};

	const review = () => {
		if (!selectedFile || !diff.data) return;
		const parsed = parseUnifiedDiff(diff.data.diff)[0];
		const { text } = buildReviewPrompt({
			path: selectedFile.path,
			area: selectedFile.area,
			diff: diff.data.diff,
			additions: parsed?.additions ?? selectedFile.additions ?? 0,
			deletions: parsed?.deletions ?? selectedFile.deletions ?? 0,
		});
		navigate(chatPrefillPath(wsId, text, lastSession));
	};

	if (status.isPending) return <LoadingBlock text="读取 git status…" />;
	if (status.isError) {
		return (
			<EmptyState
				icon={<GitBranch />}
				title="无法读取 Git 状态"
				description={errorMessage(status.error)}
				actions={
					<Button icon={<RefreshCw size={13} />} onClick={() => void refresh()}>
						重试
					</Button>
				}
			/>
		);
	}
	if (!isRepo) {
		return (
			<EmptyState
				icon={<GitBranch />}
				title="不是 Git 仓库"
				description={
					<>
						工作区目录 <code className="text-fg-code">{workspace.path}</code> 不在 Git 仓库中，无法查看变更。
					</>
				}
				actions={
					<Button icon={<RefreshCw size={13} />} loading={refreshing} onClick={() => void refresh()}>
						重新检测
					</Button>
				}
			/>
		);
	}

	const data = status.data as GitStatusResult;
	const count = changedFileCount(data);
	const canReview = Boolean(selectedFile && diff.data && diff.data.diff.trim());

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
				<BranchInfo status={data} readAt={status.dataUpdatedAt} />
				<div className="flex-1" />
				<Segmented
					aria-label="Diff 显示方式"
					tone="sunken"
					options={[
						{ value: "inline", label: "行内" },
						{ value: "split", label: "并排" },
					]}
					value={mode}
					onChange={(v) => setPrefs({ diffMode: v })}
					className="[&_button]:h-[26px] [&_button]:px-3"
				/>
				<Button
					variant="primary"
					icon={<MessageSquare size={14} strokeWidth={1.9} />}
					disabled={!canReview}
					title={canReview ? "跳转到对话，并在输入框预填该文件的 diff" : "选择一个有变更的文件"}
					onClick={review}
				>
					发给 pi 审阅
				</Button>
				<span
					title="Git 视图为只读，不会修改仓库"
					className="flex h-[22px] items-center gap-1 rounded-full border border-border px-2 text-2xs text-fg-3"
				>
					<Lock size={11} strokeWidth={2} aria-hidden="true" />
					只读
				</span>
			</div>
			<div className="flex min-h-0 flex-1 max-md:flex-col">
				<section
					aria-labelledby="git-changes"
					className="flex min-h-0 shrink-0 flex-col gap-3.5 overflow-y-auto border-border bg-panel px-2 pt-2.5 pb-4 max-md:max-h-[45%] max-md:border-b md:w-[260px] md:border-r xl:w-[300px]"
				>
					<div className="flex items-center gap-2 pl-2">
						<h2 id="git-changes" className="m-0 text-sm font-semibold text-fg">
							工作区变更
						</h2>
						<span className="flex-1 text-xs text-fg-3">{count} 个文件</span>
						<IconButton aria-label="重新读取 git status" size="md" onClick={() => void refresh()} disabled={refreshing}>
							<RefreshCw size={14} strokeWidth={1.8} className={cn(refreshing && "animate-spin")} />
						</IconButton>
					</div>
					{GIT_AREA_ORDER.filter((a) => a !== "conflict" || groups.conflict.length > 0).map((area) => (
						<ChangeGroup key={area} area={area} files={groups[area]} selection={selectedFile} onSelect={select} />
					))}
					<CommitList
						commits={log.data?.commits ?? []}
						unpushed={unpushed}
						loading={log.isPending}
						error={log.isError ? errorMessage(log.error) : undefined}
					/>
				</section>
				<DiffPanel workspace={workspace} server={server} status={data} file={selectedFile} mode={mode} />
			</div>
		</div>
	);
}

/** Route: /w/:workspaceId/git (?path=&area= preselects a file). Read-only changes, diffs and recent commits. */
export default function GitPage() {
	return (
		<WorkspaceGate title="Git 变更查看">
			{({ workspace, server }) => <GitView key={workspace.id} workspace={workspace} server={server} />}
		</WorkspaceGate>
	);
}
