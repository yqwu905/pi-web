import { type AgentMessage, encodeTodoStatus, type SessionEntry, TODO_STATE_ENTRY_TYPE, TODO_STATUS_KEY, type TodoSnapshot, type TodoTask } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { activeTodoTask, hiddenTodoCount, selectTodoSnapshot, showTodoIds, todoProgress, visibleTodoTasks } from "./todos";

const ts = "2026-10-22T09:14:00.000Z";
const task = (id: number, status: TodoTask["status"], extra: Partial<TodoTask> = {}): TodoTask => ({ id, subject: `task ${id}`, status, ...extra });
const details = (tasks: TodoTask[], nextId: number) => ({ action: "update", params: {}, tasks, nextId });
const todoResult = (tasks: TodoTask[], nextId: number): AgentMessage => ({
	role: "toolResult",
	toolCallId: "c",
	toolName: "todo",
	content: [{ type: "text", text: "ok" }],
	details: details(tasks, nextId),
	isError: false,
	timestamp: 1,
});
const stateEntry = (id: string, parentId: string | null, tasks: TodoTask[], nextId: number): SessionEntry => ({
	type: "custom",
	id,
	parentId,
	timestamp: ts,
	customType: TODO_STATE_ENTRY_TYPE,
	data: details(tasks, nextId),
});
const snapshot = (tasks: TodoTask[], hidden: number[] = []): TodoSnapshot => ({ v: 1, tasks, nextId: tasks.length + 1, hidden });

describe("selectTodoSnapshot", () => {
	const messages = [todoResult([task(1, "pending")], 2)];

	it("prefers the companion's status over the transcript", () => {
		const pushed = snapshot([task(7, "in_progress")]);
		expect(selectTodoSnapshot({ statuses: { [TODO_STATUS_KEY]: encodeTodoStatus(pushed) }, readOnlyFile: undefined, messages })).toEqual(pushed);
	});

	it("falls back to the transcript without a valid status", () => {
		expect(selectTodoSnapshot({ statuses: {}, readOnlyFile: undefined, messages })?.tasks).toEqual([task(1, "pending")]);
		expect(selectTodoSnapshot({ statuses: { [TODO_STATUS_KEY]: "garbage" }, readOnlyFile: undefined, messages })?.tasks).toEqual([task(1, "pending")]);
		expect(selectTodoSnapshot({ statuses: {}, readOnlyFile: undefined, messages: [] })).toBeNull();
	});

	it("replays the active branch of a read-only session file", () => {
		const entries = [
			stateEntry("a", null, [task(1, "pending")], 2),
			stateEntry("b", "a", [task(1, "completed")], 2),
			// Another branch, later in the file.
			stateEntry("c", "a", [task(1, "pending"), task(2, "pending")], 3),
		];
		expect(selectTodoSnapshot({ statuses: {}, readOnlyFile: { entries, branchIds: ["a", "b"] }, messages: [] })?.tasks).toEqual([task(1, "completed")]);
		expect(selectTodoSnapshot({ statuses: {}, readOnlyFile: { entries, branchIds: ["a", "missing"] }, messages: [] })?.tasks).toEqual([task(1, "pending")]);
	});
});

describe("todo panel helpers", () => {
	const snap = snapshot([task(1, "completed"), task(2, "completed"), task(3, "in_progress", { activeForm: "x" }), task(4, "pending", { blockedBy: [3] })], [1]);

	it("lists tasks without the hidden ones unless asked", () => {
		expect(visibleTodoTasks(snap).map((t) => t.id)).toEqual([2, 3, 4]);
		expect(visibleTodoTasks(snap, true).map((t) => t.id)).toEqual([1, 2, 3, 4]);
		expect(hiddenTodoCount(snap)).toBe(1);
		// Unknown hidden ids are not counted.
		expect(hiddenTodoCount({ ...snap, hidden: [1, 99] })).toBe(1);
	});

	it("counts progress and finds the active task", () => {
		expect(todoProgress(visibleTodoTasks(snap))).toEqual({ completed: 1, total: 3 });
		expect(activeTodoTask(snap.tasks)?.id).toBe(3);
		expect(activeTodoTask([task(1, "pending")])).toBeUndefined();
	});

	it("shows ids only when a task has dependencies", () => {
		expect(showTodoIds(snap.tasks)).toBe(true);
		expect(showTodoIds([task(1, "pending", { blockedBy: [] }), task(2, "completed")])).toBe(false);
	});
});
