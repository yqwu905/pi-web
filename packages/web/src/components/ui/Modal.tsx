import { X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { IconButton } from "./IconButton";

const FOCUSABLE =
	'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Open modals, topmost last: only the top one reacts to Esc / Tab. */
const modalStack: string[] = [];

function focusables(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
}

export type ModalSize = "sm" | "md" | "lg" | "xl";

const SIZES: Record<ModalSize, string> = {
	sm: "max-w-[420px]",
	md: "max-w-[520px]",
	lg: "max-w-[720px]",
	xl: "max-w-[1040px]",
};

export interface ModalProps {
	open: boolean;
	/** Called on Esc, overlay click and the close button. */
	onClose: () => void;
	title: ReactNode;
	description?: ReactNode;
	/** Icon before the title (e.g. warning triangle for confirms). */
	icon?: ReactNode;
	/** Right side of the title row (e.g. extension tag). */
	titleAside?: ReactNode;
	children?: ReactNode;
	/** Footer row: hint text on the left via `footerHint`, buttons right-aligned. */
	footer?: ReactNode;
	footerHint?: ReactNode;
	size?: ModalSize;
	/** Fixed tall layout with a scrolling body (session tree). */
	tall?: boolean;
	closeOnOverlay?: boolean;
	closeOnEsc?: boolean;
	hideClose?: boolean;
	/** Element to focus on open; default: first [data-autofocus], then first form field, then the dialog. */
	initialFocus?: RefObject<HTMLElement | null>;
	className?: string;
	bodyClassName?: string;
	/** "alertdialog" for confirmations that need a response. */
	role?: "dialog" | "alertdialog";
}

/**
 * Accessible modal dialog rendered in a portal: overlay rgba(8,10,14,.72), panel #13161C with
 * a #33405A border, Esc to close, focus trapped inside and restored to the opener on close.
 */
export function Modal({
	open,
	onClose,
	title,
	description,
	icon,
	titleAside,
	children,
	footer,
	footerHint,
	size = "md",
	tall,
	closeOnOverlay = true,
	closeOnEsc = true,
	hideClose,
	initialFocus,
	className,
	bodyClassName,
	role = "dialog",
}: ModalProps) {
	const id = useId();
	const panelRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	const optsRef = useRef({ closeOnEsc });
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
		optsRef.current = { closeOnEsc };
	});

	useEffect(() => {
		if (!open) return;
		const previouslyFocused = document.activeElement as HTMLElement | null;
		modalStack.push(id);
		const { overflow } = document.body.style;
		document.body.style.overflow = "hidden";

		const panel = panelRef.current;
		if (panel) {
			const target =
				initialFocus?.current ??
				panel.querySelector<HTMLElement>("[data-autofocus]") ??
				panel.querySelector<HTMLElement>("input:not([disabled]):not([type=hidden]), textarea:not([disabled]), select:not([disabled])") ??
				panel;
			target.focus({ preventScroll: true });
		}

		const onKeyDown = (e: KeyboardEvent) => {
			// Bubble phase: inner widgets (menus, autocompletes) can stopPropagation to keep Esc.
			if (e.defaultPrevented || modalStack[modalStack.length - 1] !== id) return;
			if (e.key === "Escape" && optsRef.current.closeOnEsc) {
				e.stopPropagation();
				e.preventDefault();
				onCloseRef.current();
				return;
			}
			if (e.key === "Tab" && panelRef.current) {
				const items = focusables(panelRef.current);
				if (items.length === 0) {
					e.preventDefault();
					panelRef.current.focus();
					return;
				}
				const first = items[0];
				const last = items[items.length - 1];
				const active = document.activeElement;
				if (e.shiftKey && (active === first || active === panelRef.current)) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && active === last) {
					e.preventDefault();
					first.focus();
				} else if (!panelRef.current.contains(active)) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			const i = modalStack.lastIndexOf(id);
			if (i >= 0) modalStack.splice(i, 1);
			if (modalStack.length === 0) document.body.style.overflow = overflow;
			if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
		};
		// initialFocus is only read when the modal opens.
	}, [open, id]);

	if (!open) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 sm:p-6"
			onMouseDown={(e) => {
				if (closeOnOverlay && e.target === e.currentTarget) onCloseRef.current();
			}}
		>
			<div
				ref={panelRef}
				role={role}
				aria-modal="true"
				aria-labelledby={`${id}-title`}
				aria-describedby={description ? `${id}-desc` : undefined}
				tabIndex={-1}
				className={cn(
					"flex max-h-full w-full flex-col rounded-xl border border-border-strong bg-panel shadow-pop outline-none",
					SIZES[size],
					tall && "h-[min(760px,100%)] overflow-hidden",
					className,
				)}
			>
				<div className={cn("flex shrink-0 flex-col gap-1.5 px-[18px] pt-[18px]", tall && "border-b border-border pb-3")}>
					<div className="flex items-center gap-2">
						{icon && <span className="flex shrink-0 items-center [&_svg]:size-4">{icon}</span>}
						<h2 id={`${id}-title`} className="m-0 min-w-0 flex-1 text-md font-semibold text-fg">
							{title}
						</h2>
						{titleAside}
						{!hideClose && (
							<IconButton aria-label="关闭" variant="subtle" size="sm" onClick={() => onCloseRef.current()}>
								<X size={14} strokeWidth={2} />
							</IconButton>
						)}
					</div>
					{description && (
						<p id={`${id}-desc`} className="m-0 text-sm text-fg-2">
							{description}
						</p>
					)}
				</div>
				<div className={cn("min-h-0 flex-1 overflow-y-auto px-[18px] pt-3 pb-[18px]", tall && "p-0", bodyClassName)}>{children}</div>
				{(footer || footerHint) && (
					<div className={cn("flex shrink-0 flex-wrap items-center gap-2 px-[18px] pb-[18px]", tall && "border-t border-border pt-3")}>
						<span className="min-w-0 flex-1 text-xs text-fg-3">{footerHint}</span>
						{footer}
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
