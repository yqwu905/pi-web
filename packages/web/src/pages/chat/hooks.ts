import { createContext, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FirstSeen } from "./logic/usage";

/** First time this client saw a running tool / pending dialog (for elapsed and countdown display). */
export const firstSeen = new FirstSeen();

/** Thinking block spans observed while streaming, keyed by `${messageTimestamp}:${contentIndex}`. */
export const thinkingSpans = new Map<string, { start: number; end?: number }>();

/**
 * `value`, updated at most every `intervalMs` while `throttle` is on (always current otherwise).
 * Used for the reply that is still streaming: parsing its Markdown on every token is costly.
 */
export function useThrottledValue<T>(value: T, intervalMs: number, throttle: boolean): T {
	const [shown, setShown] = useState(value);
	const lastAt = useRef(0);
	useEffect(() => {
		if (!throttle) return;
		const wait = lastAt.current + intervalMs - Date.now();
		if (wait <= 0) {
			lastAt.current = Date.now();
			setShown(value);
			return;
		}
		const timer = setTimeout(() => {
			lastAt.current = Date.now();
			setShown(value);
		}, wait);
		return () => clearTimeout(timer);
	}, [value, intervalMs, throttle]);
	return throttle ? shown : value;
}

/** Current time, re-rendering every `intervalMs` while `enabled`. */
export function useNow(intervalMs: number, enabled = true): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs, enabled]);
	return now;
}

function readStored<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

/** useState persisted in localStorage (small UI preferences only). */
export function useStoredState<T>(key: string, fallback: T): [T, (value: T) => void] {
	const [value, setValue] = useState<T>(() => readStored(key, fallback));
	const set = useCallback(
		(next: T) => {
			setValue(next);
			try {
				localStorage.setItem(key, JSON.stringify(next));
			} catch {
				// storage unavailable: keep the in-memory value
			}
		},
		[key],
	);
	return [value, set];
}

/** True while the viewport is at least `minWidth` px wide. */
export function useMediaMinWidth(minWidth: number): boolean {
	const query = `(min-width: ${minWidth}px)`;
	const [matches, setMatches] = useState(() => (typeof window === "undefined" ? true : window.matchMedia(query).matches));
	useEffect(() => {
		const mql = window.matchMedia(query);
		const onChange = () => setMatches(mql.matches);
		onChange();
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

const STICK_THRESHOLD_PX = 48;

/** useStickToBottom's keepInView, for cards that just grew. */
export const KeepInViewContext = createContext<((anchor: HTMLElement | null) => void) | null>(null);

/**
 * Keeps a scroll container pinned to the bottom while content grows, until the user scrolls
 * up; getting back near the bottom (by scrolling, or because content shrank) re-pins it.
 * `resetKey` changes re-pin (new session). `keepInView(anchor)`, called in a layout effect right
 * after `anchor` grew, unpins the view when following that growth to the bottom would scroll
 * the top of `anchor` out of view, and brings as much of `anchor` into view as fits instead.
 */
export function useStickToBottom(
	scrollRef: RefObject<HTMLElement | null>,
	contentRef: RefObject<HTMLElement | null>,
	resetKey: unknown,
): { atBottom: boolean; scrollToBottom: (smooth?: boolean) => void; keepInView: (anchor: HTMLElement | null) => void } {
	const stick = useRef(true);
	const lastTop = useRef(0);
	const [atBottom, setAtBottom] = useState(true);

	const scrollToBottom = useCallback(
		(smooth = false) => {
			const el = scrollRef.current;
			if (!el) return;
			stick.current = true;
			setAtBottom(true);
			el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
		},
		[scrollRef],
	);

	const keepInView = useCallback(
		(anchor: HTMLElement | null) => {
			const el = scrollRef.current;
			if (!el || !anchor || !stick.current) return;
			// How far the pinned view is about to scroll (the ResizeObserver runs after this layout).
			const shift = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (shift <= 0 || anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - shift >= 0) return;
			stick.current = false;
			setAtBottom(false);
			anchor.scrollIntoView({ block: "nearest" });
		},
		[scrollRef],
	);

	useLayoutEffect(() => {
		stick.current = true;
		setAtBottom(true);
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [resetKey, scrollRef]);

	useEffect(() => {
		const el = scrollRef.current;
		const content = contentRef.current;
		if (!el || !content) return;
		const onScroll = () => {
			const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
			if (distance <= STICK_THRESHOLD_PX) stick.current = true;
			else if (el.scrollTop < lastTop.current) stick.current = false;
			lastTop.current = el.scrollTop;
			setAtBottom(stick.current);
		};
		// Content growth (streaming) and viewport shrink (composer grows) both keep a pinned view at the
		// bottom; an unpinned view that ends up at the bottom without scrolling (content shrank) is pinned again.
		const observer = new ResizeObserver(() => {
			if (!stick.current && el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX) {
				stick.current = true;
				setAtBottom(true);
			}
			if (stick.current) el.scrollTop = el.scrollHeight;
		});
		observer.observe(content);
		observer.observe(el);
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			observer.disconnect();
			el.removeEventListener("scroll", onScroll);
		};
	}, [scrollRef, contentRef]);

	return { atBottom, scrollToBottom, keepInView };
}
