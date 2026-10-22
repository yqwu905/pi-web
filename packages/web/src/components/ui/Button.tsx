import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Link, type LinkProps } from "react-router";
import { cn } from "../../lib/cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "warning" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
	primary: "bg-primary text-white font-semibold border border-transparent hover:bg-primary-hover",
	secondary: "bg-raised text-fg border border-border hover:border-border-strong",
	outline: "bg-transparent text-fg border border-border hover:border-border-strong hover:bg-raised",
	ghost: "bg-transparent text-fg-2 border border-transparent hover:bg-raised hover:text-fg",
	warning: "bg-warning-strong text-warning-fg font-semibold border border-warning-edge hover:border-warning",
	danger: "bg-danger-soft text-danger font-semibold border border-danger/40 hover:border-danger",
};

const SIZES: Record<ButtonSize, string> = {
	sm: "h-7 px-2.5 text-xs gap-1.5",
	md: "h-8 px-3.5 text-sm gap-1.5",
	lg: "h-9 px-4 text-sm gap-2",
};

/** Class string for button-looking elements (links, labels). */
export function buttonClass(options: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}): string {
	const { variant = "secondary", size = "md", block, className } = options;
	return cn(
		"inline-flex shrink-0 items-center justify-center rounded-md whitespace-nowrap select-none transition-colors",
		"disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
		VARIANTS[variant],
		SIZES[size],
		variant === "primary" && size === "md" && "px-4",
		block && "w-full",
		className,
	);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	/** Shows a spinner and disables the button. */
	loading?: boolean;
	/** Leading icon (lucide icons are sized automatically). */
	icon?: ReactNode;
	iconRight?: ReactNode;
	block?: boolean;
	ref?: Ref<HTMLButtonElement>;
}

/**
 * Buttons per the artboards: primary (blue, 白字), secondary (raised + border), outline,
 * ghost, warning (中止 / 重启会话), danger (删除 / 卸载). Sizes sm 28px, md 32px, lg 36px.
 */
export function Button({
	variant = "secondary",
	size = "md",
	loading = false,
	icon,
	iconRight,
	block,
	className,
	children,
	disabled,
	type = "button",
	ref,
	...rest
}: ButtonProps) {
	return (
		<button
			ref={ref}
			type={type}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			className={buttonClass({ variant, size, block, className: cn("[&_svg]:shrink-0", className) })}
			{...rest}
		>
			{loading ? <Spinner size={size === "sm" ? 12 : 13} /> : icon}
			{children}
			{iconRight}
		</button>
	);
}

export interface ButtonLinkProps extends LinkProps {
	variant?: ButtonVariant;
	size?: ButtonSize;
	icon?: ReactNode;
	block?: boolean;
}

/** react-router Link styled as a button (e.g. "设置", "完成并打开服务器"). */
export function ButtonLink({ variant = "secondary", size = "md", icon, block, className, children, ...rest }: ButtonLinkProps) {
	return (
		<Link
			className={buttonClass({
				variant,
				size,
				block,
				className: cn(
					"[&_svg]:shrink-0",
					variant === "primary" ? "text-white hover:text-white" : variant === "warning" ? "hover:text-warning-fg" : "hover:text-fg",
					className as string,
				),
			})}
			{...rest}
		>
			{icon}
			{children}
		</Link>
	);
}
