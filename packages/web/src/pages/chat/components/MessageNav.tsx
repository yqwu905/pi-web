import { Image as ImageIcon } from "lucide-react";
import { type KeyboardEvent, memo, type RefObject, useEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn";
import { activeNavKey, type NavTarget, sameNavTargets } from "../logic/nav";

/**
 * Where the message being read is picked, as a share of the view's height from its top. Near the
 * end it moves down to the bottom of the view, so a short last turn becomes current there.
 */
const READING_LINE = 0.4;
/** Without scrollend events, a jump has ended once the list did not scroll for this long. */
const SETTLE_MS = 150;
const HAS_SCROLLEND = typeof window !== "undefined" && "onscrollend" in window;

interface Preview {
	index: number;
	/** Center of the hovered mark, in px from the top of the rail. */
	top: number;
}

export interface MessageNavProps {
	/** The user messages, oldest first. */
	targets: NavTarget[];
	/** The scrolling message list (its user messages carry data-nav-key). */
	scrollRef: RefObject<HTMLElement | null>;
	onJump: (key: string) => void;
}

/**
 * Jump rail on the right of the message list: one mark per user message, the one whose turn is
 * in view highlighted. Hovering (or focusing) a mark previews the message; clicking jumps to it.
 * One tab stop (the current mark); ↑ ↓ Home End move between the marks. Hidden on phones (no
 * hover, no room beside the messages).
 */
export const MessageNav = memo(
	function MessageNav({ targets, scrollRef, onJump }: MessageNavProps) {
		const [active, setActive] = useState<string | undefined>(undefined);
		const [preview, setPreview] = useState<Preview | null>(null);
		/** The mark just clicked (plays its pop animation once). */
		const [popped, setPopped] = useState<string | null>(null);
		const navRef = useRef<HTMLElement>(null);
		const railRef = useRef<HTMLDivElement>(null);
		/**
		 * The mark clicked last stays current (short turns would make the next one current, the end of
		 * the list the last one) until the list scrolls away from where the jump left it.
		 */
		const pin = useRef<{ settledAt: number | null } | null>(null);
		const settleTimer = useRef(0);
		/** Records where the jump ended, after SETTLE_MS without scrolling (also when it did not scroll at all). */
		const settleLater = (el: HTMLElement) => {
			clearTimeout(settleTimer.current);
			settleTimer.current = window.setTimeout(() => {
				if (pin.current) pin.current.settledAt = el.scrollTop;
			}, SETTLE_MS);
		};
		useEffect(() => () => clearTimeout(settleTimer.current), []);

		useEffect(() => {
			const el = scrollRef.current;
			if (!el) return;
			let frame = 0;
			const update = () => {
				frame = 0;
				const p = pin.current;
				if (p) {
					if (p.settledAt === null || Math.abs(el.scrollTop - p.settledAt) <= 2) return;
					pin.current = null;
				}
				const box = el.getBoundingClientRect();
				const rendered = Array.from(el.querySelectorAll<HTMLElement>("[data-nav-key]"), (node) => ({
					key: node.dataset.navKey ?? "",
					top: node.getBoundingClientRect().top - box.top,
				}));
				const height = el.clientHeight;
				const toEnd = el.scrollHeight - el.scrollTop - height;
				setActive(activeNavKey(targets, rendered, height * READING_LINE + Math.max(0, height * (1 - READING_LINE) - toEnd)));
			};
			const schedule = () => {
				if (!frame) frame = requestAnimationFrame(update);
			};
			const onScroll = () => {
				if (pin.current?.settledAt === null) {
					if (HAS_SCROLLEND) clearTimeout(settleTimer.current);
					else settleLater(el);
				}
				schedule();
			};
			const onScrollEnd = () => {
				if (pin.current?.settledAt !== null) return;
				clearTimeout(settleTimer.current);
				pin.current.settledAt = el.scrollTop;
			};
			update();
			// Content growth scrolls a pinned view (scroll event); a resize of the view moves the reading line.
			const observer = new ResizeObserver(schedule);
			observer.observe(el);
			el.addEventListener("scroll", onScroll, { passive: true });
			el.addEventListener("scrollend", onScrollEnd);
			return () => {
				cancelAnimationFrame(frame);
				observer.disconnect();
				el.removeEventListener("scroll", onScroll);
				el.removeEventListener("scrollend", onScrollEnd);
			};
		}, [scrollRef, targets]);

		// Keep the active mark inside the rail when it scrolls (many messages).
		useEffect(() => {
			const rail = railRef.current;
			const mark = rail?.querySelector<HTMLElement>('[aria-current="true"]');
			if (!rail || !mark) return;
			if (mark.offsetTop < rail.scrollTop) rail.scrollTop = mark.offsetTop - 8;
			else if (mark.offsetTop + mark.offsetHeight > rail.scrollTop + rail.clientHeight) rail.scrollTop = mark.offsetTop + mark.offsetHeight - rail.clientHeight + 8;
		}, [active]);

		const show = (index: number, mark: HTMLElement) => {
			const nav = navRef.current;
			if (!nav) return;
			const box = mark.getBoundingClientRect();
			setPreview({ index, top: box.top + box.height / 2 - nav.getBoundingClientRect().top });
		};
		const shown = preview && preview.index < targets.length ? targets[preview.index] : undefined;
		const tabStop = active !== undefined && targets.some((t) => t.key === active) ? active : targets[targets.length - 1]?.key;

		const moveFocus = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
			let next: number;
			if (e.key === "ArrowUp") next = index - 1;
			else if (e.key === "ArrowDown") next = index + 1;
			else if (e.key === "Home") next = 0;
			else if (e.key === "End") next = targets.length - 1;
			else return;
			e.preventDefault();
			railRef.current?.querySelectorAll<HTMLElement>("button")[Math.max(0, Math.min(targets.length - 1, next))]?.focus();
		};

		return (
			<nav
				ref={navRef}
				aria-label="消息导航"
				onPointerLeave={() => setPreview(null)}
				className="absolute top-1/2 right-3.5 z-10 hidden max-h-[calc(100%-112px)] -translate-y-1/2 flex-col sm:flex"
			>
				<div
					ref={railRef}
					className="relative flex min-h-0 flex-col overflow-y-auto overscroll-contain rounded-lg py-1.5 transition-colors duration-200 [scrollbar-width:none] hover:bg-panel/80 motion-reduce:transition-none [&::-webkit-scrollbar]:hidden"
				>
					{targets.map((target, i) => {
						const current = target.key === active;
						return (
							<button
								key={target.key}
								type="button"
								aria-label={`跳转到第 ${i + 1} 条消息：${excerpt(target)}`}
								aria-current={current ? "true" : undefined}
								tabIndex={target.key === tabStop ? 0 : -1}
								onKeyDown={(e) => moveFocus(e, i)}
								onPointerEnter={(e) => {
									if (e.pointerType === "mouse") show(i, e.currentTarget);
								}}
								onFocus={(e) => {
									if (e.currentTarget.matches(":focus-visible")) show(i, e.currentTarget);
								}}
								onBlur={() => setPreview(null)}
								onClick={() => {
									setPopped(target.key);
									setActive(target.key);
									pin.current = { settledAt: null };
									if (scrollRef.current) settleLater(scrollRef.current);
									onJump(target.key);
								}}
								className="group/mark flex h-3 w-7 shrink-0 items-center justify-end px-1.5 focus-visible:outline-offset-[-2px]"
							>
								<span
									aria-hidden="true"
									onAnimationEnd={() => setPopped((p) => (p === target.key ? null : p))}
									className={cn(
										"block h-[2px] origin-right rounded-full transition-[width,background-color] duration-200 ease-out motion-reduce:transition-none",
										current ? "w-4 bg-accent group-hover/mark:w-[18px]" : "w-2.5 bg-fg-4 group-hover/mark:w-4 group-hover/mark:bg-fg-2",
										popped === target.key && "animate-nav-pop motion-reduce:animate-none",
									)}
								/>
							</button>
						);
					})}
				</div>
				{shown && preview && (
					<div
						aria-hidden="true"
						style={{ top: preview.top }}
						className="pointer-events-none absolute right-full mr-2 w-[280px] max-w-[calc(100vw-96px)] -translate-y-1/2 animate-nav-preview rounded-lg border border-border-strong bg-raised px-3 py-2 shadow-pop transition-[top] duration-150 ease-out motion-reduce:animate-none motion-reduce:transition-none"
					>
						<div className="mb-1 flex items-center gap-1.5 text-2xs text-fg-3">
							<span className="font-mono">#{preview.index + 1}</span>
							{shown.key === active && <span className="text-accent">当前</span>}
							{shown.images > 0 && (
								<span className="ml-auto flex items-center gap-0.5">
									<ImageIcon size={11} strokeWidth={1.9} aria-hidden="true" />
									{shown.images}
								</span>
							)}
						</div>
						<div className={cn("line-clamp-4 text-sm leading-[1.5] break-words whitespace-pre-wrap", shown.text ? "text-fg" : "text-fg-3")}>
							{shown.text || "（图片）"}
						</div>
					</div>
				)}
			</nav>
		);
	},
	(a, b) => a.scrollRef === b.scrollRef && a.onJump === b.onJump && sameNavTargets(a.targets, b.targets),
);

/** First line of the message, shortened (for the mark's accessible name). */
function excerpt(target: NavTarget): string {
	const line = target.text.split("\n", 1)[0];
	if (!line) return target.images > 0 ? "图片" : "（空）";
	return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
