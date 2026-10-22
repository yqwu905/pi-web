import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	ts: number;
	level: LogLevel;
	msg: string;
}

export interface LoggerOptions {
	/** Rotate when the file would exceed this size. Default 5 MB. */
	maxBytes?: number;
	/** Number of rotated files kept (agent.log.1 … agent.log.N). Default 3. */
	keep?: number;
	/** Receives info-and-above entries (broadcast as `agent.log` events). */
	onEntry?: (entry: LogEntry) => void;
	/** Also echo lines to stderr (useful in the foreground). */
	echo?: boolean;
}

const SECRET_KEY = /token|secret|password|passphrase|authorization|apikey|api_key/i;

function redact(extra: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(extra)) {
		out[key] = SECRET_KEY.test(key) ? "[redacted]" : value;
	}
	return out;
}

/** Append-only file logger with size-based rotation. Never pass secrets in `msg`. */
export class AgentLogger {
	private size: number;
	private readonly maxBytes: number;
	private readonly keep: number;
	onEntry?: (entry: LogEntry) => void;

	constructor(
		readonly file: string,
		private readonly options: LoggerOptions = {},
	) {
		this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
		this.keep = options.keep ?? 3;
		this.onEntry = options.onEntry;
		try {
			this.size = statSync(file).size;
		} catch {
			this.size = 0;
		}
	}

	debug(msg: string, extra?: Record<string, unknown>): void {
		this.write("debug", msg, extra);
	}
	info(msg: string, extra?: Record<string, unknown>): void {
		this.write("info", msg, extra);
	}
	warn(msg: string, extra?: Record<string, unknown>): void {
		this.write("warn", msg, extra);
	}
	error(msg: string, extra?: Record<string, unknown>): void {
		this.write("error", msg, extra);
	}

	/** Last `count` lines across the current and rotated files, oldest first. */
	tail(count: number): string[] {
		const wanted = Math.max(0, Math.min(Math.floor(count) || 0, 10_000));
		if (wanted === 0) return [];
		let lines: string[] = [];
		for (let i = 0; i <= this.keep && lines.length < wanted; i++) {
			const file = i === 0 ? this.file : `${this.file}.${i}`;
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const fileLines = text.split("\n");
			if (fileLines[fileLines.length - 1] === "") fileLines.pop();
			lines = [...fileLines, ...lines];
		}
		return lines.slice(-wanted);
	}

	private write(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
		const ts = Date.now();
		const suffix = extra && Object.keys(extra).length > 0 ? ` ${safeJson(redact(extra))}` : "";
		const text = `${msg}${suffix}`;
		const line = `${new Date(ts).toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`;
		try {
			const bytes = Buffer.byteLength(line);
			if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
			appendFileSync(this.file, line, { mode: 0o600 });
			this.size += bytes;
		} catch {
			// Logging must never take the daemon down.
		}
		if (this.options.echo) process.stderr.write(line);
		if (level !== "debug") {
			try {
				this.onEntry?.({ ts, level, msg: text });
			} catch {
				// ignore listener failures
			}
		}
	}

	private rotate(): void {
		try {
			const oldest = `${this.file}.${this.keep}`;
			if (existsSync(oldest)) unlinkSync(oldest);
			for (let i = this.keep - 1; i >= 1; i--) {
				const from = `${this.file}.${i}`;
				if (existsSync(from)) renameSync(from, `${this.file}.${i + 1}`);
			}
			if (this.keep >= 1) renameSync(this.file, `${this.file}.1`);
			else unlinkSync(this.file);
		} catch {
			// best effort
		}
		this.size = 0;
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}
