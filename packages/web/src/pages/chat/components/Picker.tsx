import { Check, Search } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type Ref, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../../api/client";
import { Spinner } from "../../../components/ui";
import { cn } from "../../../lib/cn";

export interface PickerOption {
	value: string;
	label: ReactNode;
	/** Right-aligned secondary text. */
	hint?: ReactNode;
	/** Group heading shown above the first option of each group. */
	group?: string;
	/** Text matched by the search box (defaults to value). */
	searchText?: string;
}

export interface PickerTriggerProps {
	ref: Ref<HTMLButtonElement>;
	onClick: () => void;
	onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
	"aria-haspopup": "listbox";
	"aria-expanded": boolean;
	"aria-controls": string;
}

export interface PickerProps {
	/** Accessible name of the list ("选择模型"). */
	label: string;
	trigger: (props: PickerTriggerProps) => ReactNode;
	/** Called each time the picker opens. */
	load: () => Promise<PickerOption[]>;
	value?: string;
	onSelect: (value: string) => void;
	searchable?: boolean;
	searchPlaceholder?: string;
	emptyText?: string;
	className?: string;
	panelClassName?: string;
}

/** Popover list that opens above its trigger (composer toolbar): search, ↑/↓, Enter, Esc. */
export function Picker({ label, trigger, load, value, onSelect, searchable, searchPlaceholder = "搜索", emptyText = "没有可选项", className, panelClassName }: PickerProps) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [options, setOptions] = useState<PickerOption[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const loadRef = useRef(load);
	useEffect(() => {
		loadRef.current = load;
	});

	const close = useCallback((restoreFocus: boolean) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setOptions(null);
		setError(null);
		setQuery("");
		loadRef.current().then(
			(list) => {
				if (cancelled) return;
				setOptions(list);
				setActive(Math.max(0, list.findIndex((o) => o.value === value)));
			},
			(e: unknown) => {
				if (!cancelled) setError(errorMessage(e));
			},
		);
		const onPointer = (e: MouseEvent) => {
			if (!wrapperRef.current?.contains(e.target as Node)) close(false);
		};
		document.addEventListener("mousedown", onPointer);
		return () => {
			cancelled = true;
			document.removeEventListener("mousedown", onPointer);
		};
		// value is only read to place the initial highlight.
	}, [open, close]);

	useEffect(() => {
		if (!open) return;
		(searchable ? searchRef.current : listRef.current)?.focus();
	}, [open, searchable, options]);

	const filtered = useMemo(() => {
		if (!options) return [];
		const q = query.trim().toLowerCase();
		if (!q) return options;
		return options.filter((o) => (o.searchText ?? o.value).toLowerCase().includes(q));
	}, [options, query]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const choose = (option: PickerOption | undefined) => {
		if (!option) return;
		close(true);
		onSelect(option.value);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(filtered.length - 1, i + 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(0, i - 1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			choose(filtered[active]);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close(true);
		} else if (e.key === "Tab") {
			close(false);
		}
	};

	const listId = `${id}-list`;
	return (
		<div ref={wrapperRef} className={cn("relative inline-flex", className)}>
			{trigger({
				ref: triggerRef,
				onClick: () => setOpen((o) => !o),
				onKeyDown: (e) => {
					if (e.key === "ArrowUp" || e.key === "ArrowDown") {
						e.preventDefault();
						setOpen(true);
					}
				},
				"aria-haspopup": "listbox",
				"aria-expanded": open,
				"aria-controls": listId,
			})}
			{open && (
				<div
					className={cn(
						"absolute bottom-[calc(100%+6px)] left-0 z-40 flex max-h-[min(420px,60vh)] w-[320px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-lg border border-border-strong bg-panel shadow-pop",
						panelClassName,
					)}
					onKeyDown={onKeyDown}
				>
					{searchable && (
						<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
							<Search size={13} strokeWidth={1.8} className="shrink-0 text-fg-3" aria-hidden="true" />
							<input
								ref={searchRef}
								value={query}
								onChange={(e) => {
									setQuery(e.target.value);
									setActive(0);
								}}
								placeholder={searchPlaceholder}
								aria-label={searchPlaceholder}
								aria-controls={listId}
								aria-activedescendant={filtered[active] ? `${id}-opt-${active}` : undefined}
								className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-fg outline-none focus-visible:outline-none"
							/>
						</div>
					)}
					<div
						ref={listRef}
						id={listId}
						role="listbox"
						aria-label={label}
						tabIndex={searchable ? -1 : 0}
						aria-activedescendant={!searchable && filtered[active] ? `${id}-opt-${active}` : undefined}
						className="min-h-0 flex-1 overflow-y-auto p-1 outline-none"
					>
						{error ? (
							<div className="px-2 py-3 text-xs text-danger">{error}</div>
						) : !options ? (
							<div className="flex items-center gap-2 px-2 py-3 text-xs text-fg-3">
								<Spinner size={12} />
								加载中…
							</div>
						) : filtered.length === 0 ? (
							<div className="px-2 py-3 text-xs text-fg-3">{emptyText}</div>
						) : (
							filtered.map((o, i) => {
								const showGroup = o.group && (i === 0 || filtered[i - 1].group !== o.group);
								const selected = o.value === value;
								return (
									<div key={o.value}>
										{showGroup && <div className="px-2 pt-2 pb-1 section-label">{o.group}</div>}
										<div
											id={`${id}-opt-${i}`}
											data-index={i}
											role="option"
											aria-selected={selected}
											onMouseDown={(e) => e.preventDefault()}
											onMouseEnter={() => setActive(i)}
											onClick={() => choose(o)}
											className={cn(
												"flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm",
												i === active ? "bg-selected text-fg" : "text-fg-2",
											)}
										>
											<span className="min-w-0 flex-1 truncate">{o.label}</span>
											{o.hint && <span className="shrink-0 text-2xs text-fg-3">{o.hint}</span>}
											<Check size={13} strokeWidth={2.2} className={cn("shrink-0 text-accent", !selected && "invisible")} aria-hidden="true" />
										</div>
									</div>
								);
							})
						)}
					</div>
				</div>
			)}
		</div>
	);
}
