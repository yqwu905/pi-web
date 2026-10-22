import type { ServerView, SyncPlan, SyncRecord } from "@pi-web/shared";
import { CircleCheck, FileDiff, RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../../../api/client";
import { Button } from "../../../components/ui/Button";
import { Callout, Card } from "../../../components/ui/Display";
import { IconButton } from "../../../components/ui/IconButton";
import { LoadingBlock } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { formatBytes, formatRelativeTime, formatTime, tildify } from "../../../lib/format";
import { paths } from "../../../lib/routes";
import type { MatrixRow } from "../lib/matrix";
import { ENTRY_KIND_LABELS, type EntryKind, entryKind, entryNote, planCounts, recordChangeText, sortEntries, TRIGGER_LABELS } from "../lib/plan";

const KIND_TAG: Record<EntryKind, string> = {
	add: "bg-success-soft text-success-fg",
	update: "bg-selected text-link",
	delete: "bg-danger-soft text-danger",
	conflict: "border border-warning-edge bg-warning-strong text-warning-fg",
};

const PILL = "inline-flex h-[22px] items-center rounded-full px-2 text-xs font-medium";

const PAGE = 100;

export interface DiffPreviewCardProps {
	row: MatrixRow;
	view: ServerView | undefined;
	hostAgentDir: string | undefined;
	plan: SyncPlan | undefined;
	loading: boolean;
	error: unknown;
	onRefresh: () => void;
	lastRecord: SyncRecord | undefined;
	syncing: boolean;
	onSync: () => void;
}

export function DiffPreviewCard({ row, view, hostAgentDir, plan, loading, error, onRefresh, lastRecord, syncing, onSync }: DiffPreviewCardProps) {
	const [showAll, setShowAll] = useState(false);
	const name = row.name;
	const d = view?.config.deployed;
	const remoteDir = d ? tildify(d.agentDir, d.home) : view?.config.agentDirMode === "shared" ? "~/.pi/agent" : `${view?.config.remoteRoot ?? "~/.pi-web"}/agent`;
	const lastText = lastRecord
		? `上次同步 ${formatRelativeTime(lastRecord.at)} · ${TRIGGER_LABELS[lastRecord.trigger]} · ${lastRecord.status === "error" ? `失败：${lastRecord.error ?? "未知错误"}` : recordChangeText(lastRecord)}`
		: row.lastSyncAt
			? `上次同步 ${formatRelativeTime(row.lastSyncAt)}`
			: "尚未同步过";

	let body: ReactNode;
	if (!view?.config.deployed && view?.status.deployState !== "deployed" && view?.status.deployState !== "outdated") {
		body = (
			<div className="p-4">
				<Callout tone="info" title="尚未部署" actions={view && <Link to={paths.server(view.config.id)}>前往服务器概览</Link>}>
					部署 Pi-Web 时会执行首次完整同步。
				</Callout>
			</div>
		);
	} else if (!row.online) {
		body = (
			<div className="p-4">
				<div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-soft p-3">
					<TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
					<div className="flex min-w-0 flex-col gap-1">
						<span className="text-sm font-semibold text-warning-fg">
							服务器离线，连接后将自动补同步{row.pendingCount > 0 ? `（${row.pendingCount} 项待同步）` : ""}
						</span>
						<span className="text-xs leading-[18px] text-fg-2">{lastText}。离线期间无法读取服务器清单，具体差异在连接后计算。</span>
					</div>
				</div>
			</div>
		);
	} else if (loading && !plan) {
		body = <LoadingBlock text="正在读取服务器清单并计算差异…" />;
	} else if (error && !plan) {
		body = (
			<div className="p-4">
				<Callout tone="danger" title="无法计算差异" actions={<Button size="sm" onClick={onRefresh}>重试</Button>}>
					{errorMessage(error)}
				</Callout>
			</div>
		);
	} else if (plan && plan.entries.length === 0) {
		body = (
			<div className="flex flex-col gap-3 px-4 py-5">
				<div className="flex items-center gap-3">
					<CircleCheck size={20} strokeWidth={1.8} className="shrink-0 text-success" aria-hidden="true" />
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="text-sm font-semibold text-success-fg">已是最新，无需同步</span>
						<span className="text-xs text-fg-3">{lastText}</span>
					</div>
				</div>
				{plan.warnings.length > 0 && <Warnings warnings={plan.warnings} />}
			</div>
		);
	} else if (plan) {
		const counts = planCounts(plan);
		const entries = sortEntries(plan.entries);
		const shown = showAll ? entries : entries.slice(0, PAGE);
		body = (
			<>
				<div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
					<span className={cn(PILL, "bg-success-soft text-success-fg")}>新增 {counts.add}</span>
					<span className={cn(PILL, "bg-selected text-link")}>修改 {counts.update}</span>
					<span className={cn(PILL, "bg-danger-soft text-danger")}>删除 {counts.delete}</span>
					<span className={cn(PILL, "border border-warning-edge bg-warning-strong text-warning-fg")}>冲突 {counts.conflict}</span>
					<span className="flex-1" />
					<span className="text-xs text-fg-3">基于 {formatTime(plan.generatedAt)} 读取的服务器清单</span>
				</div>
				{plan.warnings.length > 0 && (
					<div className="border-b border-border px-4 py-3">
						<Warnings warnings={plan.warnings} />
					</div>
				)}
				<ul className="m-0 flex list-none flex-col p-0" aria-label={`${name} 的同步差异`}>
					{shown.map((e) => {
						const kind = entryKind(e);
						const note = entryNote(e);
						return (
							<li
								key={`${e.action}:${e.path}`}
								className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2.5", kind === "conflict" && "bg-warning-soft")}
							>
								<span className={cn("w-10 flex-none rounded-sm py-0.5 text-center text-2xs font-semibold", KIND_TAG[kind])}>{ENTRY_KIND_LABELS[kind]}</span>
								<code className="min-w-0 flex-[0_1_260px] text-mono [overflow-wrap:anywhere] text-fg">{e.path}</code>
								<span className="min-w-0 flex-[1_1_280px] text-[12.5px] leading-[1.6] text-fg-2">
									{note ?? (e.bytes !== undefined ? <code className="text-xs">{formatBytes(e.bytes)}</code> : null)}
									{note && e.bytes !== undefined && <code className="ml-2 text-xs text-fg-3">{formatBytes(e.bytes)}</code>}
								</span>
							</li>
						);
					})}
				</ul>
				{entries.length > PAGE && (
					<div className="border-b border-border px-4 py-2">
						<button type="button" onClick={() => setShowAll((v) => !v)} className="border-0 bg-transparent p-0 text-xs text-link hover:text-link-hover">
							{showAll ? "收起" : `显示全部 ${entries.length} 项`}
						</button>
					</div>
				)}
			</>
		);
	} else {
		body = <LoadingBlock text="正在计算差异…" />;
	}

	const canSync = row.online && Boolean(view?.config.deployed || view?.status.deployState === "deployed" || view?.status.deployState === "outdated");
	return (
		<Card
			title={`差异预览 · ${name}`}
			icon={<FileDiff />}
			padded={false}
			aria-live="polite"
			actions={
				<span className="flex min-w-0 items-center gap-2">
					<code className="truncate text-[11.5px] text-fg-2">
						{hostAgentDir ?? "~/.pi/agent"} → {name}:{remoteDir}
					</code>
					{row.online && (
						<IconButton aria-label="重新计算差异" size="md" disabled={loading} onClick={onRefresh}>
							<RefreshCw size={13} strokeWidth={1.8} className={loading ? "animate-spin" : undefined} />
						</IconButton>
					)}
				</span>
			}
		>
			{body}
			{canSync && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
					<span className="min-w-0 flex-[1_1_320px] text-xs leading-[18px] text-fg-3">
						冲突文件先备份再覆盖，点击同步即视为确认。同步后，运行中的对话需重启会话才会加载新配置。
					</span>
					<Button variant="primary" icon={<RefreshCw size={14} strokeWidth={1.8} />} loading={syncing || row.running} onClick={onSync}>
						同步 {name}
					</Button>
				</div>
			)}
		</Card>
	);
}

function Warnings({ warnings }: { warnings: readonly string[] }) {
	return (
		<Callout tone="warning" title={`${warnings.length} 条提示`}>
			<ul className="m-0 flex list-disc flex-col gap-0.5 pl-4">
				{warnings.map((w) => (
					<li key={w}>{w}</li>
				))}
			</ul>
		</Callout>
	);
}
