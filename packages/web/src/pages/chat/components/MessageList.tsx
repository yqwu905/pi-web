import { ArrowDown } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Spinner } from "../../../components/ui";
import { useStickToBottom } from "../hooks";
import type { DisplayItem } from "../logic/messages";
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
import { ToolCard } from "./ToolCard";

const PAGE = 200;

function Item({ item, workspaceId }: { item: DisplayItem; workspaceId: string }) {
	switch (item.kind) {
		case "user":
			return <UserMessageView message={item.message} />;
		case "assistant":
			return <AssistantGroupView messages={item.messages} workspaceId={workspaceId} />;
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
}

/** Scrolling message column (860px) that follows new output unless the user scrolled up. */
export function MessageList({ items, workspaceId, resetKey, bashRuns, waiting, placeholder, overlay }: MessageListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const { atBottom, scrollToBottom } = useStickToBottom(scrollRef, contentRef, resetKey);
	const [limit, setLimit] = useState(PAGE);
	const hidden = Math.max(0, items.length - limit);
	const visible = hidden > 0 ? items.slice(hidden) : items;

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{overlay}
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-6" role="region" aria-label="对话消息" tabIndex={-1}>
				<div ref={contentRef} className="mx-auto flex max-w-[860px] flex-col gap-[18px] px-4 sm:px-6">
					{placeholder ?? (
						<>
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
								<Item key={item.key} item={item} workspaceId={workspaceId} />
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
						</>
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
