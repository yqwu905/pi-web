/** Parses pi-web-agent log lines ("2026-10-22T14:05:32.123Z INFO  message {json}") for display. */
import { formatDateTime } from "../../../lib/format";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface AgentLogLine {
	/** Local "YYYY-MM-DD HH:mm:ss", when the line starts with an ISO timestamp. */
	time?: string;
	level?: LogLevel;
	message: string;
	raw: string;
}

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/s;

export function parseAgentLogLine(raw: string): AgentLogLine {
	const m = LINE.exec(raw);
	if (!m) return { raw, message: raw };
	const ms = Date.parse(m[1]);
	return {
		raw,
		time: Number.isFinite(ms) ? formatDateTime(ms, true) : m[1],
		level: m[2] as LogLevel,
		message: m[3],
	};
}
