import { ChevronDown } from "lucide-react";
import type { ReactNode, Ref, SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export interface SelectOption {
	value: string;
	label: ReactNode;
	disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
	options?: readonly SelectOption[];
	mono?: boolean;
	invalid?: boolean;
	size?: "sm" | "md";
	/** Class for the relative wrapper. */
	wrapperClassName?: string;
	ref?: Ref<HTMLSelectElement>;
}

/** Native select styled like the artboards (raised background, chevron on the right). */
export function Select({ options, mono, invalid, size = "md", className, wrapperClassName, children, ref, ...rest }: SelectProps) {
	return (
		<div className={cn("relative w-full", wrapperClassName)}>
			<select
				ref={ref}
				aria-invalid={invalid || undefined}
				className={cn(
					"w-full appearance-none rounded-md border bg-raised pr-7 pl-2.5 text-fg outline-none transition-colors [color-scheme:dark] focus:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
					size === "sm" ? "h-[30px]" : "h-8",
					mono ? "font-mono text-mono" : "text-sm",
					invalid ? "border-danger-strong" : "border-border",
					className,
				)}
				{...rest}
			>
				{options?.map((o) => (
					<option key={o.value} value={o.value} disabled={o.disabled}>
						{o.label}
					</option>
				))}
				{children}
			</select>
			<ChevronDown
				size={12}
				strokeWidth={2.4}
				aria-hidden="true"
				className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-3"
			/>
		</div>
	);
}
