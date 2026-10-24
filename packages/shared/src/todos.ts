/**
 * Task list of the pi extension @juicesharp/rpiv-todo (and the older unscoped "rpiv-todo"),
 * reconstructed for Pi-Web's todo panel. rpiv draws its list with a setWidget component
 * factory, which pi's RPC mode drops, so Pi-Web replays rpiv's persisted state instead:
 * - `details` of `todo` toolResult messages (rpiv tool/types.ts TaskDetails);
 * - custom session entries of type "rpiv-todo-state" with the same TaskDetails as `data`,
 *   appended for every state change, also for nested calls (codemode) that leave no toolResult.
 *
 * The companion extension replays the branch inside pi and pushes the result as the status
 * TODO_STATUS_KEY; read-only views replay the session file; live views without that status
 * fall back to the transcript.
 */
import type { AgentMessage } from "./pi.js";

/** rpiv's tool name: replay reads the toolResult messages of this tool. */
export const TODO_TOOL_NAME = "todo";
/** customType of rpiv's state entries. */
export const TODO_STATE_ENTRY_TYPE = "rpiv-todo-state";
/** statusKey the companion extension pushes the encoded TodoSnapshot under (Pi-Web internal). */
export const TODO_STATUS_KEY = "pi-web:todos";

/** Longest description kept in a snapshot (it rides along every conv.info broadcast). */
const MAX_DESCRIPTION = 300;

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TodoTask {
	id: number;
	subject: string;
	status: TodoStatus;
	activeForm?: string;
	description?: string;
	blockedBy?: number[];
	owner?: string;
}

/** The part of rpiv's TaskDetails that its replay validates (action, params and error are not checked). */
export interface TodoDetails {
	tasks: Array<TodoTask & { metadata?: Record<string, unknown> }>;
	nextId: number;
}

/** Structural subset of a pi session entry (SessionEntry) that replay reads. */
export interface TodoSourceEntry {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; toolName?: string; details?: unknown };
}

export interface TodoSnapshot {
	v: 1;
	/** Tasks in rpiv's order, without deleted tombstones. */
	tasks: TodoTask[];
	nextId: number;
	/** Ids of completed tasks that were already completed before the last user message. */
	hidden: number[];
}

// ---------- validation (port of rpiv state/replay.ts) ----------

const TODO_STATUSES: ReadonlySet<unknown> = new Set<TodoStatus>(["pending", "in_progress", "completed", "deleted"]);

const optional = (value: unknown, valid: (v: unknown) => boolean): boolean => value === undefined || valid(value);
const isString = (v: unknown): boolean => typeof v === "string";
const isIdList = (v: unknown): boolean => Array.isArray(v) && v.every((id) => Number.isSafeInteger(id));

function isTodoTask(value: unknown): value is TodoTask & { metadata?: Record<string, unknown> } {
	if (!value || typeof value !== "object") return false;
	const t = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(t.id) &&
		typeof t.subject === "string" &&
		TODO_STATUSES.has(t.status) &&
		optional(t.description, isString) &&
		optional(t.activeForm, isString) &&
		optional(t.owner, isString) &&
		optional(t.blockedBy, isIdList) &&
		optional(t.metadata, (v) => typeof v === "object" && v !== null)
	);
}

/** rpiv's isTaskDetails: a snapshot with any malformed task is skipped whole. */
export function isTodoDetails(value: unknown): value is TodoDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && v.tasks.every(isTodoTask) && Number.isSafeInteger(v.nextId);
}

/** Copy of a task with the fields the panel shows (metadata dropped, description shortened). */
function toTodoTask(task: TodoTask): TodoTask {
	const out: TodoTask = { id: task.id, subject: task.subject, status: task.status };
	if (task.activeForm !== undefined) out.activeForm = task.activeForm;
	if (task.description !== undefined)
		out.description = task.description.length > MAX_DESCRIPTION ? `${task.description.slice(0, MAX_DESCRIPTION - 1)}…` : task.description;
	if (task.blockedBy !== undefined) out.blockedBy = [...task.blockedBy];
	if (task.owner !== undefined) out.owner = task.owner;
	return out;
}

// ---------- replay ----------

/** One replay source: its latest snapshot and the ids completed as of the last user message. */
interface Track {
	details?: TodoDetails;
	baseline: ReadonlySet<number>;
}

function completedIds(details: TodoDetails | undefined): ReadonlySet<number> {
	return new Set(details?.tasks.filter((t) => t.status === "completed").map((t) => t.id) ?? []);
}

function advance(track: Track, details: TodoDetails): void {
	// A smaller nextId means the list was cleared: its ids are reused, so forget the baseline.
	if (track.details && details.nextId < track.details.nextId) track.baseline = new Set();
	track.details = details;
}

/**
 * rpiv's replayFromBranch over branch entries in chronological order (root first): the last
 * valid state entry wins once the branch has any, otherwise the last valid `todo` toolResult.
 * null when the branch holds no valid snapshot at all.
 *
 * `hidden` mirrors rpiv's overlay, which hides completed tasks from previous turns: tasks that
 * are completed now and already were as of the last user message on the branch.
 */
export function replayTodos(entries: Iterable<TodoSourceEntry>): TodoSnapshot | null {
	const fromEntries: Track = { baseline: new Set() };
	const fromToolResults: Track = { baseline: new Set() };
	for (const e of entries) {
		if (e.type === "custom") {
			if (e.customType === TODO_STATE_ENTRY_TYPE && isTodoDetails(e.data)) advance(fromEntries, e.data);
			continue;
		}
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role === "user") {
			fromEntries.baseline = completedIds(fromEntries.details);
			fromToolResults.baseline = completedIds(fromToolResults.details);
			continue;
		}
		if (msg?.role !== "toolResult" || msg.toolName !== TODO_TOOL_NAME) continue;
		if (!isTodoDetails(msg.details)) continue;
		advance(fromToolResults, msg.details);
	}
	const track = fromEntries.details ? fromEntries : fromToolResults;
	if (!track.details) return null;
	const tasks = track.details.tasks.filter((t) => t.status !== "deleted").map(toTodoTask);
	const hidden = tasks.filter((t) => t.status === "completed" && track.baseline.has(t.id)).map((t) => t.id);
	return { v: 1, tasks, nextId: track.details.nextId, hidden };
}

/** Transcript messages as replay entries (live views without the companion's status; no state entries). */
export function messagesToTodoEntries(messages: readonly AgentMessage[]): TodoSourceEntry[] {
	return messages.map((message) => ({ type: "message", message }));
}

// ---------- status encoding ----------

export function encodeTodoStatus(snapshot: TodoSnapshot): string {
	return JSON.stringify(snapshot);
}

/** The snapshot pushed under TODO_STATUS_KEY; null for anything that is not a valid v1 snapshot. */
export function parseTodoStatus(text: string): TodoSnapshot | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (v.v !== 1 || !Array.isArray(v.tasks) || !v.tasks.every(isTodoTask) || !Number.isSafeInteger(v.nextId) || !isIdList(v.hidden)) return null;
	return { v: 1, tasks: v.tasks.map(toTodoTask), nextId: v.nextId as number, hidden: [...(v.hidden as number[])] };
}
