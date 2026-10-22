/**
 * Add-server wizard step state (pure): which step is shown, how far the user got, which steps
 * are complete, and how to resume a wizard for a server that was already created.
 */
import type { DeployProgress, ServerView } from "@pi-web/shared";

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export const WIZARD_STEPS: ReadonlyArray<{ n: WizardStep; label: string }> = [
	{ n: 1, label: "连接信息" },
	{ n: 2, label: "主机验证" },
	{ n: 3, label: "环境探测" },
	{ n: 4, label: "离线部署" },
	{ n: 5, label: "同步配置" },
];

export interface WizardState {
	step: WizardStep;
	/** Highest step the user may navigate to. */
	reached: WizardStep;
	completed: WizardStep[];
	/** Steps completed without user action (host key already trusted). */
	skipped: WizardStep[];
}

export type WizardAction =
	| { type: "goto"; step: WizardStep }
	/** Marks `step` complete and moves on (default: the next step). */
	| { type: "complete"; step: WizardStep; next?: WizardStep; skipped?: WizardStep[] }
	/** Invalidates `step` and everything after it (e.g. the host changed after trusting its key). */
	| { type: "restartFrom"; step: WizardStep }
	| { type: "replace"; state: WizardState };

export const INITIAL_WIZARD: WizardState = { step: 1, reached: 1, completed: [], skipped: [] };

const clampStep = (n: number): WizardStep => Math.min(5, Math.max(1, Math.round(n))) as WizardStep;
const sortSteps = (steps: WizardStep[]): WizardStep[] => [...new Set(steps)].sort((a, b) => a - b);

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
	switch (action.type) {
		case "goto":
			if (action.step > state.reached || action.step === state.step) return state;
			return { ...state, step: action.step };
		case "complete": {
			const next = action.next ?? clampStep(action.step + 1);
			const extra = action.skipped ?? [];
			const completed = sortSteps([...state.completed, action.step, ...extra]);
			const skipped = sortSteps([...state.skipped.filter((s) => s !== action.step), ...extra]);
			return { step: next, reached: clampStep(Math.max(state.reached, next)), completed, skipped };
		}
		case "restartFrom": {
			const completed = state.completed.filter((s) => s < action.step);
			const skipped = state.skipped.filter((s) => s < action.step);
			return { step: action.step, reached: action.step, completed, skipped };
		}
		case "replace":
			return action.state;
		default:
			return state;
	}
}

export type StepVisualState = "done" | "current" | "todo";

export interface StepView {
	n: WizardStep;
	label: string;
	state: StepVisualState;
	/** "完成", "当前", "已跳过", "未开始". */
	statusText: string;
	navigable: boolean;
}

export function stepViews(state: WizardState): StepView[] {
	return WIZARD_STEPS.map(({ n, label }) => {
		const current = n === state.step;
		const done = state.completed.includes(n);
		const visual: StepVisualState = current ? "current" : done ? "done" : "todo";
		const statusText = current ? "当前" : done ? (state.skipped.includes(n) ? "已跳过" : "完成") : n <= state.reached ? "可返回" : "未开始";
		return { n, label, state: visual, statusText, navigable: n <= state.reached };
	});
}

/**
 * Where to resume the wizard for an existing server (`/servers/new?server=<id>`):
 * no trusted host key → 2, trusted but not deployed → 3, deploying → 4, deployed → 5.
 */
export function resumeWizard(view: ServerView | undefined, job?: DeployProgress | null): WizardState {
	if (!view) return INITIAL_WIZARD;
	const trusted = Boolean(view.config.hostKey);
	const deploying = view.status.deployState === "deploying" || job?.state === "running";
	const deployed = Boolean(view.config.deployed) || job?.state === "done";
	if (deploying) return { step: 4, reached: 4, completed: [1, 2, 3], skipped: [] };
	if (deployed) return { step: 5, reached: 5, completed: [1, 2, 3, 4], skipped: [] };
	if (trusted) return { step: 3, reached: 3, completed: [1, 2], skipped: [] };
	return { step: 2, reached: 2, completed: [1], skipped: [] };
}

/** Parses the `step` search param (1–5), ignoring junk. */
export function parseStepParam(value: string | null): WizardStep | null {
	if (!value || !/^[1-5]$/.test(value)) return null;
	return Number(value) as WizardStep;
}
