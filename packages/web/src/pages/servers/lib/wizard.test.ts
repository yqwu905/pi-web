import type { ServerView } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { INITIAL_WIZARD, parseStepParam, resumeWizard, stepViews, wizardReducer } from "./wizard";

function view(partial: { hostKey?: boolean; deployed?: boolean; deployState?: ServerView["status"]["deployState"] }): ServerView {
	return {
		config: {
			id: "s1",
			...(partial.hostKey ? { hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:x", trustedAt: 1 } } : {}),
			...(partial.deployed ? { deployed: { piVersion: "1.4.0" } } : {}),
		} as unknown as ServerView["config"],
		status: { serverId: "s1", deployState: partial.deployState ?? "unknown" } as ServerView["status"],
	};
}

describe("wizardReducer", () => {
	it("advances on complete and only navigates to reached steps", () => {
		let s = wizardReducer(INITIAL_WIZARD, { type: "goto", step: 3 });
		expect(s.step).toBe(1);
		s = wizardReducer(s, { type: "complete", step: 1 });
		expect(s).toMatchObject({ step: 2, reached: 2, completed: [1] });
		s = wizardReducer(s, { type: "goto", step: 1 });
		expect(s.step).toBe(1);
		expect(s.reached).toBe(2);
		s = wizardReducer(s, { type: "goto", step: 2 });
		expect(s.step).toBe(2);
	});

	it("records skipped steps when jumping ahead", () => {
		const s = wizardReducer(INITIAL_WIZARD, { type: "complete", step: 1, next: 3, skipped: [2] });
		expect(s).toEqual({ step: 3, reached: 3, completed: [1, 2], skipped: [2] });
		const views = stepViews(s);
		expect(views[1]).toMatchObject({ state: "done", statusText: "已跳过", navigable: true });
		expect(views[2]).toMatchObject({ state: "current", statusText: "当前" });
		expect(views[3]).toMatchObject({ state: "todo", statusText: "未开始", navigable: false });
	});

	it("completing a skipped step normally clears the skipped mark", () => {
		let s = wizardReducer(INITIAL_WIZARD, { type: "complete", step: 1, next: 3, skipped: [2] });
		s = wizardReducer(s, { type: "goto", step: 2 });
		s = wizardReducer(s, { type: "complete", step: 2 });
		expect(s.skipped).toEqual([]);
		expect(s.completed).toEqual([1, 2]);
	});

	it("restartFrom drops later progress", () => {
		let s = wizardReducer(INITIAL_WIZARD, { type: "complete", step: 1 });
		s = wizardReducer(s, { type: "complete", step: 2 });
		s = wizardReducer(s, { type: "complete", step: 3 });
		s = wizardReducer(s, { type: "goto", step: 1 });
		s = wizardReducer(s, { type: "restartFrom", step: 2 });
		expect(s).toEqual({ step: 2, reached: 2, completed: [1], skipped: [] });
	});

	it("never goes past step 5", () => {
		const s = wizardReducer({ step: 5, reached: 5, completed: [1, 2, 3, 4], skipped: [] }, { type: "complete", step: 5 });
		expect(s.step).toBe(5);
		expect(s.completed).toContain(5);
	});

	it("shows revisitable steps", () => {
		let s = wizardReducer(INITIAL_WIZARD, { type: "complete", step: 1 });
		s = wizardReducer(s, { type: "goto", step: 1 });
		expect(stepViews(s)[1]).toMatchObject({ state: "todo", statusText: "可返回", navigable: true });
	});
});

describe("resumeWizard", () => {
	it("maps server progress to the step to resume", () => {
		expect(resumeWizard(undefined)).toEqual(INITIAL_WIZARD);
		expect(resumeWizard(view({})).step).toBe(2);
		expect(resumeWizard(view({ hostKey: true })).step).toBe(3);
		expect(resumeWizard(view({ hostKey: true, deployState: "deploying" })).step).toBe(4);
		expect(resumeWizard(view({ hostKey: true, deployed: true })).step).toBe(5);
		expect(resumeWizard(view({ hostKey: true }), { state: "running" } as never).step).toBe(4);
	});
	it("parses the step param", () => {
		expect(parseStepParam("3")).toBe(3);
		expect(parseStepParam("6")).toBeNull();
		expect(parseStepParam(null)).toBeNull();
	});
});
