import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const FIELD_BASE =
	"w-full rounded-md border bg-bg text-fg outline-none transition-colors placeholder:text-fg-3 focus:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
	/** JetBrains Mono 12.5px (hosts, paths, user names). */
	mono?: boolean;
	invalid?: boolean;
	/** Icon or text inside the field, before the input (e.g. search icon). */
	leading?: ReactNode;
	trailing?: ReactNode;
	size?: "sm" | "md";
	/** Class for the wrapper when leading/trailing are used. */
	wrapperClassName?: string;
	ref?: Ref<HTMLInputElement>;
}

/** Text input: 32px, bg #0E1014, border #262C37, accent border on focus. */
export function Input({ mono, invalid, leading, trailing, size = "md", className, wrapperClassName, ref, ...rest }: InputProps) {
	const text = mono ? "font-mono text-mono" : "text-sm";
	const height = size === "sm" ? "h-[30px]" : "h-8";
	const border = invalid ? "border-danger-strong" : "border-border";
	if (!leading && !trailing) {
		return (
			<input
				ref={ref}
				aria-invalid={invalid || undefined}
				className={cn(FIELD_BASE, height, "px-2.5", text, border, className)}
				{...rest}
			/>
		);
	}
	return (
		<div
			className={cn(
				"flex w-full items-center gap-2 rounded-md border bg-bg px-2.5 transition-colors focus-within:border-accent",
				height,
				border,
				rest.disabled && "opacity-60",
				wrapperClassName,
			)}
		>
			{leading && <span className="flex shrink-0 items-center text-fg-3">{leading}</span>}
			<input
				ref={ref}
				aria-invalid={invalid || undefined}
				className={cn("h-full min-w-0 flex-1 border-0 bg-transparent text-fg outline-none placeholder:text-fg-3 focus-visible:outline-none", text, className)}
				{...rest}
			/>
			{trailing && <span className="flex shrink-0 items-center text-fg-3">{trailing}</span>}
		</div>
	);
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	mono?: boolean;
	invalid?: boolean;
	ref?: Ref<HTMLTextAreaElement>;
}

/** Multi-line input; `mono` for code/JSON editors (12.5px / 19px line height). */
export function Textarea({ mono, invalid, className, rows = 4, ref, ...rest }: TextareaProps) {
	return (
		<textarea
			ref={ref}
			rows={rows}
			aria-invalid={invalid || undefined}
			className={cn(
				FIELD_BASE,
				"resize-y px-3 py-2.5",
				mono ? "font-mono text-mono leading-[19px] text-fg-code" : "text-sm",
				invalid ? "border-danger-strong" : "border-border",
				className,
			)}
			{...rest}
		/>
	);
}
