/** Pure composer logic: slash-command completion, input classification and queue restore. */
import { COMPANION_COMMAND_PREFIX, type RpcSlashCommand } from "@pi-web/shared";

/** Commands offered in the "/" menu (pi-web's hidden companion commands removed). */
export function visibleCommands(commands: readonly RpcSlashCommand[]): RpcSlashCommand[] {
	return commands.filter((c) => c.name && !c.name.startsWith(COMPANION_COMMAND_PREFIX));
}

export interface SlashToken {
	/** Text typed after "/" up to the cursor. */
	query: string;
	/** Range of the "/name" token in the text (end exclusive). */
	start: number;
	end: number;
}

/**
 * The slash command being typed, if any: pi only runs commands at the very start of a
 * message, so the text must start with "/" and the cursor must still be inside the name.
 */
export function slashToken(text: string, cursor: number): SlashToken | null {
	if (!text.startsWith("/")) return null;
	const before = text.slice(0, cursor);
	if (cursor < 1 || /\s/.test(before)) return null;
	const rest = text.slice(1);
	const ws = rest.search(/\s/);
	const end = ws < 0 ? text.length : ws + 1;
	return { query: before.slice(1), start: 0, end };
}

function rank(command: RpcSlashCommand, q: string): number {
	const name = command.name.toLowerCase();
	const bare = name.startsWith("skill:") ? name.slice("skill:".length) : name;
	if (!q) return 3;
	if (name === q || bare === q) return 0;
	if (name.startsWith(q) || bare.startsWith(q)) return 1;
	if (name.includes(q)) return 2;
	if ((command.description ?? "").toLowerCase().includes(q)) return 4;
	return -1;
}

const SOURCE_ORDER: Record<string, number> = { extension: 0, prompt: 1, skill: 2 };

/** Commands matching the query, best first (exact, prefix, substring, description). */
export function matchCommands(commands: readonly RpcSlashCommand[], query: string, limit = 50): RpcSlashCommand[] {
	const q = query.trim().toLowerCase();
	return commands
		.map((command, index) => ({ command, index, r: rank(command, q) }))
		.filter((x) => x.r >= 0)
		.sort(
			(a, b) =>
				a.r - b.r ||
				(SOURCE_ORDER[a.command.source] ?? 9) - (SOURCE_ORDER[b.command.source] ?? 9) ||
				a.command.name.localeCompare(b.command.name) ||
				a.index - b.index,
		)
		.slice(0, limit)
		.map((x) => x.command);
}

/** Replaces the slash token with the chosen command; returns the new text and cursor. */
export function applyCommand(text: string, token: SlashToken, name: string): { text: string; cursor: number } {
	const rest = text.slice(token.end).replace(/^\s+/, "");
	const head = `/${name} `;
	return { text: head + rest, cursor: head.length };
}

export const COMMAND_SOURCE_LABELS: Record<RpcSlashCommand["source"], string> = {
	extension: "扩展",
	prompt: "模板",
	skill: "技能",
};

export type ComposerInput =
	| { kind: "empty" }
	| { kind: "bash"; command: string; excludeFromContext: boolean }
	| { kind: "prompt"; message: string };

/**
 * Classifies what the composer would send: "!!cmd" runs bash without adding the output to
 * the model context, "!cmd" runs bash and adds it, anything else is a prompt.
 */
export function classifyInput(text: string, imageCount = 0): ComposerInput {
	const trimmed = text.trim();
	if (trimmed.startsWith("!!")) {
		const command = trimmed.slice(2).trim();
		if (command) return { kind: "bash", command, excludeFromContext: true };
	} else if (trimmed.startsWith("!")) {
		const command = trimmed.slice(1).trim();
		if (command) return { kind: "bash", command, excludeFromContext: false };
	}
	if (!trimmed && imageCount === 0) return { kind: "empty" };
	return { kind: "prompt", message: text.trim() };
}

/** Composer text after messages were taken back from pi's queue (queued first, then the draft). */
export function restoreQueuedText(current: string, restored: readonly string[]): string {
	return [...restored.map((t) => t.trim()).filter(Boolean), current.trim()].filter(Boolean).join("\n\n");
}

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Removes terminal escape sequences that TUI-oriented extensions put in statuses and widgets. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}
