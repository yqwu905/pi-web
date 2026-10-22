import type { DeployProgress, DeployStep } from "@pi-web/shared";
import { CircleCheck, CircleMinus, CircleX } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Callout, ProgressBar } from "../../../components/ui/Display";
import { Spinner } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { formatBytes, formatClock, formatRate } from "../../../lib/format";
import { useNow } from "../hooks";
import {
	DEPLOY_STATE_TEXT,
	deployPercent,
	elapsedMs,
	placeholderSteps,
	STEP_STATUS_TEXT,
	splitLogLine,
	stepLabel,
	transferRate,
	uploadTotals,
} from "../lib/deploy-progress";

const STATUS_TEXT_CLASS: Record<DeployStep["status"], string> = {
	pending: "text-fg-3",
	running: "text-link",
	done: "text-success-fg",
	skipped: "text-fg-3",
	error: "text-danger",
};

function StepIcon({ status }: { status: DeployStep["status"] }) {
	return (
		<span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
			{status === "done" ? (
				<CircleCheck size={16} strokeWidth={2} className="text-success" />
			) : status === "running" ? (
				<Spinner size={13} />
			) : status === "error" ? (
				<CircleX size={16} strokeWidth={2} className="text-danger-strong" />
			) : status === "skipped" ? (
				<CircleMinus size={16} strokeWidth={2} className="text-fg-3" />
			) : (
				<span className="block size-3 rounded-full border-[1.5px] border-fg-4" />
			)}
		</span>
	);
}

function stepDetail(step: DeployStep): string | undefined {
	if (step.bytesTotal && step.status === "running") return `${formatBytes(step.bytesDone ?? 0)} / ${formatBytes(step.bytesTotal)}`;
	if (step.bytesTotal && step.status === "done") return formatBytes(step.bytesTotal);
	return step.detail;
}

function StepRow({ step, rate, first }: { step: DeployStep; rate?: number; first: boolean }) {
	const running = step.status === "running";
	const showBytes = running && Boolean(step.bytesTotal);
	const pct = showBytes ? Math.round(((step.bytesDone ?? 0) / (step.bytesTotal as number)) * 100) : 0;
	const detail = stepDetail(step);
	const label = stepLabel(step);
	return (
		<li className={cn("flex flex-col gap-1.5", showBytes ? "py-2" : "min-h-9 justify-center py-1.5", !first && "border-t border-border")}>
			<span className="flex items-center gap-2.5">
				<StepIcon status={step.status} />
				<span className={cn("min-w-0 flex-1 text-sm", running ? "font-semibold text-fg" : step.status === "pending" ? "text-fg-2" : "text-fg")}>
					{label}
				</span>
				{detail && (
					<span
						className={cn(
							"min-w-0 truncate text-xs",
							step.bytesTotal ? "font-mono" : "",
							running ? "text-fg-code" : step.status === "error" ? "text-danger" : "text-fg-2",
						)}
						title={detail}
					>
						{detail}
					</span>
				)}
				<span className={cn("w-11 shrink-0 text-right text-xs", STATUS_TEXT_CLASS[step.status])}>{STEP_STATUS_TEXT[step.status]}</span>
			</span>
			{showBytes && (
				<span className="flex items-center gap-2.5 pl-[26px]">
					<ProgressBar size="sm" value={pct} label={label} className="flex-1" />
					<span className="font-mono text-xs text-fg-2">
						{pct}%{rate !== undefined && rate > 0 ? ` · ${formatRate(rate)}` : ""}
					</span>
				</span>
			)}
		</li>
	);
}

/** Log tail box with timestamps dimmed; expandable to the full ~200 lines the host keeps. */
export function DeployLog({ lines, tail = 6 }: { lines: readonly string[]; tail?: number }) {
	const [expanded, setExpanded] = useState(false);
	const labelId = useId();
	const preRef = useRef<HTMLPreElement>(null);
	const shown = expanded ? lines : lines.slice(-tail);
	useLayoutEffect(() => {
		const el = preRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [shown.length, expanded]);
	if (lines.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				<span id={labelId} className="section-label">
					{expanded ? `部署日志 · 全部 ${lines.length} 行` : `部署日志 · 最近 ${shown.length} 行`}
				</span>
				<span className="flex-1" />
				{lines.length > tail && (
					<button type="button" onClick={() => setExpanded((v) => !v)} className="border-0 bg-transparent p-0 text-xs text-link hover:text-link-hover">
						{expanded ? "收起" : "展开全部"}
					</button>
				)}
			</div>
			<pre
				ref={preRef}
				aria-labelledby={labelId}
				tabIndex={0}
				className={cn(
					"m-0 overflow-auto rounded-lg border border-border bg-code px-3 py-2.5 text-[11.5px] leading-[1.65] whitespace-pre text-fg-code",
					expanded && "max-h-[360px]",
				)}
			>
				{shown.map((line, i) => {
					const { time, text } = splitLogLine(line);
					return (
						<span key={`${i}-${line}`} className="block">
							{time && <span className="text-fg-3">[{time}] </span>}
							{text}
						</span>
					);
				})}
			</pre>
		</div>
	);
}

export interface DeployProgressPanelProps {
	job: DeployProgress | null | undefined;
	title?: ReactNode;
	/** Shown under the title before a job exists. */
	idleText?: ReactNode;
	/** Right side of the header when no job runs (e.g. 开始部署). */
	idleAction?: ReactNode;
	/** Extra control at the header's right end, after the percentage (e.g. a close button). */
	headerAction?: ReactNode;
	className?: string;
}

/** Live deploy progress (Add server step 4, server overview): overall bar, steps, log tail. */
export function DeployProgressPanel({ job, title = "部署进度", idleText, idleAction, headerAction, className }: DeployProgressPanelProps) {
	const titleId = useId();
	const running = job?.state === "running";
	const now = useNow(1000, running);
	const steps = job?.steps.length ? job.steps : placeholderSteps();
	const percent = job ? deployPercent(job) : 0;
	const totals = uploadTotals(steps);

	// Transfer rate of the running upload, from successive progress events.
	const runningStep = steps.find((s) => s.status === "running" && s.bytesTotal);
	const sample = useRef<{ stepId: DeployStep["id"]; bytes: number; at: number } | undefined>(undefined);
	const [rate, setRate] = useState<number | undefined>(undefined);
	const bytesDone = runningStep?.bytesDone ?? 0;
	const stepId = runningStep?.id;
	useEffect(() => {
		if (!stepId) {
			sample.current = undefined;
			setRate(undefined);
			return;
		}
		const next = { stepId, bytes: bytesDone, at: Date.now() };
		const r = transferRate(sample.current, next);
		if (r !== undefined) setRate((prev) => (prev === undefined ? r : prev * 0.5 + r * 0.5));
		else if (sample.current?.stepId !== stepId) setRate(undefined);
		sample.current = next;
	}, [stepId, bytesDone]);

	const subtitle = job
		? [
				running ? `已用时 ${formatClock(elapsedMs(job, now))}` : `${DEPLOY_STATE_TEXT[job.state]} · 用时 ${formatClock(elapsedMs(job, now))}`,
				totals.total > 0 ? `已上传 ${formatBytes(totals.done)} / ${formatBytes(totals.total)}` : null,
			]
				.filter(Boolean)
				.join(" · ")
		: idleText;
	const tone = job?.state === "error" ? "danger" : job?.state === "cancelled" ? "warning" : job?.state === "done" ? "success" : "accent";

	return (
		<section aria-labelledby={titleId} className={cn("flex min-w-0 flex-col gap-3.5 rounded-xl border border-border bg-panel p-4", className)}>
			<div className="flex items-end gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2 id={titleId} className="m-0 text-base font-semibold">
						{title}
					</h2>
					{subtitle && <span className="text-xs text-fg-3">{subtitle}</span>}
				</div>
				{job ? (
					<span className={cn("font-mono text-xl font-semibold", job.state === "error" ? "text-danger" : "text-fg")} aria-hidden="true">
						{percent}%
					</span>
				) : (
					idleAction
				)}
				{headerAction && <div className="flex shrink-0 items-center self-start">{headerAction}</div>}
			</div>
			<ProgressBar value={job ? percent : 0} tone={tone} label="总体部署进度" />
			<ol className="m-0 flex list-none flex-col p-0" aria-label="部署步骤">
				{steps.map((s, i) => (
					<StepRow key={s.id} step={s} first={i === 0} rate={s.id === stepId ? rate : undefined} />
				))}
			</ol>
			{job?.state === "error" && job.error && (
				<Callout tone="danger" title="部署失败">
					<span className="break-words">{job.error}</span>
				</Callout>
			)}
			{job?.state === "cancelled" && <Callout tone="warning" title="部署已取消">已上传的文件保留在服务器的 .upload 目录中，重新部署时会覆盖。</Callout>}
			{job && <DeployLog lines={job.log} />}
		</section>
	);
}
