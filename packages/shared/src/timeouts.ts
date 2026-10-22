/**
 * Conversation timeouts (IMPLEMENTATION.md §2.5). The agent enforces them; the host waits
 * the same budget plus a margin on the link, so the agent's precise error always arrives
 * before the host gives up. Keep both sides on these helpers.
 */

/** Default timeout of a pi RPC command. */
export const RPC_TIMEOUT_MS = 60_000;
/** Timeout of commands that may legitimately run for minutes. */
export const LONG_RPC_TIMEOUT_MS = 10 * 60_000;

/**
 * pi commands whose default timeout is LONG_RPC_TIMEOUT_MS. pi answers a `prompt` only once the
 * run has been prepared: before that it may auto-compact the session (a full LLM summarisation),
 * run input handlers, before_agent_start hooks and OAuth refreshes; an extension slash command
 * is answered only after its handler finished, which may wait for a dialog.
 */
export const LONG_RPC_COMMANDS: ReadonlySet<string> = new Set([
	"prompt",
	"compact",
	"export_html",
	"abort",
	"bash",
	"fork",
	"clone",
	"new_session",
	"switch_session",
]);

/** Default conv.send timeout for `command` when the caller passes none. */
export function defaultCommandTimeout(command: { type: string; message?: unknown }): number {
	return LONG_RPC_COMMANDS.has(command.type) ? LONG_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS;
}

/** Total conv.companion budget: navigate and reload first wait for pi to become idle. */
export function companionActionTimeout(action: "navigate" | "label" | "reload"): number {
	return action === "label" ? RPC_TIMEOUT_MS : LONG_RPC_TIMEOUT_MS;
}

/**
 * Total conv.start budget on the agent: spawning pi and its initial get_state (60s, plus a
 * few seconds to reap a failed process), or attaching to a process that is still starting.
 */
export const CONV_START_TIMEOUT_MS = 90_000;

/** Total conv.snapshot budget on the agent (get_state + get_messages + get_session_stats). */
export const CONV_SNAPSHOT_TIMEOUT_MS = 120_000;
