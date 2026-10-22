import type { GitFileStatus } from "@pi-web/shared";
import { cn } from "../../lib/cn";
import type { Tone } from "../../lib/status";
import { gitBadge } from "./lib/git";

const TONES: Record<Tone, { tree: string; list: string }> = {
	warning: { tree: "bg-warning-strong text-warning-fg", list: "bg-warning-muted text-warning-fg" },
	success: { tree: "bg-success-soft text-success-fg", list: "bg-success-soft text-success-fg" },
	danger: { tree: "bg-danger-soft text-danger", list: "bg-danger-soft text-danger" },
	accent: { tree: "bg-selected text-link", list: "bg-selected text-link" },
	neutral: { tree: "bg-chip text-fg-2", list: "bg-chip text-fg-2" },
};

/**
 * Git status letter (M / A / D / R / U / !) with a screen-reader label, as in the Files tree
 * ("tree": 5px padding) and the Git change list ("list": fixed 18px min width).
 */
export function GitStatusLetter({ file, variant = "tree", className }: { file: Pick<GitFileStatus, "code" | "area">; variant?: "tree" | "list"; className?: string }) {
	const badge = gitBadge(file);
	return (
		<>
			<span
				aria-hidden="true"
				title={badge.label}
				className={cn(
					"shrink-0 rounded-sm font-mono text-2xs leading-4 font-semibold",
					variant === "tree" ? "px-[5px]" : "min-w-[18px] px-1 text-center leading-[18px]",
					TONES[badge.tone][variant],
					className,
				)}
			>
				{badge.letter}
			</span>
			<span className="sr-only">{badge.label}</span>
		</>
	);
}
