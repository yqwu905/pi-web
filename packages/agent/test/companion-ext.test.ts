import { parseTodoStatus, TODO_STATE_ENTRY_TYPE, TODO_STATUS_KEY, type TodoSourceEntry } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import piWebCompanion from "../src/companion-ext.js";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

/** A fake pi ExtensionAPI with one session whose branch the test edits. */
function setup() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const statuses: Array<[string, string | undefined]> = [];
	const session = { branch: [] as TodoSourceEntry[], stale: false };
	const ui = { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) };
	const ctx = {
		get ui() {
			if (session.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return ui;
		},
		get sessionManager() {
			if (session.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return { getBranch: () => [...session.branch] };
		},
	};
	piWebCompanion({
		registerCommand: (name, options) => commands.set(name, options.handler as (args: string, ctx: unknown) => Promise<void>),
		setLabel: () => undefined,
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler as unknown as Handler]),
	});
	const emit = (type: string, event: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(type) ?? []) expect(handler({ type, ...event }, ctx)).toBeUndefined();
	};
	const todoStatuses = () => statuses.filter(([key]) => key === TODO_STATUS_KEY).map(([, text]) => (text === undefined ? undefined : parseTodoStatus(text)));
	return { handlers, commands, session, emit, todoStatuses, statuses };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = (tasks: Array<{ id: number; status: string }>, nextId: number): TodoSourceEntry => ({
	type: "custom",
	customType: TODO_STATE_ENTRY_TYPE,
	data: { action: "update", params: {}, tasks: tasks.map((t) => ({ subject: `task ${t.id}`, ...t })), nextId },
});
const todoResult = { role: "toolResult", toolName: "todo" };

describe("companion extension", () => {
	it("keeps the hidden commands", () => {
		const { commands } = setup();
		expect([...commands.keys()]).toEqual(["pi-web-navigate", "pi-web-label", "pi-web-reload"]);
	});

	it("pushes the task list once per burst and only when it changed", async () => {
		const { session, emit, todoStatuses } = setup();
		emit("session_start", { reason: "startup" });
		expect(todoStatuses()).toEqual([]);
		await tick();
		// The first replay always pushes: a previous instance may have left a value behind.
		expect(todoStatuses()).toEqual([undefined]);

		session.branch.push(state([{ id: 1, status: "pending" }], 2));
		emit("tool_execution_end", { toolName: "todo", toolCallId: "c/1", parentToolCallId: "c", isError: false });
		emit("message_end", { message: todoResult });
		emit("agent_end", { messages: [] });
		await tick();
		expect(todoStatuses()).toEqual([undefined, { v: 1, tasks: [{ id: 1, subject: "task 1", status: "pending" }], nextId: 2, hidden: [] }]);

		// Unchanged branch: nothing is pushed.
		emit("agent_end", { messages: [] });
		emit("session_compact", {});
		await tick();
		expect(todoStatuses()).toHaveLength(2);

		// A cleared list is still a snapshot; a branch without any clears the status.
		session.branch.push(state([], 1));
		emit("session_tree", { newLeafId: "x", oldLeafId: "y" });
		await tick();
		expect(todoStatuses()[2]).toEqual({ v: 1, tasks: [], nextId: 1, hidden: [] });
		session.branch = [];
		emit("session_tree", { newLeafId: "y", oldLeafId: "x" });
		await tick();
		expect(todoStatuses()).toHaveLength(4);
		expect(todoStatuses()[3]).toBeUndefined();
	});

	it("replays after todo results and at turn starts but ignores other events", async () => {
		const { session, emit, todoStatuses } = setup();
		session.branch.push({ type: "message", message: { role: "user" } }, state([{ id: 1, status: "completed" }], 2));
		emit("tool_execution_end", { toolName: "bash" });
		emit("message_end", { message: { role: "user" } });
		emit("message_end", { message: todoResult });
		emit("turn_end", { message: { role: "assistant" }, toolResults: [] });
		await tick();
		expect(todoStatuses()).toEqual([]);

		emit("turn_start", { turnIndex: 1, timestamp: 0 });
		await tick();
		expect(todoStatuses()).toEqual([{ v: 1, tasks: [{ id: 1, subject: "task 1", status: "completed" }], nextId: 2, hidden: [] }]);
	});

	it("hides the tasks completed when a run starts; steering messages do not move that", async () => {
		const { session, emit, todoStatuses } = setup();
		const user = { type: "message", message: { role: "user" } };
		session.branch.push(user, state([{ id: 1, status: "completed" }, { id: 2, status: "pending" }], 3));
		emit("agent_start");
		// pi persists the prompt after agent_start: the run's baseline is the list before it.
		session.branch.push(user);
		await tick();
		expect(todoStatuses()[0]?.hidden).toEqual([1]);

		// Task 2 is completed in this run, then the user steers: it stays shown until the next run.
		session.branch.push(state([{ id: 1, status: "completed" }, { id: 2, status: "completed" }], 3), user);
		emit("turn_start", {});
		await tick();
		expect(todoStatuses()[1]?.hidden).toEqual([1]);

		// A new session (or branch): run starts are inferred from the branch again.
		emit("session_start", { reason: "resume" });
		await tick();
		expect(todoStatuses()[2]?.hidden).toEqual([1, 2]);
		emit("agent_start");
		await tick();
		expect(todoStatuses()).toHaveLength(3);
	});

	it("survives stale contexts and drops the pending replay on shutdown", async () => {
		const { session, emit, todoStatuses, statuses } = setup();
		session.stale = true;
		emit("session_start", { reason: "reload" });
		await tick();
		expect(statuses).toEqual([]);

		session.stale = false;
		emit("agent_end", { messages: [] });
		emit("session_shutdown", { reason: "reload" });
		await tick();
		expect(todoStatuses()).toEqual([]);
	});

	it("skips a replay that throws and recovers on the next event", async () => {
		const { session, emit, todoStatuses } = setup();
		session.branch = null as never;
		emit("session_start", { reason: "startup" });
		await tick();
		expect(todoStatuses()).toEqual([]);

		session.branch = [state([{ id: 1, status: "pending" }], 2)];
		emit("agent_end", { messages: [] });
		await tick();
		expect(todoStatuses()).toHaveLength(1);
		expect(todoStatuses()[0]?.tasks).toHaveLength(1);
	});
});
