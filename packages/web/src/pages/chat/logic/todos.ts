/**
 * Task list of the rpiv-todo extension for the todo panel. The replay itself lives in
 * @pi-web/shared (todos.ts); this picks the best source a view has and derives what the panel shows.
 */
import {
	type AgentMessage,
	messagesToTodoEntries,
	parseTodoStatus,
	replayTodos,
	type SessionEntry,
	type SessionFileResponse,
	TODO_STATUS_KEY,
	type TodoSnapshot,
	type TodoTask,
} from "@pi-web/shared";

export interface TodoSources {
	/** Extension statuses of the conversation (the companion extension pushes TODO_STATUS_KEY). */
	statuses: Record<string, string>;
	/** Raw session file of a read-only view. */
	readOnlyFile: Pick<SessionFileResponse, "entries" | "branchIds"> | undefined;
	messages: readonly AgentMessage[];
}

/**
 * The task list of a view, from the most complete source it has: the whole branch of a
 * read-only session file, else the companion's replay of the branch inside pi (also kept after
 * the process exited), else the transcript (pi's get_messages loses compacted messages and never
 * has rpiv's state entries, so codemode calls are missed: only for agents without the status).
 */
export function selectTodoSnapshot({ statuses, readOnlyFile, messages }: TodoSources): TodoSnapshot | null {
	if (readOnlyFile) {
		const byId = new Map(readOnlyFile.entries.map((e) => [e.id, e]));
		const branch = readOnlyFile.branchIds.map((id) => byId.get(id)).filter((e): e is SessionEntry => e !== undefined);
		return replayTodos(branch);
	}
	const status = statuses[TODO_STATUS_KEY];
	const pushed = status ? parseTodoStatus(status) : null;
	return pushed ?? replayTodos(messagesToTodoEntries(messages));
}

/** Tasks the panel lists: without those completed in previous turns unless `includeHidden`. */
export function visibleTodoTasks(snapshot: TodoSnapshot, includeHidden = false): TodoTask[] {
	const hidden = new Set(snapshot.hidden);
	return snapshot.tasks.filter((t) => t.status !== "deleted" && (includeHidden || !hidden.has(t.id)));
}

/** Number of completed tasks hidden as belonging to previous turns. */
export function hiddenTodoCount(snapshot: TodoSnapshot): number {
	return visibleTodoTasks(snapshot, true).length - visibleTodoTasks(snapshot).length;
}

/** Heading counts over the listed tasks, as rpiv's overlay "Todos (completed/total)". */
export function todoProgress(tasks: readonly TodoTask[]): { completed: number; total: number } {
	return { completed: tasks.filter((t) => t.status === "completed").length, total: tasks.length };
}

/** The task being worked on (the first in_progress one). */
export function activeTodoTask(tasks: readonly TodoTask[]): TodoTask | undefined {
	return tasks.find((t) => t.status === "in_progress");
}

/** rpiv shows "#id" on the rows only when some listed task has dependencies to point at. */
export function showTodoIds(tasks: readonly TodoTask[]): boolean {
	return tasks.some((t) => (t.blockedBy?.length ?? 0) > 0);
}
