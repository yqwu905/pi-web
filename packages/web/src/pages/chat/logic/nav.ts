/** The jump rail beside the message list: one mark per user message. */
import { contentToText } from "@pi-web/shared";
import type { DisplayItem } from "./messages";

/** Longest text kept for the hover preview. */
const PREVIEW_CHARS = 400;

export interface NavTarget {
	/** DisplayItem key (also the message element's data-nav-key). */
	key: string;
	/** Message text for the preview (trimmed and shortened; empty for an image-only message). */
	text: string;
	images: number;
}

/** The user messages of the list, oldest first. */
export function navTargets(items: readonly DisplayItem[]): NavTarget[] {
	const targets: NavTarget[] = [];
	for (const item of items) {
		if (item.kind !== "user") continue;
		const { content } = item.message;
		const text = contentToText(content).trim();
		targets.push({
			key: item.key,
			text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text,
			images: Array.isArray(content) ? content.filter((c) => c.type === "image").length : 0,
		});
	}
	return targets;
}

/** Same marks and previews (navTargets builds a new list on every streamed delta). */
export function sameNavTargets(a: readonly NavTarget[], b: readonly NavTarget[]): boolean {
	return a === b || (a.length === b.length && a.every((t, i) => t.key === b[i].key && t.text === b[i].text && t.images === b[i].images));
}

/**
 * The user message whose turn is being read: the last rendered one whose top is above `line`.
 * `rendered` are the messages in the DOM, in order (older ones may be paged out above them).
 * When none is above the line, the message before the first rendered one, else the first.
 */
export function activeNavKey(targets: readonly NavTarget[], rendered: ReadonlyArray<{ key: string; top: number }>, line: number): string | undefined {
	let active: string | undefined;
	for (const r of rendered) {
		if (r.top > line) break;
		active = r.key;
	}
	if (active !== undefined) return active;
	const first = rendered.length > 0 ? targets.findIndex((t) => t.key === rendered[0].key) : -1;
	return targets[first < 0 ? targets.length - 1 : Math.max(0, first - 1)]?.key;
}
