import { type KeyboardEvent, type ReactNode, type Ref, useCallback, useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export type MenuItem =
	| {
			type?: "item";
			label: ReactNode;
			icon?: ReactNode;
			/** Right-aligned hint (shortcut, count). */
			hint?: ReactNode;
			onSelect: () => void;
			disabled?: boolean;
			danger?: boolean;
			key?: string;
	  }
	| { type: "separator"; key?: string }
	| { type: "label"; label: ReactNode; key?: string };

export interface MenuTriggerProps {
	ref: Ref<HTMLButtonElement>;
	onClick: () => void;
	onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
	"aria-haspopup": "menu";
	"aria-expanded": boolean;
	"aria-controls": string;
}

export interface MenuProps {
	/** Render the trigger and spread the given props onto a <button> (or Button / IconButton). */
	trigger: (props: MenuTriggerProps) => ReactNode;
	items: readonly MenuItem[];
	/** Horizontal alignment of the popover relative to the trigger. */
	align?: "start" | "end";
	/** Open above the trigger instead of below. */
	placement?: "bottom" | "top";
	className?: string;
	menuClassName?: string;
	"aria-label"?: string;
}

/**
 * Simple dropdown menu: click or ↓ opens, ↑/↓/Home/End move, Enter/Space selects,
 * Esc closes and returns focus to the trigger, outside click closes.
 */
export function Menu({ trigger, items, align = "end", placement = "bottom", className, menuClassName, ...aria }: MenuProps) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);

	const itemEls = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];

	const close = useCallback((restoreFocus: boolean) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!open) return;
		itemEls()[0]?.focus();
		const onPointer = (e: MouseEvent) => {
			if (!wrapperRef.current?.contains(e.target as Node)) close(false);
		};
		document.addEventListener("mousedown", onPointer);
		return () => document.removeEventListener("mousedown", onPointer);
	}, [open, close]);

	const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const els = itemEls();
		const index = els.indexOf(document.activeElement as HTMLElement);
		if (e.key === "ArrowDown") {
			e.preventDefault();
			els[(index + 1) % els.length]?.focus();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			els[(index - 1 + els.length) % els.length]?.focus();
		} else if (e.key === "Home") {
			e.preventDefault();
			els[0]?.focus();
		} else if (e.key === "End") {
			e.preventDefault();
			els[els.length - 1]?.focus();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close(true);
		} else if (e.key === "Tab") {
			close(false);
		}
	};

	const triggerProps: MenuTriggerProps = {
		ref: triggerRef,
		onClick: () => setOpen((o) => !o),
		onKeyDown: (e) => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				setOpen(true);
			}
		},
		"aria-haspopup": "menu",
		"aria-expanded": open,
		"aria-controls": `${id}-menu`,
	};

	return (
		<div ref={wrapperRef} className={cn("relative inline-flex", className)}>
			{trigger(triggerProps)}
			{open && (
				<div
					ref={menuRef}
					id={`${id}-menu`}
					role="menu"
					aria-label={aria["aria-label"]}
					tabIndex={-1}
					onKeyDown={onMenuKeyDown}
					className={cn(
						"absolute z-40 flex min-w-[180px] flex-col gap-px rounded-lg border border-border-strong bg-panel p-1 shadow-pop",
						align === "end" ? "right-0" : "left-0",
						placement === "bottom" ? "top-[calc(100%+4px)]" : "bottom-[calc(100%+4px)]",
						menuClassName,
					)}
				>
					{items.map((item, i) => {
						if (item.type === "separator") return <div key={item.key ?? `sep-${i}`} role="separator" className="my-1 h-px bg-border" />;
						if (item.type === "label")
							return (
								<div key={item.key ?? `label-${i}`} className="px-2 pt-1.5 pb-1 section-label">
									{item.label}
								</div>
							);
						return (
							<button
								key={item.key ?? i}
								type="button"
								role="menuitem"
								tabIndex={-1}
								aria-disabled={item.disabled || undefined}
								onClick={() => {
									if (item.disabled) return;
									close(true);
									item.onSelect();
								}}
								className={cn(
									"flex h-8 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-sm outline-none [&_svg]:size-3.5 [&_svg]:shrink-0",
									item.danger ? "text-danger" : "text-fg",
									item.disabled ? "cursor-not-allowed opacity-50" : "hover:bg-raised focus:bg-selected",
								)}
							>
								{item.icon && <span className={cn("flex", item.danger ? "text-danger" : "text-fg-2")}>{item.icon}</span>}
								<span className="min-w-0 flex-1 truncate">{item.label}</span>
								{item.hint && <span className="text-xs text-fg-3">{item.hint}</span>}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
