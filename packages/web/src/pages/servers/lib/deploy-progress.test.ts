import type { DeployStep } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { activeStep, deployPercent, elapsedMs, placeholderSteps, splitLogLine, stepFraction, transferRate, uploadTotals } from "./deploy-progress";

const step = (id: DeployStep["id"], status: DeployStep["status"], extra: Partial<DeployStep> = {}): DeployStep => ({ id, label: id, status, ...extra });

describe("deploy progress", () => {
	it("weights steps equally with byte progress for uploads", () => {
		expect(stepFraction(step("prepare", "done"))).toBe(1);
		expect(stepFraction(step("upload_node", "skipped"))).toBe(1);
		expect(stepFraction(step("upload_pi", "running", { bytesDone: 25, bytesTotal: 100 }))).toBe(0.25);
		expect(stepFraction(step("install", "running"))).toBe(0.3);
		expect(stepFraction(step("sync", "pending"))).toBe(0);
		const steps = [step("probe", "done"), step("upload_pi", "running", { bytesDone: 50, bytesTotal: 100 }), step("install", "pending"), step("sync", "pending")];
		expect(deployPercent({ state: "running", steps })).toBe(38);
		expect(deployPercent({ state: "done", steps })).toBe(100);
		expect(deployPercent({ state: "running", steps: [step("probe", "done")] })).toBe(99);
		expect(deployPercent({ state: "running", steps: [] })).toBe(0);
	});

	it("totals uploaded bytes, ignoring skipped uploads", () => {
		const steps = [
			step("upload_node", "done", { bytesDone: 10, bytesTotal: 30 }),
			step("upload_pi", "running", { bytesDone: 20, bytesTotal: 40 }),
			step("upload_agent", "skipped", { bytesTotal: 5 }),
			step("install", "pending"),
		];
		expect(uploadTotals(steps)).toEqual({ done: 50, total: 70 });
	});

	it("finds the active step and elapsed time", () => {
		const steps = [step("probe", "done"), step("prepare", "error"), step("install", "pending")];
		expect(activeStep({ steps })?.id).toBe("prepare");
		expect(activeStep({ steps: [...steps, step("sync", "running")] })?.id).toBe("sync");
		expect(elapsedMs({ startedAt: 1000 }, 4000)).toBe(3000);
		expect(elapsedMs({ startedAt: 1000, finishedAt: 2000 }, 9000)).toBe(1000);
	});

	it("estimates transfer rates from samples of the same step", () => {
		expect(transferRate(undefined, { stepId: "upload_pi", bytes: 10, at: 1 })).toBeUndefined();
		expect(transferRate({ stepId: "upload_pi", bytes: 0, at: 0 }, { stepId: "upload_pi", bytes: 2000, at: 1000 })).toBe(2000);
		expect(transferRate({ stepId: "upload_node", bytes: 0, at: 0 }, { stepId: "upload_pi", bytes: 2000, at: 1000 })).toBeUndefined();
		expect(transferRate({ stepId: "upload_pi", bytes: 0, at: 0 }, { stepId: "upload_pi", bytes: 2000, at: 20_000 })).toBeUndefined();
	});

	it("provides placeholder steps and splits log lines", () => {
		expect(placeholderSteps()).toHaveLength(9);
		expect(placeholderSteps().every((s) => s.status === "pending" && s.label)).toBe(true);
		expect(splitLogLine("[13:41:57] 离线包命中缓存")).toEqual({ time: "13:41:57", text: "离线包命中缓存" });
		expect(splitLogLine("plain")).toEqual({ text: "plain" });
	});
});
