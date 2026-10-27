import type { AssistantMessage, ConversationTiming } from "@pi-web/shared";
import { ArrowDown, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconButton, Spinner } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { useUiStore } from "../../../stores/ui";
import { KeepInViewContext, useStickToBottom } from "../hooks";
import type { DisplayItem } from "../logic/messages";
import { navTargets } from "../logic/nav";
import { throughputCalibration } from "../logic/usage";
import {
	AssistantGroupView,
	BashMessageCard,
	BashRunCard,
	type BashRunView,
	BranchSummaryDivider,
	CompactionDivider,
	CustomMessageView,
	UserMessageView,
} from "./MessageViews";
import { MessageNav } from "./MessageNav";
import { ToolCard } from "./ToolCard";

const PAGE = 200;
const NO_TIMING: ConversationTiming = { streaming: null, messages: {} };
/** Finalized assistant messages the live throughput estimate is calibrated on. */
const CALIBRATION_WINDOW = 10;
/** Space kept above a message the jump rail scrolled to. */
const JUMP_OFFSET_PX = 16;
const FLASH_CLASS = "animate-nav-flash";
/**
 * With the jump rail (sm and up): the 860px column keeps 16px off the right edge so the rail never
 * covers it; nothing changes where the space beside the column is wider (860 + 2 × 16 = 892).
 */
const NAV_SPACE = "sm:pr-[clamp(0px,calc(892px-100%),16px)]";

/** Highlights the message the jump rail scrolled to (restarts when it is already playing). */
function flash(el: HTMLElement) {
	el.classList.remove(FLASH_CLASS);
	void el.offsetWidth;
	el.classList.add(FLASH_CLASS);
	el.addEventListener("animationend", () => el.classList.remove(FLASH_CLASS), { once: true });
}

/** True when some item renders a tool card (tool calls of assistant groups, orphan results). */
function hasToolCards(items: readonly DisplayItem[]): boolean {
	return items.some((item) => item.kind === "tool" || (item.kind === "assistant" && item.messages.some((m) => m.parts.some((p) => p.kind === "tool"))));
}

/** The latest finalized assistant messages, oldest first (walks back from the end only). */
function recentAssistantMessages(items: readonly DisplayItem[], max: number): AssistantMessage[] {
	const found: AssistantMessage[] = [];
	for (let i = items.length - 1; i >= 0 && found.length < max; i--) {
		const item = items[i];
		if (item.kind !== "assistant") continue;
		for (let j = item.messages.length - 1; j >= 0 && found.length < max; j--) {
			if (!item.messages[j].streaming) found.push(item.messages[j].message);
		}
	}
	return found.reverse();
}

/** Expand/collapse all tool cards (the global preference; it resets every card's own toggle). */
function ToolsToggle({ className }: { className?: string }) {
	const expanded = useUiStore((s) => s.toolsExpanded);
	const setExpanded = useUiStore((s) => s.setToolsExpanded);
	const Icon = expanded ? ChevronsDownUp : ChevronsUpDown;
	return (
		<div className={cn("absolute top-2 z-10", className)}>
			<IconButton
				aria-label="展开全部工具调用"
				title={expanded ? "折叠全部工具调用" : "展开全部工具调用"}
				aria-pressed={expanded}
				active={expanded}
				variant="secondary"
				size="md"
				onClick={() => setExpanded(!expanded)}
			>
				<Icon size={15} strokeWidth={1.8} />
			</IconButton>
		</div>
	);
}

interface ItemProps {
	item: DisplayItem;
	workspaceId: string;
	timing: ConversationTiming;
	calibration?: number;
	onForkReply?: (key: string) => Promise<void>;
	forkBlocked?: string;
}

function Item({ item, workspaceId, timing, calibration, onForkReply, forkBlocked }: ItemProps) {
	switch (item.kind) {
		case "user":
			return <UserMessageView message={item.message} navKey={item.key} />;
		case "assistant":
			// Only the streaming group (the one given a calibration) gets the streaming timing: finished groups skip re-rendering on every delta.
			return (
				<AssistantGroupView
					messages={item.messages}
					workspaceId={workspaceId}
					timings={timing.messages}
					streamingTiming={calibration !== undefined ? timing.streaming : undefined}
					calibration={calibration}
					onFork={onForkReply}
					forkBlocked={forkBlocked}
				/>
			);
		case "tool":
			return <ToolCard tool={item.tool} workspaceId={workspaceId} />;
		case "bash":
			return <BashMessageCard message={item.message} />;
		case "custom":
			return <CustomMessageView message={item.message} />;
		case "compaction":
			return <CompactionDivider message={item.message} />;
		case "branchSummary":
			return <BranchSummaryDivider message={item.message} />;
		default:
			return null;
	}
}

export interface MessageListProps {
	items: DisplayItem[];
	workspaceId: string;
	/** Changing it scrolls back to the bottom (another session). */
	resetKey: string;
	/** "!cmd" runs started from this page that are not in the message list yet. */
	bashRuns: Array<BashRunView & { id: string }>;
	/** pi is running but nothing streams yet (waiting for the model). */
	waiting: boolean;
	/** Shown instead of the items (loading, empty, error). */
	placeholder?: ReactNode;
	/** Top-right overlay (side panel toggle). */
	overlay?: ReactNode;
	/** Generation timing of the conversation (throughput of assistant groups). */
	timing?: ConversationTiming;
	/** Fork a new session after the finished assistant group `key` (stable identity; the Fork button shows while set). */
	onForkReply?: (key: string) => Promise<void>;
	/** Why forking is unavailable right now (Fork buttons disabled with it as tooltip). */
	forkBlocked?: string;
}

/** Scrolling message column (860px) that follows new output unless the user scrolled up. */
export function MessageList({
	items,
	workspaceId,
	resetKey,
	bashRuns,
	waiting,
	placeholder,
	overlay,
	timing = NO_TIMING,
	onForkReply,
	forkBlocked,
}: MessageListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const { atBottom, scrollToBottom, keepInView, scrollToElement } = useStickToBottom(scrollRef, contentRef, resetKey);
	const [limit, setLimit] = useState(PAGE);
	const hidden = Math.max(0, items.length - limit);
	const visible = hidden > 0 ? items.slice(hidden) : items;
	const hasTools = useMemo(() => hasToolCards(items), [items]);
	const targets = useMemo(() => navTargets(items), [items]);
	const showNav = targets.length > 1 && !placeholder;

	// Jump rail: a new object per click, so clicking the same mark again jumps again.
	const [jump, setJump] = useState<{ key: string } | null>(null);
	const onJump = useCallback((key: string) => setJump({ key }), []);
	useLayoutEffect(() => {
		if (!jump) return;
		const index = items.findIndex((item) => item.key === jump.key);
		// Paged out: show the earlier items first, this effect runs again once they render.
		if (index >= 0 && index < hidden) {
			setLimit(items.length - index);
			return;
		}
		setJump(null);
		const target = contentRef.current?.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(jump.key)}"]`);
		if (!target) return;
		scrollToElement(target, JUMP_OFFSET_PX, !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
		flash(target);
	}, [jump, items, hidden, scrollToElement]);
	// The streaming reply is always the last item; its estimate is calibrated on the replies before it.
	const lastItem = items[items.length - 1];
	const streamingKey = lastItem?.kind === "assistant" && lastItem.messages[lastItem.messages.length - 1]?.streaming ? lastItem.key : undefined;
	const calibration = streamingKey !== undefined ? throughputCalibration(recentAssistantMessages(items, CALIBRATION_WINDOW)) : undefined;

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{overlay}
			{/* Left of the overlay's 28px button (top-2 right-3) when it is shown. */}
			{hasTools && !placeholder && <ToolsToggle className={overlay ? "right-12" : "right-3"} />}
			{showNav && <MessageNav targets={targets} scrollRef={scrollRef} onJump={onJump} />}
			<div ref={scrollRef} className={cn("min-h-0 flex-1 overflow-y-auto py-6", showNav && NAV_SPACE)} role="region" aria-label="对话消息" tabIndex={-1}>
				<div ref={contentRef} className="mx-auto flex max-w-[860px] flex-col gap-[18px] px-4 sm:px-6">
					{placeholder ?? (
						<KeepInViewContext.Provider value={keepInView}>
							{hidden > 0 && (
								<button
									type="button"
									onClick={() => setLimit((l) => l + PAGE)}
									className="self-center rounded-full border border-border bg-panel px-3 py-1 text-xs text-fg-2 hover:text-fg"
								>
									显示更早的 {hidden} 条
								</button>
							)}
							{visible.map((item) => (
								<Item
									key={item.key}
									item={item}
									workspaceId={workspaceId}
									timing={timing}
									calibration={item.key === streamingKey ? calibration : undefined}
									onForkReply={onForkReply}
									forkBlocked={forkBlocked}
								/>
							))}
							{bashRuns.map((run) => (
								<BashRunCard key={run.id} run={run} />
							))}
							{waiting && (
								<div className="flex items-center gap-2 text-sm text-fg-3" role="status">
									<Spinner size={12} />
									等待模型响应…
								</div>
							)}
						</KeepInViewContext.Provider>
					)}
				</div>
			</div>
			{!atBottom && !placeholder && (
				<button
					type="button"
					onClick={() => scrollToBottom(true)}
					className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-raised px-3 text-xs text-fg shadow-pop hover:bg-selected"
				>
					<ArrowDown size={13} strokeWidth={2} aria-hidden="true" />
					回到底部
				</button>
			)}
		</div>
	);
}
