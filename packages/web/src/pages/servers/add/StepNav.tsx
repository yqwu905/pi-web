import { Check } from "lucide-react";
import { cn } from "../../../lib/cn";
import { stepViews, type WizardState, type WizardStep } from "../lib/wizard";

const BAR: Record<string, string> = { done: "bg-success", current: "bg-accent", todo: "bg-border" };
const DOT: Record<string, string> = {
	done: "bg-success-soft text-success-fg",
	current: "bg-primary text-white",
	todo: "border border-border-strong text-fg-2",
};
const LABEL: Record<string, string> = { done: "font-medium text-fg-2", current: "font-semibold text-fg", todo: "font-medium text-fg-3" };
const STATUS: Record<string, string> = { done: "text-success-fg", current: "text-link", todo: "text-fg-3" };

/** The five-step progress header; reached steps are buttons. */
export function StepNav({ state, onPick }: { state: WizardState; onPick: (step: WizardStep) => void }) {
	return (
		<nav aria-label="添加步骤">
			<ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(160px,100%),1fr))] gap-3 p-0">
				{stepViews(state).map((s) => (
					<li key={s.n} className="flex min-w-0">
						<button
							type="button"
							disabled={!s.navigable}
							aria-current={s.state === "current" ? "step" : undefined}
							onClick={() => onPick(s.n)}
							className="flex w-full flex-col gap-2.5 border-0 bg-transparent p-0 pb-1 text-left text-inherit disabled:cursor-default"
						>
							<span aria-hidden="true" className={cn("block h-[3px] w-full rounded-[2px]", BAR[s.state])} />
							<span className="flex w-full items-center gap-2">
								<span
									className={cn("flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-2xs font-semibold", DOT[s.state])}
									aria-hidden="true"
								>
									{s.state === "done" ? <Check size={12} strokeWidth={2.6} /> : s.n}
								</span>
								<span className={cn("min-w-0 flex-1 truncate text-sm", LABEL[s.state])}>
									<span className="sr-only">第 {s.n} 步：</span>
									{s.label}
								</span>
								<span className={cn("shrink-0 text-2xs", STATUS[s.state])}>{s.statusText}</span>
							</span>
						</button>
					</li>
				))}
			</ol>
		</nav>
	);
}
