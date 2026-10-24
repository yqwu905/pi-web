import { describe, expect, it } from "vitest";
import { ZERO_USAGE } from "./conversation.js";
import type { AgentMessage, ToolResultMessage } from "./pi.js";
import {
	encodeTodoStatus,
	isTodoDetails,
	messagesToTodoEntries,
	parseTodoStatus,
	replayTodos,
	TODO_STATE_ENTRY_TYPE,
	todoBaseline,
	type TodoSourceEntry,
	type TodoTask,
} from "./todos.js";

const task = (id: number, status: TodoTask["status"], extra: Partial<TodoTask> & { metadata?: Record<string, unknown> } = {}) => ({
	id,
	subject: `task ${id}`,
	status,
	...extra,
});
const details = (tasks: unknown[], nextId: number) => ({ action: "update", params: {}, tasks, nextId });
const stateEntry = (tasks: unknown[], nextId: number): TodoSourceEntry => ({ type: "custom", customType: TODO_STATE_ENTRY_TYPE, data: details(tasks, nextId) });
const toolResult = (tasks: unknown[], nextId: number, toolName = "todo"): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: "c",
	toolName,
	content: [{ type: "text", text: "ok" }],
	details: details(tasks, nextId),
	isError: false,
	timestamp: 1,
});
const resultEntry = (tasks: unknown[], nextId: number, toolName = "todo"): TodoSourceEntry => ({ type: "message", message: toolResult(tasks, nextId, toolName) });
const userEntry: TodoSourceEntry = { type: "message", message: { role: "user" } };
const assistantEntry: TodoSourceEntry = { type: "message", message: { role: "assistant" } };

describe("isTodoDetails", () => {
	it("ports rpiv's validation", () => {
		expect(isTodoDetails(details([task(1, "pending", { blockedBy: [2], metadata: { a: 1 } })], 2))).toBe(true);
		expect(isTodoDetails(details([], 1))).toBe(true);
		expect(isTodoDetails(null)).toBe(false);
		expect(isTodoDetails({ tasks: [], nextId: 1.5 })).toBe(false);
		expect(isTodoDetails({ tasks: "x", nextId: 1 })).toBe(false);
		expect(isTodoDetails(details([task(1, "done" as never)], 2))).toBe(false);
		expect(isTodoDetails(details([{ id: 1, status: "pending" }], 2))).toBe(false);
		expect(isTodoDetails(details([task(1, "pending", { blockedBy: [1.5] })], 2))).toBe(false);
		expect(isTodoDetails(details([task(1, "pending", { owner: 3 as never })], 2))).toBe(false);
		expect(isTodoDetails(details([task(1, "pending", { metadata: null as never })], 2))).toBe(false);
	});
});

describe("replayTodos", () => {
	it("returns null without any valid snapshot", () => {
		expect(replayTodos([])).toBeNull();
		expect(replayTodos([userEntry, resultEntry([task(1, "pending")], 2, "bash"), { type: "custom", customType: "other", data: details([], 1) }])).toBeNull();
	});

	it("treats state entries as authoritative once the branch has any", () => {
		const snap = replayTodos([
			resultEntry([task(1, "pending")], 2),
			stateEntry([task(1, "in_progress")], 2),
			// A later toolResult (e.g. a list call) does not override the state entries.
			resultEntry([task(1, "pending"), task(2, "pending")], 3),
		]);
		expect(snap).toEqual({ v: 1, tasks: [task(1, "in_progress")], nextId: 2, hidden: [] });
	});

	it("falls back to the last valid todo toolResult", () => {
		const snap = replayTodos([resultEntry([task(1, "pending")], 2), resultEntry([task(1, "completed"), task(2, "pending")], 3), resultEntry([], 9, "bash")]);
		expect(snap?.tasks.map((t) => [t.id, t.status])).toEqual([
			[1, "completed"],
			[2, "pending"],
		]);
		expect(snap?.nextId).toBe(3);
	});

	it("skips invalid snapshots whole", () => {
		const snap = replayTodos([stateEntry([task(1, "pending")], 2), stateEntry([task(1, "pending"), "[truncated]"], 3), resultEntry([task(5, "pending")], 6)]);
		expect(snap?.tasks).toEqual([task(1, "pending")]);
		// An invalid state entry does not make the branch "have state entries".
		expect(replayTodos([stateEntry([42], 2), resultEntry([task(5, "pending")], 6)])?.tasks).toEqual([task(5, "pending")]);
	});

	it("drops deleted tombstones and metadata and shortens descriptions", () => {
		const long = "x".repeat(400);
		const snap = replayTodos([stateEntry([task(1, "deleted"), task(2, "in_progress", { activeForm: "doing", blockedBy: [1], owner: "me", metadata: { k: 1 }, description: long })], 3)]);
		expect(snap?.tasks).toHaveLength(1);
		const t = snap!.tasks[0];
		expect(t).toMatchObject({ id: 2, subject: "task 2", status: "in_progress", activeForm: "doing", blockedBy: [1], owner: "me" });
		expect(t).not.toHaveProperty("metadata");
		expect(t.description).toHaveLength(300);
		expect(t.description?.endsWith("…")).toBe(true);
	});

	it("hides tasks completed before the last run started", () => {
		const snap = replayTodos([
			userEntry,
			stateEntry([task(1, "pending"), task(2, "pending"), task(3, "pending")], 4),
			stateEntry([task(1, "completed"), task(2, "pending"), task(3, "pending")], 4),
			userEntry,
			stateEntry([task(1, "completed"), task(2, "completed"), task(3, "pending")], 4),
		]);
		expect(snap?.hidden).toEqual([1]);
		// Nothing is hidden within the turn that completed the tasks.
		expect(replayTodos([userEntry, stateEntry([task(1, "completed")], 2)])?.hidden).toEqual([]);
	});

	it("resets the baseline when the list is cleared", () => {
		const snap = replayTodos([
			stateEntry([task(1, "completed"), task(2, "completed")], 3),
			userEntry,
			stateEntry([], 1),
			stateEntry([task(1, "completed")], 2),
		]);
		expect(snap?.hidden).toEqual([]);
		expect(snap?.tasks).toEqual([task(1, "completed")]);
	});

	it("computes the baseline from the chosen source", () => {
		const snap = replayTodos([
			resultEntry([task(1, "completed"), task(2, "pending")], 3),
			assistantEntry,
			userEntry,
			resultEntry([task(1, "completed"), task(2, "completed")], 3),
		]);
		expect(snap?.hidden).toEqual([1]);
	});

	it("does not start a run at a steering message (a user message right after a tool result)", () => {
		const snap = replayTodos([
			userEntry,
			stateEntry([task(1, "completed"), task(2, "pending")], 3),
			resultEntry([task(1, "completed"), task(2, "pending")], 3),
			userEntry,
			stateEntry([task(1, "completed"), task(2, "completed")], 3),
		]);
		expect(snap?.hidden).toEqual([]);
	});

	it("uses the baseline recorded at the run start when given", () => {
		const entries = [userEntry, stateEntry([task(1, "completed"), task(2, "completed"), task(3, "pending")], 4)];
		expect(replayTodos(entries, { completed: [1], nextId: 4 })?.hidden).toEqual([1]);
		expect(replayTodos(entries, todoBaseline(null))?.hidden).toEqual([]);
		// Cleared since the run started: the recorded ids belong to the old list.
		expect(replayTodos([stateEntry([task(1, "completed")], 2)], { completed: [1], nextId: 4 })?.hidden).toEqual([]);
		expect(todoBaseline(replayTodos(entries))).toEqual({ completed: [1, 2], nextId: 4 });
	});

	it("replays transcript messages", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hi", timestamp: 1 },
			toolResult([task(1, "completed")], 2),
			{ role: "assistant", content: [], api: "openai-completions", provider: "p", model: "m", usage: ZERO_USAGE, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: "next", timestamp: 3 },
		];
		expect(replayTodos(messagesToTodoEntries(messages))).toEqual({ v: 1, tasks: [task(1, "completed")], nextId: 2, hidden: [1] });
	});
});

describe("todo status encoding", () => {
	it("round-trips a snapshot", () => {
		const snap = replayTodos([userEntry, stateEntry([task(1, "completed", { description: "d" }), task(2, "in_progress", { activeForm: "x", blockedBy: [1] })], 3)])!;
		expect(parseTodoStatus(encodeTodoStatus(snap))).toEqual(snap);
	});

	it("rejects garbage", () => {
		for (const text of ["", "nope", "null", "[]", "1", '{"v":2,"tasks":[],"nextId":1,"hidden":[]}', '{"v":1,"tasks":[{}],"nextId":1,"hidden":[]}', '{"v":1,"tasks":[],"nextId":"1","hidden":[]}', '{"v":1,"tasks":[],"nextId":1}'])
			expect(parseTodoStatus(text)).toBeNull();
	});
});
