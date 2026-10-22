/**
 * Pure helpers for rendering pi's built-in tools (argument and result shapes taken from
 * @earendil-works/pi-coding-agent dist/core/tools/{bash,read,edit,write,grep,find,ls}.js).
 */
import type { ImageContent } from "@pi-web/shared";
import { structuredPatch } from "diff";

export interface ToolPayloadLike {
	content?: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
}

/** Joined text blocks of a tool result (images omitted). */
export function payloadText(payload: ToolPayloadLike | undefined): string {
	if (!payload?.content) return "";
	return payload.content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

/** Image blocks of a tool result. */
export function payloadImages(payload: ToolPayloadLike | undefined): ImageContent[] {
	if (!payload?.content) return [];
	return payload.content
		.filter((c) => c.type === "image" && typeof c.data === "string")
		.map((c) => ({ type: "image", data: c.data as string, mimeType: c.mimeType ?? "image/png" }));
}

function str(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function firstLine(text: string): string {
	const i = text.indexOf("\n");
	return i >= 0 ? `${text.slice(0, i)} …` : text;
}

/** The path argument of file tools (pi also accepts `file_path`). */
export function toolPath(args: Record<string, unknown>): string {
	return str(args.path ?? args.file_path);
}

/** One-line summary shown next to the tool name in a card header. */
export function toolTarget(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
			return firstLine(str(args.command).trim());
		case "read":
		case "write":
		case "edit":
			return toolPath(args);
		case "grep": {
			const pattern = str(args.pattern);
			const path = str(args.path) || ".";
			const glob = args.glob ? ` (${str(args.glob)})` : "";
			return pattern ? `/${pattern}/ in ${path}${glob}` : path;
		}
		case "find": {
			const pattern = str(args.pattern);
			const path = str(args.path) || ".";
			return pattern ? `${pattern} in ${path}` : path;
		}
		case "ls":
			return str(args.path) || ".";
		default: {
			const keys = Object.keys(args);
			if (keys.length === 0) return "";
			const json = JSON.stringify(args);
			return json.length > 80 ? `${json.slice(0, 79)}…` : json;
		}
	}
}

// ---------- read ----------

export interface ReadResultView {
	/** File content without pi's trailing continuation notice. */
	content: string;
	/** pi's notice ("Showing lines 1-2000 of 5120 …"), if any. */
	notice?: string;
	startLine: number;
	lineCount: number;
}

const READ_NOTICE_RE = /\n\n\[((?:Showing lines \d+-\d+ of \d+|\d+ more lines in file)[^\]]*)\]$/;
const READ_LONG_LINE_RE = /^\[Line \d+ is .+, exceeds .+ limit\..*\]$/s;

/** Splits a read tool result into content and the notice pi appends when output was cut. */
export function parseReadResult(args: Record<string, unknown>, text: string): ReadResultView {
	const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
	if (READ_LONG_LINE_RE.test(text)) return { content: "", notice: text.slice(1, -1), startLine: offset, lineCount: 0 };
	const m = READ_NOTICE_RE.exec(text);
	const content = m ? text.slice(0, m.index) : text;
	const lineCount = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
	return { content, notice: m?.[1], startLine: offset, lineCount };
}

/** "第 41–72 行", "第 41 行" or "" for an empty range. */
export function lineRangeLabel(startLine: number, lineCount: number): string {
	if (lineCount <= 0) return "";
	if (lineCount === 1) return `第 ${startLine} 行`;
	return `第 ${startLine}–${startLine + lineCount - 1} 行`;
}

// ---------- bash ----------

export interface BashResultView {
	output: string;
	exitCode?: number;
	/** Chinese status for abnormal endings (中止 / 超时 …). */
	status?: string;
}

const BASH_STATUS: Array<[RegExp, (m: RegExpExecArray) => Partial<BashResultView>]> = [
	[/(?:^|\n\n)Command exited with code (\d+)$/, (m) => ({ exitCode: Number(m[1]) })],
	[/(?:^|\n\n)Command aborted$/, () => ({ status: "已中止" })],
	[/(?:^|\n\n)Command timed out after (\d+) seconds$/, (m) => ({ status: `超时（${m[1]} 秒）` })],
	[/(?:^|\n\n)Command terminated without an exit code$/, () => ({ status: "被终止" })],
];

/** Separates bash output from pi's status trailer and derives the exit code. */
export function parseBashResult(text: string, isError: boolean): BashResultView {
	for (const [re, map] of BASH_STATUS) {
		const m = re.exec(text);
		if (m) return { output: text.slice(0, m.index), ...map(m) };
	}
	const output = text === "(no output)" ? "" : text;
	return isError ? { output } : { output, exitCode: 0 };
}

// ---------- edit ----------

export interface EditChange {
	oldText: string;
	newText: string;
}

function isChange(value: unknown): value is EditChange {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as EditChange).oldText === "string" &&
		typeof (value as EditChange).newText === "string"
	);
}

/**
 * Replacements of an edit call. Mirrors pi's prepareEditArguments: `edits` may be an array,
 * a JSON string or a single object, and legacy calls carry top-level oldText/newText.
 */
export function editChanges(args: Record<string, unknown>): EditChange[] {
	let edits: unknown = args.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = undefined;
		}
	}
	const out: EditChange[] = [];
	if (Array.isArray(edits)) out.push(...edits.filter(isChange));
	else if (isChange(edits)) out.push(edits);
	if (isChange(args)) out.push({ oldText: args.oldText, newText: args.newText });
	return out;
}

function withNewline(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Unified diff of an edit call computed from its arguments (one hunk group per replacement).
 * Line numbers are relative to each snippet because the file itself is not known.
 */
export function editDiffFromArgs(path: string, changes: readonly EditChange[]): string {
	const name = path || "file";
	const hunks: string[] = [];
	for (const change of changes) {
		const patch = structuredPatch(name, name, withNewline(change.oldText), withNewline(change.newText), "", "", { context: 3 });
		for (const h of patch.hunks) {
			hunks.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`);
		}
	}
	if (hunks.length === 0) return "";
	return `--- a/${name}\n+++ b/${name}\n${hunks.join("\n")}\n`;
}

/** The diff to show for an edit: pi's own patch (real line numbers) when the result has it. */
export function editDiff(args: Record<string, unknown>, details: unknown): string {
	const patch = (details as { patch?: unknown } | undefined)?.patch;
	if (typeof patch === "string" && patch.includes("@@")) return patch;
	return editDiffFromArgs(toolPath(args), editChanges(args));
}

// ---------- streaming arguments ----------

function closeJson(text: string): string {
	let inString = false;
	let escaped = false;
	const stack: string[] = [];
	for (const ch of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{") stack.push("}");
		else if (ch === "[") stack.push("]");
		else if (ch === "}" || ch === "]") stack.pop();
	}
	let out = text;
	if (inString) {
		if (escaped) out = out.slice(0, -1);
		out += '"';
	}
	return out + stack.reverse().join("");
}

/**
 * Best-effort parse of tool-call arguments that are still streaming
 * (`{"command": "npm te` → `{command: "npm te"}`). Returns undefined when nothing usable parsed.
 */
export function parsePartialJson(text: string | undefined): Record<string, unknown> | undefined {
	if (!text || !text.trim()) return undefined;
	const asObject = (value: unknown) =>
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	try {
		return asObject(JSON.parse(text));
	} catch {
		// repair below
	}
	let end = text.length;
	for (let attempt = 0; attempt < 16 && end > 0; attempt++) {
		try {
			const parsed = asObject(JSON.parse(closeJson(text.slice(0, end))));
			if (parsed) return parsed;
		} catch {
			// cut back to the previous separator and retry
		}
		const head = text.slice(0, end - 1);
		const cut = Math.max(head.lastIndexOf(","), head.lastIndexOf("{"), head.lastIndexOf("["));
		if (cut < 0) break;
		end = text[cut] === "," ? cut : cut + 1;
	}
	return undefined;
}

/** Number of lines of a text ("" → 0, trailing newline ignored). */
export function countLines(text: string): number {
	if (!text) return 0;
	return text.replace(/\n$/, "").split("\n").length;
}
