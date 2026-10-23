/**
 * Building blocks of the sectioned settings forms (服务器设置, 全局设置): a section card, a
 * label/control row, the "已修改" tag, and the left section navigation with scroll spy.
 */
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn";

export function DirtyTag({ show = true }: { show?: boolean }) {
	if (!show) return null;
	return (
		<span className="inline-flex h-[18px] items-center rounded-sm border border-warning-border bg-warning-soft px-1.5 text-2xs font-medium text-warning-fg">
			已修改
		</span>
	);
}

export interface SettingsSectionProps {
	id: string;
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	/** Warning-toned border and title (危险操作). */
	danger?: boolean;
	children: ReactNode;
	className?: string;
	/** Header without a bottom border (global settings style). */
	plainHeader?: boolean;
}

export function SettingsSection({ id, title, description, actions, danger, children, className, plainHeader }: SettingsSectionProps) {
	return (
		<section
			id={id}
			aria-labelledby={`${id}-h`}
			className={cn("scroll-mt-4 rounded-lg border bg-panel", danger ? "border-warning-border" : "border-border", className)}
		>
			<div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5", !plainHeader && "border-b border-border")}>
				<div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
					<h2 id={`${id}-h`} className={cn("m-0 flex items-center gap-2 text-lg font-semibold", danger ? "text-warning-fg" : "text-fg")}>
						{danger && <TriangleAlert size={16} strokeWidth={2} className="text-warning" aria-hidden="true" />}
						{title}
					</h2>
					{description && <p className="m-0 text-xs leading-[18px] text-fg-3">{description}</p>}
				</div>
				{actions}
			</div>
			{children}
		</section>
	);
}

export interface SettingRowProps {
	label: ReactNode;
	/** Id of the control the label points to (renders a <label>), else a plain span with `labelId`. */
	htmlFor?: string;
	labelId?: string;
	dirty?: boolean;
	children: ReactNode;
	/** First row of a section: no top border. */
	first?: boolean;
	/** Vertical alignment of the label: "input" (6px, next to a 32px field) or "text". */
	align?: "input" | "text";
	/** Label column basis (服务器设置 180px, 全局设置 168px). */
	labelWidth?: number;
	className?: string;
	mono?: boolean;
}

export function SettingRow({ label, htmlFor, labelId, dirty, children, first, align = "input", labelWidth = 180, className, mono }: SettingRowProps) {
	const labelClass = cn("text-sm leading-5 font-medium text-fg", mono && "font-mono");
	return (
		<div className={cn("flex flex-wrap gap-x-6 gap-y-2 px-4 py-3.5", !first && "border-t border-border", className)}>
			<div
				className={cn("flex max-w-full flex-wrap content-start items-center gap-1.5", align === "input" ? "pt-1.5" : "pt-0")}
				style={{ flex: `1 1 ${labelWidth}px` }}
			>
				{htmlFor ? (
					<label htmlFor={htmlFor} className={labelClass}>
						{label}
					</label>
				) : (
					<span id={labelId} className={labelClass}>
						{label}
					</span>
				)}
				<DirtyTag show={Boolean(dirty)} />
			</div>
			<div className="flex min-w-0 flex-[999_1_320px] flex-col gap-2">{children}</div>
		</div>
	);
}

/** Gray helper text under a control. */
export function Hint({ children, className, tone = "muted" }: { children: ReactNode; className?: string; tone?: "muted" | "warning" | "danger" }) {
	return (
		<span
			className={cn(
				"text-xs leading-[18px]",
				tone === "warning" ? "text-warning-fg" : tone === "danger" ? "text-danger" : "text-fg-3",
				className,
			)}
		>
			{children}
		</span>
	);
}

export interface SectionNavItem {
	id: string;
	label: string;
	icon: ReactNode;
	dirty?: boolean;
	danger?: boolean;
}

/** Quiet time after which the smooth scroll started by a nav click counts as finished. */
const CLICK_SCROLL_SETTLE_MS = 150;

/**
 * Left section navigation: anchors that scroll the section into view; the section nearest the
 * top of `scrollRoot` is highlighted (aria-current="location"). A clicked section stays
 * highlighted until the user scrolls again, even when it is too short (or too close to the end
 * of the page) to reach the top.
 */
export function SectionNav({
	items,
	scrollRoot,
	title = "分区",
	className,
}: {
	items: readonly SectionNavItem[];
	scrollRoot: HTMLElement | null;
	title?: string;
	className?: string;
}) {
	const [active, setActive] = useState(items[0]?.id);
	const idsKey = items.map((i) => i.id).join("|");
	// Set while the scroll caused by a click runs: its scroll events do not move the highlight.
	const clickScroll = useRef<ReturnType<typeof setTimeout> | null>(null);
	const settleClickScroll = () => {
		if (clickScroll.current) clearTimeout(clickScroll.current);
		clickScroll.current = setTimeout(() => (clickScroll.current = null), CLICK_SCROLL_SETTLE_MS);
	};
	useEffect(
		() => () => {
			if (clickScroll.current) clearTimeout(clickScroll.current);
		},
		[],
	);
	useEffect(() => {
		if (!scrollRoot) return;
		const ids = idsKey.split("|");
		const onScroll = () => {
			if (clickScroll.current) {
				settleClickScroll();
				return;
			}
			const rootTop = scrollRoot.getBoundingClientRect().top;
			let current = ids[0];
			for (const id of ids) {
				const el = document.getElementById(id);
				if (el && el.getBoundingClientRect().top - rootTop <= 80) current = id;
			}
			// At the very bottom the last section wins even when short.
			if (scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 4) current = ids[ids.length - 1];
			setActive(current);
		};
		onScroll();
		scrollRoot.addEventListener("scroll", onScroll, { passive: true });
		return () => scrollRoot.removeEventListener("scroll", onScroll);
	}, [scrollRoot, idsKey]);

	return (
		<nav aria-label="设置分区" className={cn("flex flex-col gap-0.5", className)}>
			<span className="px-2.5 pb-1.5 section-label">{title}</span>
			{items.map((item) => {
				const on = item.id === active;
				return (
					<a
						key={item.id}
						href={`#${item.id}`}
						aria-current={on ? "location" : undefined}
						onClick={(e) => {
							e.preventDefault();
							setActive(item.id);
							settleClickScroll();
							document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
						}}
						className={cn(
							"flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-sm [&_svg]:size-[15px] [&_svg]:shrink-0",
							on ? "bg-selected font-semibold text-fg hover:text-fg" : "text-fg-2 hover:bg-raised hover:text-fg",
						)}
					>
						<span className={cn("flex", item.danger ? "text-warning" : on ? "text-accent" : "text-fg-3")} aria-hidden="true">
							{item.icon}
						</span>
						<span className="min-w-0 flex-1 truncate">{item.label}</span>
						{item.dirty && <span className="text-2xs font-medium text-warning-fg">已修改</span>}
					</a>
				);
			})}
		</nav>
	);
}
