import type { ProbeResult, ServerView } from "@pi-web/shared";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Callout } from "../../../components/ui/Display";
import { LoadingBlock } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { CHECK_STATUS_LABELS, type CheckStatus, type ProbeCheck, probeChecks, probeSummary } from "../lib/probe-checks";

const STATUS_CLASS: Record<CheckStatus, string> = { pass: "text-success-fg", warn: "text-warning-fg", fail: "text-danger" };

function StatusIcon({ status }: { status: CheckStatus }) {
	if (status === "pass") return <CircleCheck size={14} className="shrink-0 text-success" aria-hidden="true" />;
	if (status === "warn") return <TriangleAlert size={14} className="shrink-0 text-warning" aria-hidden="true" />;
	return <CircleX size={14} className="shrink-0 text-danger-strong" aria-hidden="true" />;
}

function CheckRow({ check, first }: { check: ProbeCheck; first: boolean }) {
	const highlighted = check.status !== "pass";
	return (
		<li
			className={cn(
				"flex flex-wrap gap-x-3 gap-y-1.5 px-4 py-2.5",
				highlighted ? "items-start" : "items-center",
				check.status === "warn" && "border-y border-warning-border bg-warning-soft",
				check.status === "fail" && "border-y border-danger/40 bg-danger-faint",
				!highlighted && !first && "border-t border-border",
			)}
		>
			<span className={cn("flex w-14 shrink-0 items-center gap-1.5 text-xs leading-5", STATUS_CLASS[check.status])}>
				<StatusIcon status={check.status} />
				{CHECK_STATUS_LABELS[check.status]}
			</span>
			<span className="w-24 shrink-0 text-sm leading-5 text-fg-2">{check.label}</span>
			<span className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5 text-sm leading-5 text-fg">
				<span>
					{check.key === "glibc" || check.key === "home" || check.key === "shell" ? <code className="text-mono">{check.value}</code> : check.value}
					{check.hint && <span className="text-fg-2">{check.hint}</span>}
				</span>
				{check.suggestion && <span className={cn("text-xs", check.status === "fail" ? "text-danger" : "text-warning-fg")}>{check.suggestion}</span>}
			</span>
			<code className="text-xs leading-5 text-fg-3">{check.command}</code>
		</li>
	);
}

export interface ProbeStepProps {
	view: ServerView;
	result: ProbeResult | undefined;
	running: boolean;
	error: string | null;
	durationMs: number | null;
	onProbe: () => void;
	onNext: () => void;
	onBack: () => void;
}

export function ProbeStep({ view, result, running, error, durationMs, onProbe, onNext, onBack }: ProbeStepProps) {
	const checks = result ? probeChecks(result) : [];
	const summary = result ? probeSummary(result, checks) : null;
	const c = view.config;
	return (
		<section aria-labelledby="as-probe-t" aria-busy={running} className="flex flex-col rounded-xl border border-border bg-panel">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3.5">
				<h2 id="as-probe-t" className="m-0 text-base font-semibold">
					环境探测
				</h2>
				<span className="flex-1 text-xs text-fg-3">
					{c.username}@{c.host}
					{durationMs !== null && !running ? ` · 用时 ${(durationMs / 1000).toFixed(1)} s` : ""} · 探测命令均为只读
				</span>
				{summary && (
					<>
						<span className="text-xs text-success-fg">{summary.pass} 项通过</span>
						{summary.warn > 0 && <span className="text-xs text-warning-fg">{summary.warn} 项提示</span>}
						{summary.fail > 0 && <span className="text-xs text-danger">{summary.fail} 项未通过</span>}
					</>
				)}
			</div>
			{running ? (
				<LoadingBlock text="正在探测服务器环境…" />
			) : error ? (
				<div className="p-4">
					<Callout
						tone="danger"
						title="探测失败"
						actions={
							<Button size="sm" onClick={onBack}>
								返回修改连接信息
							</Button>
						}
					>
						{error}
					</Callout>
				</div>
			) : result ? (
				<>
					<ul className="m-0 flex list-none flex-col p-0">
						{checks.map((check, i) => (
							<CheckRow key={check.key} check={check} first={i === 0} />
						))}
					</ul>
					{(result.issues.length > 0 || result.warnings.length > 0) && (
						<div className="flex flex-col gap-2 px-4 pt-3">
							{result.issues.length > 0 && (
								<Callout tone="danger" title="无法部署">
									<ul className="m-0 flex list-disc flex-col gap-0.5 pl-4">
										{result.issues.map((x) => (
											<li key={x}>{x}</li>
										))}
									</ul>
								</Callout>
							)}
							{result.warnings.length > 0 && (
								<Callout tone="warning" title="提示">
									<ul className="m-0 flex list-disc flex-col gap-0.5 pl-4">
										{result.warnings.map((x) => (
											<li key={x}>{x}</li>
										))}
									</ul>
								</Callout>
							)}
						</div>
					)}
				</>
			) : null}
			<div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
				<span className="min-w-0 flex-[1_1_240px] text-xs text-fg-3">
					{summary?.blocking ? "请先解决未通过的项目，再重新探测" : "提示项不阻止部署，可在下一步开启隧道代理"}
				</span>
				<Button onClick={onProbe} disabled={running}>
					重新探测
				</Button>
				<Button variant="primary" onClick={onNext} disabled={running || !result || Boolean(summary?.blocking)}>
					下一步
				</Button>
			</div>
		</section>
	);
}
