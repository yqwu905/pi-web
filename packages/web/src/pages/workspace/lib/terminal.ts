/** Pure helpers for the web terminal (/ws/term). */
import type { TermClientControl, TermServerControl } from "@pi-web/shared";
import { baseName } from "./remote-path";

export const TERMINAL_FONT_SIZES = [12, 13, 14, 16] as const;
export const DEFAULT_TERMINAL_FONT_SIZE = 13;

export interface TermSocketParams {
	serverId: string;
	cwd: string;
	cols: number;
	rows: number;
}

/** WebSocket URL of a terminal on the page's own origin. */
export function termSocketUrl(location: { protocol: string; host: string }, params: TermSocketParams): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const query = new URLSearchParams({
		serverId: params.serverId,
		cwd: params.cwd,
		cols: String(clampDimension(params.cols, 80)),
		rows: String(clampDimension(params.rows, 24)),
	});
	return `${proto}//${location.host}/ws/term?${query.toString()}`;
}

/** Terminal dimensions as integers in [1, 1000] (fallback for NaN / undefined). */
export function clampDimension(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(1000, Math.max(1, Math.floor(value)));
}

export function resizeMessage(cols: number, rows: number): string {
	const msg: TermClientControl = { type: "resize", cols: clampDimension(cols, 80), rows: clampDimension(rows, 24) };
	return JSON.stringify(msg);
}

/** Parses a text frame from the host; null when it is not a known control message. */
export function parseTermControl(text: string): TermServerControl | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const msg = value as Record<string, unknown>;
	if (msg.type === "ready") return { type: "ready" };
	if (msg.type === "exit") return { type: "exit", code: typeof msg.code === "number" ? msg.code : null };
	if (msg.type === "error") return { type: "error", message: typeof msg.message === "string" ? msg.message : "终端出错" };
	return null;
}

/** xterm's onBinary strings carry one byte per char code. */
export function binaryStringToBytes(data: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
	return bytes;
}

/** Tab title "shell · <dir>", numbered when another tab already uses it. */
export function terminalLabel(cwd: string, existing: readonly string[]): string {
	const dir = cwd === "~" ? "~" : baseName(cwd) || cwd;
	const base = `shell · ${dir}`;
	if (!existing.includes(base)) return base;
	for (let n = 2; ; n++) {
		const label = `${base} (${n})`;
		if (!existing.includes(label)) return label;
	}
}

export type TerminalStatus = "connecting" | "connected" | "exited" | "closed" | "error";

export const TERMINAL_STATUS_TEXT: Record<TerminalStatus, string> = {
	connecting: "连接中…",
	connected: "已连接",
	exited: "会话已结束",
	closed: "已断开",
	error: "连接失败",
};

/**
 * xterm colors mapped to theme tokens (CSS variables from styles.css), matching the Terminal
 * artboard: prompt user in bright green (#7FE0D2), paths in bright blue (#8DBBFF).
 */
export const TERMINAL_THEME_VARS = {
	background: "--color-code",
	foreground: "--color-fg-code",
	cursor: "--color-fg-code",
	cursorAccent: "--color-code",
	selectionBackground: "--color-border-strong",
	black: "--color-border-strong",
	red: "--color-danger-strong",
	green: "--color-success",
	yellow: "--color-warning-fg",
	blue: "--color-syn-title",
	magenta: "--color-syn-keyword",
	cyan: "--color-success",
	white: "--color-fg-code",
	brightBlack: "--color-fg-4",
	brightRed: "--color-danger",
	brightGreen: "--color-success-fg",
	brightYellow: "--color-warning-body",
	brightBlue: "--color-link",
	brightMagenta: "--color-syn-keyword",
	brightCyan: "--color-link",
	brightWhite: "--color-fg",
} as const;

export type TerminalThemeColors = { -readonly [K in keyof typeof TERMINAL_THEME_VARS]?: string };

/** Resolves the theme through `readVar` (e.g. getComputedStyle); unset variables are left out. */
export function terminalTheme(readVar: (name: string) => string): TerminalThemeColors {
	const theme: TerminalThemeColors = {};
	for (const [key, name] of Object.entries(TERMINAL_THEME_VARS) as [keyof typeof TERMINAL_THEME_VARS, string][]) {
		const value = readVar(name).trim();
		if (value) theme[key] = value;
	}
	return theme;
}
