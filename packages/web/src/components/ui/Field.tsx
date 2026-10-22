import { cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from "react";
import { cn } from "../../lib/cn";

export interface FieldProps {
	label: ReactNode;
	/** Gray helper text under the control. */
	hint?: ReactNode;
	/** Error text (replaces the hint, red). */
	error?: ReactNode;
	/** Right-aligned text on the label row (e.g. the selected path). */
	aside?: ReactNode;
	/** A single control element; it receives `id`, `aria-describedby` and `aria-invalid`. */
	children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
	className?: string;
	required?: boolean;
}

/** Label (12px, fg-2) + control + hint/error, wired up for accessibility. */
export function Field({ label, hint, error, aside, children, className, required }: FieldProps) {
	const autoId = useId();
	const controlId = (isValidElement(children) && children.props.id) || `field-${autoId}`;
	const descId = hint || error ? `${controlId}-desc` : undefined;
	const control = isValidElement(children)
		? cloneElement(children, {
				id: controlId,
				"aria-describedby": descId,
				"aria-invalid": error ? true : children.props["aria-invalid"],
			})
		: children;
	return (
		<div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
			<div className="flex items-baseline justify-between gap-3">
				<label htmlFor={controlId} className="text-xs font-medium text-fg-2">
					{label}
					{required && <span className="ml-0.5 text-danger">*</span>}
				</label>
				{aside && <span className="min-w-0 truncate text-xs text-fg-2">{aside}</span>}
			</div>
			{control}
			{(error || hint) && (
				<span id={descId} className={cn("text-xs", error ? "text-danger" : "text-fg-3")}>
					{error || hint}
				</span>
			)}
		</div>
	);
}

/** Small letter-spaced section label ("服务器", "上下文", "用量"). */
export function SectionLabel({ children, className, as: Tag = "span", id }: { children: ReactNode; className?: string; as?: "span" | "h2" | "h3" | "div"; id?: string }) {
	return (
		<Tag id={id} className={cn("m-0 section-label", className)}>
			{children}
		</Tag>
	);
}
