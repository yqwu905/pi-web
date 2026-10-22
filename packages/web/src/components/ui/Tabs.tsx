import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { NavLink } from "react-router";
import { cn } from "../../lib/cn";

const TAB_BASE =
	"flex h-[39px] shrink-0 items-center gap-1.5 border-0 border-b-2 bg-transparent px-3 text-sm whitespace-nowrap transition-colors [&_svg]:size-3.5";
const TAB_ON = "border-accent font-semibold text-fg hover:text-fg";
const TAB_OFF = "border-transparent text-fg-2 hover:text-fg";

export interface TabItem<T extends string = string> {
	value: T;
	label: ReactNode;
	icon?: ReactNode;
	/** Count badge after the label. */
	badge?: ReactNode;
	disabled?: boolean;
}

export interface TabsProps<T extends string> {
	items: readonly TabItem<T>[];
	value: T;
	onChange: (value: T) => void;
	"aria-label": string;
	/** Prefix for tab/panel ids so <TabPanel> can reference them. */
	idPrefix?: string;
	className?: string;
}

/** Button tabs (role="tablist") with an accent underline; ←/→/Home/End move between tabs. */
export function Tabs<T extends string>({ items, value, onChange, idPrefix = "tabs", className, ...aria }: TabsProps<T>) {
	const listRef = useRef<HTMLDivElement>(null);
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const enabled = items.filter((i) => !i.disabled);
		const index = enabled.findIndex((i) => i.value === value);
		let next: TabItem<T> | undefined;
		if (e.key === "ArrowRight") next = enabled[(index + 1) % enabled.length];
		else if (e.key === "ArrowLeft") next = enabled[(index - 1 + enabled.length) % enabled.length];
		else if (e.key === "Home") next = enabled[0];
		else if (e.key === "End") next = enabled[enabled.length - 1];
		if (!next) return;
		e.preventDefault();
		onChange(next.value);
		listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${idPrefix}-tab-${next.value}`)}`)?.focus();
	};
	return (
		<div
			ref={listRef}
			role="tablist"
			aria-label={aria["aria-label"]}
			onKeyDown={onKeyDown}
			className={cn("flex items-end gap-1 overflow-x-auto border-b border-border", className)}
		>
			{items.map((item) => {
				const selected = item.value === value;
				return (
					<button
						key={item.value}
						id={`${idPrefix}-tab-${item.value}`}
						type="button"
						role="tab"
						aria-selected={selected}
						aria-controls={`${idPrefix}-panel-${item.value}`}
						tabIndex={selected ? 0 : -1}
						disabled={item.disabled}
						onClick={() => onChange(item.value)}
						className={cn(TAB_BASE, selected ? TAB_ON : TAB_OFF, "disabled:cursor-not-allowed disabled:opacity-50")}
					>
						{item.icon}
						{item.label}
						{item.badge}
					</button>
				);
			})}
		</div>
	);
}

/** Panel for <Tabs>; renders only when active. */
export function TabPanel({ idPrefix = "tabs", value, active, children, className }: { idPrefix?: string; value: string; active: boolean; children: ReactNode; className?: string }) {
	if (!active) return null;
	return (
		<div role="tabpanel" id={`${idPrefix}-panel-${value}`} aria-labelledby={`${idPrefix}-tab-${value}`} className={className}>
			{children}
		</div>
	);
}

export interface NavTabItem {
	to: string;
	label: ReactNode;
	icon?: ReactNode;
	badge?: ReactNode;
	/** Exact match only (default false: nested paths keep the tab active). */
	end?: boolean;
	/** Force the active state (e.g. when the link target differs from the matched path). */
	active?: boolean;
}

/** Route tabs (links) with the same look, e.g. 对话 / 文件 / 终端 / Git. */
export function NavTabs({ items, className, "aria-label": ariaLabel }: { items: readonly NavTabItem[]; className?: string; "aria-label": string }) {
	return (
		<nav aria-label={ariaLabel} className={cn("flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border px-4", className)}>
			{items.map((item) => (
				<NavLink
					key={item.to}
					to={item.to}
					end={item.end}
					className={({ isActive }) => cn(TAB_BASE, (item.active ?? isActive) ? TAB_ON : TAB_OFF)}
					aria-current={item.active ? "page" : undefined}
				>
					{item.icon}
					{item.label}
					{item.badge}
				</NavLink>
			))}
		</nav>
	);
}
