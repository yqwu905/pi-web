/**
 * Pi-Web companion extension, loaded into every pi process with `-e pi-web-ext.mjs`.
 * It exposes hidden commands for operations pi's RPC protocol lacks. The agent sends
 * `/pi-web-<action> <json>` as a prompt; results are reported through
 * ctx.ui.setStatus("pi-web:result", JSON.stringify({ reqId, ok, error?, cancelled? })).
 *
 * It also mirrors the rpiv-todo task list (whose setWidget overlay RPC mode drops): after
 * every event that may change it, the branch is replayed and the snapshot is pushed as
 * ctx.ui.setStatus("pi-web:todos", encodeTodoStatus(snapshot)).
 *
 * The interfaces below are the structural subset of pi's ExtensionAPI /
 * ExtensionContext / ExtensionCommandContext (dist/core/extensions/types.d.ts) this extension uses.
 */
import {
	COMPANION_COMMAND_PREFIX,
	COMPANION_STATUS_KEY,
	encodeTodoStatus,
	replayTodos,
	TODO_STATUS_KEY,
	TODO_TOOL_NAME,
	type TodoSourceEntry,
} from "@pi-web/shared";

interface CompanionUi {
	setStatus(key: string, text: string | undefined): void;
}

interface CompanionSessionManager {
	/** Entries from the root to the current leaf, compacted ones included. */
	getBranch(): TodoSourceEntry[];
}

interface CompanionEventContext {
	readonly ui: CompanionUi;
	readonly sessionManager: CompanionSessionManager;
}

/** The fields of pi's session, agent, message and tool events read here. */
interface CompanionEvent {
	type: string;
	toolName?: string;
	message?: { role?: string; toolName?: string };
}

interface CompanionCommandContext {
	readonly ui: CompanionUi;
	waitForIdle(): Promise<void>;
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;
	reload(): Promise<void>;
}

interface CompanionApi {
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: CompanionCommandContext) => Promise<void> },
	): void;
	setLabel(entryId: string, label: string | undefined): void;
	on(event: string, handler: (event: CompanionEvent, ctx: CompanionEventContext) => void): void;
}

interface ActionOutcome {
	cancelled?: boolean;
}

type Payload = Record<string, unknown> & { reqId?: unknown };

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function stringArg(payload: Payload, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function requiredArg(payload: Payload, key: string): string {
	const value = stringArg(payload, key);
	if (!value) throw new Error(`missing argument: ${key}`);
	return value;
}

export default function piWebCompanion(pi: CompanionApi): void {
	const register = (action: string, run: (payload: Payload, ctx: CompanionCommandContext) => Promise<ActionOutcome | void>) => {
		pi.registerCommand(`${COMPANION_COMMAND_PREFIX}${action}`, {
			description: "Pi-Web internal command",
			handler: async (args, ctx) => {
				// Capture ui first: after ctx.reload() the old ctx is stale and its getters throw.
				const ui = ctx.ui;
				let payload: Payload;
				try {
					const parsed = JSON.parse(args) as unknown;
					payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Payload) : {};
				} catch {
					payload = {};
				}
				const reqId = typeof payload.reqId === "string" ? payload.reqId : "";
				let result: { reqId: string; ok: boolean; error?: string; cancelled?: boolean };
				try {
					const outcome = (await run(payload, ctx)) ?? {};
					result = { reqId, ok: true };
					if (outcome.cancelled !== undefined) result.cancelled = outcome.cancelled;
				} catch (err) {
					result = { reqId, ok: false, error: errorText(err) };
				}
				ui.setStatus(COMPANION_STATUS_KEY, JSON.stringify(result));
			},
		});
	};

	register("navigate", async (payload, ctx) => {
		const targetId = requiredArg(payload, "targetId");
		await ctx.waitForIdle();
		const result = await ctx.navigateTree(targetId, {
			summarize: payload.summarize === true,
			customInstructions: stringArg(payload, "customInstructions"),
			label: stringArg(payload, "label"),
		});
		return { cancelled: result.cancelled };
	});

	register("label", async (payload) => {
		const entryId = requiredArg(payload, "entryId");
		pi.setLabel(entryId, stringArg(payload, "label"));
	});

	register("reload", async (_payload, ctx) => {
		await ctx.waitForIdle();
		await ctx.reload();
	});

	mirrorTodos(pi);
}

/**
 * Pushes the rpiv-todo snapshot of the current branch (replayTodos) as the TODO_STATUS_KEY status.
 * Handlers capture ui and sessionManager synchronously and schedule one deferred replay per
 * burst of events: pi persists a message entry only after the awaited message_end handlers
 * returned, so the replay must run later to see it.
 */
function mirrorTodos(pi: CompanionApi): void {
	let target: CompanionEventContext | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// The value this instance pushed last (null: cleared), undefined before its first push. A value
	// left by the previous instance (before a reload or session switch) survives in Pi-Web, so the
	// first replay always pushes, even when there is no task list.
	let pushed: string | null | undefined;

	const push = () => {
		timer = undefined;
		const current = target;
		target = undefined;
		if (!current) return;
		try {
			const snapshot = replayTodos(current.sessionManager.getBranch());
			const encoded = snapshot ? encodeTodoStatus(snapshot) : null;
			if (encoded === pushed) return;
			current.ui.setStatus(TODO_STATUS_KEY, encoded ?? undefined);
			pushed = encoded;
		} catch {
			// Stale after a reload or session replacement (the next instance pushes), or an unreadable
			// branch: this refresh is skipped. Never throw from a timer, it would kill pi.
		}
	};
	const schedule = (ctx: CompanionEventContext) => {
		try {
			target = { ui: ctx.ui, sessionManager: ctx.sessionManager };
		} catch {
			// pi's ctx getters throw once the session was replaced or reloaded.
			return;
		}
		timer ??= setTimeout(push, 0);
	};

	pi.on("session_start", (_event, ctx) => schedule(ctx));
	pi.on("session_tree", (_event, ctx) => schedule(ctx));
	pi.on("session_compact", (_event, ctx) => schedule(ctx));
	pi.on("agent_end", (_event, ctx) => schedule(ctx));
	pi.on("tool_execution_end", (event, ctx) => {
		// Also nested calls (codemode): their state entries are on the branch already.
		if (event.toolName === TODO_TOOL_NAME) schedule(ctx);
	});
	pi.on("message_end", (event, ctx) => {
		// A user message moves the "completed in a previous turn" baseline; a todo toolResult is the
		// only snapshot of sessions written before rpiv's state entries.
		const message = event.message;
		if (message?.role === "user" || (message?.role === "toolResult" && message.toolName === TODO_TOOL_NAME)) schedule(ctx);
	});
	pi.on("session_shutdown", () => {
		// This runtime is being torn down: a pending replay would read a session that is no longer current.
		clearTimeout(timer);
		timer = undefined;
		target = undefined;
	});
}
