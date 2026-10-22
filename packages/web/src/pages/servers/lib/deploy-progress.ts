/** Display helpers for DeployProgress (overall percentage, byte totals, step status text). */
import type { DeployProgress, DeployStep, DeployStepId } from "@pi-web/shared";

export const DEPLOY_STEP_ORDER: readonly DeployStepId[] = [
	"probe",
	"prepare",
	"upload_node",
	"upload_pi",
	"upload_agent",
	"install",
	"start_agent",
	"sync",
	"selfcheck",
];

/** Fallback labels (the host sends its own `label`). */
export const DEPLOY_STEP_LABELS: Record<DeployStepId, string> = {
	probe: "探测服务器",
	prepare: "准备离线包",
	upload_node: "上传 Node.js 运行时",
	upload_pi: "上传 pi",
	upload_agent: "上传 Remote Agent",
	install: "解压并安装",
	start_agent: "启动 pi-web-agent",
	sync: "同步配置",
	selfcheck: "自检（pi --version、模型列表、代理连通性）",
};

export const STEP_STATUS_TEXT: Record<DeployStep["status"], string> = {
	pending: "等待",
	running: "进行中",
	done: "完成",
	skipped: "跳过",
	error: "失败",
};

export const DEPLOY_STATE_TEXT: Record<DeployProgress["state"], string> = {
	running: "部署中",
	done: "部署完成",
	error: "部署失败",
	cancelled: "已取消",
};

/** Steps shown before a job exists (all pending). */
export function placeholderSteps(): DeployStep[] {
	return DEPLOY_STEP_ORDER.map((id) => ({ id, label: DEPLOY_STEP_LABELS[id], status: "pending" }));
}

/** Fraction (0..1) of one step: byte progress for uploads, otherwise all-or-nothing. */
export function stepFraction(step: DeployStep): number {
	if (step.status === "done" || step.status === "skipped") return 1;
	if (step.status === "running") {
		if (step.bytesTotal && step.bytesTotal > 0) return Math.min(1, Math.max(0, (step.bytesDone ?? 0) / step.bytesTotal));
		return 0.3;
	}
	return 0;
}

/** Overall progress 0..100; every step weighs the same. */
export function deployPercent(job: Pick<DeployProgress, "state" | "steps">): number {
	if (job.state === "done") return 100;
	if (job.steps.length === 0) return 0;
	const sum = job.steps.reduce((n, s) => n + stepFraction(s), 0);
	return Math.min(99, Math.round((sum / job.steps.length) * 100));
}

/** Bytes uploaded / to upload across steps that report byte progress (skipped steps excluded). */
export function uploadTotals(steps: readonly DeployStep[]): { done: number; total: number } {
	let done = 0;
	let total = 0;
	for (const s of steps) {
		if (!s.bytesTotal || s.status === "skipped") continue;
		total += s.bytesTotal;
		done += s.status === "done" ? s.bytesTotal : Math.min(s.bytesTotal, s.bytesDone ?? 0);
	}
	return { done, total };
}

export function stepLabel(step: DeployStep): string {
	return step.label || DEPLOY_STEP_LABELS[step.id] || step.id;
}

/** The step currently running, else the failed one. */
export function activeStep(job: Pick<DeployProgress, "steps">): DeployStep | undefined {
	return job.steps.find((s) => s.status === "running") ?? job.steps.find((s) => s.status === "error");
}

export function elapsedMs(job: Pick<DeployProgress, "startedAt" | "finishedAt">, now: number): number {
	return Math.max(0, (job.finishedAt ?? now) - job.startedAt);
}

/**
 * Transfer rate estimate from two samples of the same step (bytes/second), or undefined.
 * Samples older than 15 s or from another step are ignored.
 */
export function transferRate(
	prev: { stepId: DeployStepId; bytes: number; at: number } | undefined,
	next: { stepId: DeployStepId; bytes: number; at: number },
): number | undefined {
	if (!prev || prev.stepId !== next.stepId) return undefined;
	const dt = next.at - prev.at;
	if (dt <= 0 || dt > 15_000) return undefined;
	const db = next.bytes - prev.bytes;
	return db >= 0 ? (db / dt) * 1000 : undefined;
}

/** Splits a log line "[13:41:57] text" (or any "[…] text") into time and message. */
export function splitLogLine(line: string): { time?: string; text: string } {
	const m = /^\[([^\]]{1,32})\]\s?(.*)$/s.exec(line);
	return m ? { time: m[1], text: m[2] } : { text: line };
}
