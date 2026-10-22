import { cn } from "../../lib/cn";

export interface SpinnerProps {
	/** Diameter in px (default 13). */
	size?: number;
	className?: string;
	/** Accessible label; when omitted the spinner is decorative. */
	label?: string;
}

/** Ring spinner from the artboards (border-strong ring, accent arc). */
export function Spinner({ size = 13, className, label }: SpinnerProps) {
	return (
		<span
			role={label ? "status" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			className={cn("inline-block shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-accent", className)}
			style={{ width: size, height: size }}
		/>
	);
}

/** Centered spinner with text, for loading panes. */
export function LoadingBlock({ text = "加载中…", className }: { text?: string; className?: string }) {
	return (
		<div className={cn("flex items-center justify-center gap-2 py-10 text-sm text-fg-3", className)} role="status">
			<Spinner size={14} />
			<span>{text}</span>
		</div>
	);
}
