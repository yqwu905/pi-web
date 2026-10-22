import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "../../lib/cn";

export type IconButtonVariant = "ghost" | "secondary" | "subtle";
export type IconButtonSize = "xs" | "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
	/** Required: icon-only buttons need an accessible name (also used as the tooltip). */
	"aria-label": string;
	children: ReactNode;
	variant?: IconButtonVariant;
	size?: IconButtonSize;
	/** Shows the pressed/selected look. */
	active?: boolean;
	/** Tooltip; defaults to the aria-label. Pass "" to suppress. */
	title?: string;
	ref?: Ref<HTMLButtonElement>;
}

const SIZES: Record<IconButtonSize, string> = {
	xs: "size-5 rounded-sm",
	sm: "size-6 rounded-sm",
	md: "size-7 rounded-md",
	lg: "size-8 rounded-md",
};

const VARIANTS: Record<IconButtonVariant, string> = {
	ghost: "bg-transparent text-fg-2 border border-transparent hover:bg-raised hover:text-fg",
	subtle: "bg-transparent text-fg-3 border border-transparent hover:bg-raised hover:text-fg",
	secondary: "bg-raised text-fg-2 border border-border hover:border-border-strong hover:text-fg",
};

/** Square icon-only button (关闭 ×, 更多操作 …, 添加 +). */
export function IconButton({
	variant = "ghost",
	size = "lg",
	active,
	className,
	children,
	type = "button",
	title,
	ref,
	...rest
}: IconButtonProps) {
	return (
		<button
			ref={ref}
			type={type}
			title={title ?? rest["aria-label"]}
			className={cn(
				"inline-flex shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50",
				SIZES[size],
				VARIANTS[variant],
				active && "bg-selected text-fg",
				className,
			)}
			{...rest}
		>
			{children}
		</button>
	);
}
