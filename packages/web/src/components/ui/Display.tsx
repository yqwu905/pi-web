import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cloneElement, type HTMLAttributes, isValidElement, type ReactElement, type ReactNode, useId } from "react";
import { cn } from "../../lib/cn";
import type { Tone } from "../../lib/status";

// ---------- Card ----------

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
	title?: ReactNode;
	/** Accent icon before the title (lucide, 15px). */
	icon?: ReactNode;
	/** Right side of the header (buttons, meta text). */
	actions?: ReactNode;
	/** Gray text next to the title. */
	description?: ReactNode;
	/** Body padding (default true). */
	padded?: boolean;
	/** Footer bar with a top border (e.g. dialog-like actions). */
	footer?: ReactNode;
	/** 8px (default) or 10px corner radius (wizard panels). */
	radius?: "lg" | "xl";
	bodyClassName?: string;
}

/** Panel section: bg #13161C, 1px border, header row with 44px min height. */
export function Card({ title, icon, actions, description, padded = true, footer, radius = "lg", className, bodyClassName, children, ...rest }: CardProps) {
	const id = useId();
	return (
		<section
			aria-labelledby={title ? `${id}-title` : undefined}
			className={cn("flex min-w-0 flex-col border border-border bg-panel", radius === "xl" ? "rounded-xl" : "rounded-lg", className)}
			{...rest}
		>
			{(title || actions) && (
				<div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2">
					{icon && <span className="flex shrink-0 items-center text-accent [&_svg]:size-[15px]">{icon}</span>}
					{title && (
						<h2 id={`${id}-title`} className="m-0 text-base font-semibold text-fg">
							{title}
						</h2>
					)}
					{description && <span className="text-xs text-fg-3">{description}</span>}
					<span className="flex-1" />
					{actions}
				</div>
			)}
			<div className={cn("min-w-0 flex-1", padded && "p-4", bodyClassName)}>{children}</div>
			{footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
		</section>
	);
}

// ---------- Badge ----------

export type BadgeTone = Tone | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
	neutral: "bg-chip text-fg-2 border-border",
	accent: "bg-selected text-link border-transparent",
	info: "bg-selected text-link border-transparent",
	success: "bg-success-soft text-success-fg border-transparent",
	warning: "bg-warning-strong text-warning-fg border-transparent",
	danger: "bg-danger-soft text-danger border-transparent",
};

const DOT_TONES: Record<BadgeTone, string> = {
	neutral: "bg-fg-3",
	accent: "bg-accent",
	info: "bg-accent",
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-danger-strong",
};

export interface BadgeProps {
	tone?: BadgeTone;
	/** tag: 4px radius, 11px semibold (信息/警告); pill: rounded, 12px (在线 · 12ms); count: tiny number. */
	shape?: "tag" | "pill" | "count";
	/** Leading status dot (pill shape). */
	dot?: boolean;
	icon?: ReactNode;
	children: ReactNode;
	className?: string;
	title?: string;
}

export function Badge({ tone = "neutral", shape = "tag", dot, icon, children, className, title }: BadgeProps) {
	return (
		<span
			title={title}
			className={cn(
				"inline-flex shrink-0 items-center whitespace-nowrap border",
				shape === "tag" && "h-5 gap-1 rounded-sm px-1.5 text-2xs font-semibold",
				shape === "pill" && "h-[22px] gap-1.5 rounded-full px-2 text-xs font-medium",
				shape === "count" && "gap-1 rounded-full px-1.5 py-px text-2xs leading-4",
				shape === "count" && tone === "warning" ? "border-transparent bg-warning-muted text-warning" : BADGE_TONES[tone],
				className,
			)}
		>
			{dot && <span aria-hidden="true" className={cn("size-[7px] rounded-full", DOT_TONES[tone])} />}
			{icon}
			{children}
		</span>
	);
}

// ---------- StatusDot ----------

const STATUS_DOT: Record<Tone, string> = {
	neutral: "bg-fg-3",
	accent: "bg-accent",
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-danger-strong",
};
const STATUS_TEXT: Record<Tone, string> = {
	neutral: "text-fg-3",
	accent: "text-link",
	success: "text-fg-3",
	warning: "text-warning",
	danger: "text-danger",
};

export interface StatusDotProps {
	tone?: Tone;
	/** Outlined circle (offline / idle). */
	hollow?: boolean;
	/** Pulsing (running). */
	pulse?: boolean;
	/** Visible text after the dot. */
	label?: ReactNode;
	/** Accessible text when there is no visible label. */
	srLabel?: string;
	size?: number;
	/** Color the label with the tone (default: muted gray except accent/warning/danger). */
	textClassName?: string;
	className?: string;
}

/** 8px status dot (+ optional text) as used in the sidebar and server headers. */
export function StatusDot({ tone = "neutral", hollow, pulse, label, srLabel, size = 8, textClassName, className }: StatusDotProps) {
	const dot = (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block shrink-0 rounded-full",
				hollow ? "border-[1.5px] border-fg-4" : STATUS_DOT[tone],
				pulse && "animate-pulse-dot",
			)}
			style={{ width: size, height: size }}
		/>
	);
	if (!label) {
		return (
			<span className={cn("inline-flex items-center", className)}>
				{dot}
				{srLabel && <span className="sr-only">{srLabel}</span>}
			</span>
		);
	}
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
			{dot}
			<span className={cn("truncate text-2xs font-medium", textClassName ?? STATUS_TEXT[tone])}>{label}</span>
		</span>
	);
}

// ---------- ProgressBar ----------

export interface ProgressBarProps {
	/** 0–100; omit for an indeterminate bar. */
	value?: number;
	/** md: 6px (overall), sm: 4px (per step). */
	size?: "sm" | "md";
	tone?: "accent" | "success" | "warning" | "danger";
	label: string;
	className?: string;
}

const PROGRESS_TONES = { accent: "bg-accent", success: "bg-success", warning: "bg-warning", danger: "bg-danger-strong" };

export function ProgressBar({ value, size = "md", tone = "accent", label, className }: ProgressBarProps) {
	const clamped = value === undefined ? undefined : Math.max(0, Math.min(100, value));
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={clamped === undefined ? undefined : Math.round(clamped)}
			className={cn("relative w-full overflow-hidden bg-border", size === "md" ? "h-1.5 rounded-[3px]" : "h-1 rounded-[2px]", className)}
		>
			<div
				className={cn("h-full transition-[width] duration-300", PROGRESS_TONES[tone], clamped === undefined && "w-1/3 animate-pulse-dot")}
				style={clamped === undefined ? undefined : { width: `${clamped}%` }}
			/>
		</div>
	);
}

// ---------- EmptyState ----------

export interface EmptyStateProps {
	icon?: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	/** Buttons / links. */
	actions?: ReactNode;
	className?: string;
	/** Less vertical padding (inside cards/lists). */
	compact?: boolean;
}

export function EmptyState({ icon, title, description, actions, className, compact }: EmptyStateProps) {
	return (
		<div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-16", className)}>
			{icon && (
				<span
					aria-hidden="true"
					className="flex size-10 items-center justify-center rounded-lg border border-border bg-raised text-accent [&_svg]:size-5"
				>
					{icon}
				</span>
			)}
			<h2 className={cn("m-0 font-semibold text-fg", compact ? "text-sm" : "text-lg")}>{title}</h2>
			{description && <p className="m-0 max-w-md text-sm text-fg-2">{description}</p>}
			{actions && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
		</div>
	);
}

// ---------- KeyValue ----------

export interface KeyValueItem {
	label: ReactNode;
	value: ReactNode;
	/** Gray text after the value ("与 Host 一致"). */
	hint?: ReactNode;
	/** Render the value in JetBrains Mono. */
	mono?: boolean;
	key?: string;
}

export interface KeyValueProps {
	items: readonly KeyValueItem[];
	/** Label column width in px (artboards use 72–104). */
	labelWidth?: number;
	className?: string;
}

/** Definition list rows separated by borders (服务器概览 · 运行环境). */
export function KeyValue({ items, labelWidth = 104, className }: KeyValueProps) {
	return (
		<dl className={cn("m-0 flex flex-col", className)}>
			{items.map((item, i) => (
				<div
					key={item.key ?? i}
					className={cn("grid items-baseline gap-3 py-2", i < items.length - 1 && "border-b border-border")}
					style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` }}
				>
					<dt className="text-sm text-fg-2">{item.label}</dt>
					<dd className="m-0 flex min-w-0 flex-wrap items-baseline gap-2 text-sm text-fg">
						{item.mono ? <code className="text-mono break-all text-fg">{item.value}</code> : item.value}
						{item.hint && <span className="text-xs text-fg-2">{item.hint}</span>}
					</dd>
				</div>
			))}
		</dl>
	);
}

// ---------- Tooltip (lite) ----------

/** Native tooltip via the `title` attribute on the single child element. */
export function Tooltip({ content, children }: { content: string; children: ReactElement<{ title?: string }> }) {
	if (!isValidElement(children)) return children;
	return cloneElement(children, { title: content });
}

// ---------- Kbd ----------

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<kbd className={cn("inline-flex h-[18px] items-center rounded-sm border border-border bg-raised px-1 font-mono text-2xs text-fg-2", className)}>
			{children}
		</kbd>
	);
}

// ---------- Callout ----------

const CALLOUT_TONES = {
	warning: { box: "border-warning-border bg-warning-soft", title: "text-warning-fg", body: "text-warning-body", icon: <TriangleAlert className="text-warning" /> },
	info: { box: "border-user-border bg-user", title: "text-link", body: "text-fg-2", icon: <Info className="text-accent" /> },
	success: { box: "border-success/30 bg-success-soft", title: "text-success-fg", body: "text-fg-2", icon: <CircleCheck className="text-success" /> },
	danger: { box: "border-danger/40 bg-danger-soft", title: "text-danger", body: "text-fg-2", icon: <CircleAlert className="text-danger" /> },
};

export interface CalloutProps {
	tone?: keyof typeof CALLOUT_TONES;
	title?: ReactNode;
	children?: ReactNode;
	/** Buttons under the text (e.g. "运行结束后重启会话"). */
	actions?: ReactNode;
	/** Hide the leading icon. */
	plain?: boolean;
	className?: string;
}

/** Tinted notice box, e.g. "配置已更新" (warning) in the chat side panel or settings warnings. */
export function Callout({ tone = "warning", title, children, actions, plain, className }: CalloutProps) {
	const t = CALLOUT_TONES[tone];
	return (
		<div role={tone === "danger" ? "alert" : "note"} className={cn("flex items-start gap-2 rounded-lg border px-3 py-2.5", t.box, className)}>
			{!plain && <span className="mt-0.5 flex shrink-0 [&_svg]:size-3.5" aria-hidden="true">{t.icon}</span>}
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				{title && <span className={cn("text-sm font-semibold", t.title)}>{title}</span>}
				{children && <div className={cn("text-xs leading-[18px]", title ? t.body : t.title)}>{children}</div>}
				{actions && <div className="flex flex-wrap gap-2 pt-0.5">{actions}</div>}
			</div>
		</div>
	);
}
