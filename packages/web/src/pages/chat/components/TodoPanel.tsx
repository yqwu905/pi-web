import type { TodoSnapshot, TodoStatus, TodoTask } from "@pi-web/shared";
import { ChevronDown, ListTodo } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../../lib/cn";
import { useStoredState } from "../hooks";
import { activeTodoTask, hiddenTodoCount, showTodoIds, todoProgress, visibleTodoTasks } from "../logic/todos";

/** Row glyphs of rpiv's overlay (deleted tasks are never listed). */
const STATUS_VIEW: Record<TodoStatus, { glyph: string; tone: string; label: string }> = {
	pending: { glyph: "○", tone: "text-fg-3", label: "待处理" },
	in_progress: { glyph: "◐", tone: "text-warning", label: "进行中" },
	completed: { glyph: "✓", tone: "text-success", label: "已完成" },
	deleted: { glyph: "✗", tone: "text-danger", label: "已删除" },
};

/**
 * rpiv-todo's task list above the composer (rpiv's own overlay is a TUI widget that RPC mode
 * drops). Completed tasks from previous turns are folded away, as in rpiv's overlay.
 */
export function TodoPanel({ snapshot }: { snapshot: TodoSnapshot | null }) {
	const [open, setOpen] = useStoredState("pi-web:todo-panel-open", true);
	const [showHidden, setShowHidden] = useState(false);
	const bodyId = useId();
	// Like rpiv's overlay, gone once every task left is one completed in an earlier run.
	if (!snapshot || visibleTodoTasks(snapshot).length === 0) return null;
	const hiddenCount = hiddenTodoCount(snapshot);
	const tasks = visibleTodoTasks(snapshot, showHidden);
	const { completed, total } = todoProgress(tasks);
	const active = activeTodoTask(tasks);
	const activeText = active ? `进行中：${active.activeForm || active.subject}` : "";
	const showIds = showTodoIds(tasks);

	return (
		<div role="group" aria-label="任务清单" className="overflow-hidden rounded-lg border border-border bg-panel text-sm">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={bodyId}
				onClick={() => setOpen(!open)}
				className="flex min-h-9 w-full items-center gap-2 bg-transparent px-3 py-1.5 text-left"
			>
				<ListTodo size={14} strokeWidth={1.8} className="shrink-0 text-fg-2" aria-hidden="true" />
				<span className="shrink-0 text-xs font-semibold text-fg-2">任务清单</span>
				{total > 0 && (
					<span className="shrink-0 font-mono text-2xs text-fg-3">
						<span className="sr-only">已完成 </span>
						{completed}/{total}
					</span>
				)}
				{!open && active && (
					<span className="min-w-0 truncate text-xs text-fg-2" title={activeText}>
						{activeText}
					</span>
				)}
				<ChevronDown size={13} strokeWidth={2} aria-hidden="true" className={cn("ml-auto shrink-0 text-fg-3 transition-transform", !open && "-rotate-90")} />
			</button>
			<div id={bodyId} hidden={!open} className="max-h-[min(18rem,30dvh)] overflow-y-auto border-t border-border px-3 py-1.5">
				{tasks.length > 0 && (
					<ul className="m-0 flex list-none flex-col p-0">
						{tasks.map((task) => (
							<TodoRow key={task.id} task={task} showId={showIds} />
						))}
					</ul>
				)}
				{hiddenCount > 0 && (
					<button
						type="button"
						aria-expanded={showHidden}
						onClick={() => setShowHidden(!showHidden)}
						className="flex h-6 items-center rounded-md border-0 bg-transparent px-0 text-left text-xs text-fg-3 hover:text-fg"
					>
						{showHidden ? `隐藏此前已完成的 ${hiddenCount} 项` : `显示此前已完成的 ${hiddenCount} 项`}
					</button>
				)}
			</div>
		</div>
	);
}

function TodoRow({ task, showId }: { task: TodoTask; showId: boolean }) {
	const view = STATUS_VIEW[task.status];
	const blockedBy = task.blockedBy && task.blockedBy.length > 0 ? task.blockedBy.map((id) => `#${id}`).join(", ") : "";
	return (
		<li className="flex items-baseline gap-2 py-0.5" title={task.description}>
			<span aria-hidden="true" className={cn("w-3.5 shrink-0 text-center", view.tone)}>
				{view.glyph}
			</span>
			<span className="sr-only">{view.label}：</span>
			{showId && <span className="shrink-0 font-mono text-2xs text-fg-3">#{task.id}</span>}
			<span className="min-w-0 break-words">
				<span className={cn(task.status === "completed" ? "text-fg-3 line-through" : task.status === "in_progress" ? "font-medium text-fg" : "text-fg-2")}>
					{task.subject}
				</span>
				{task.status === "in_progress" && task.activeForm && <span className="ml-1.5 text-fg-3">({task.activeForm})</span>}
				{blockedBy && (
					<span className="ml-1.5 text-xs text-fg-3">
						<span aria-hidden="true">⛓ </span>
						<span className="sr-only">依赖 </span>
						{blockedBy}
					</span>
				)}
			</span>
		</li>
	);
}
