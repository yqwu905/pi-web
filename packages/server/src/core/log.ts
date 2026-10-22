import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { HostPaths, Logger } from "./types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
	/** Minimum level; default $PI_WEB_LOG_LEVEL or "info". */
	level?: LogLevel;
	/** Mirror log lines to stdout/stderr; default true. */
	console?: boolean;
	/** Log file; default <logsDir>/pi-web.log. null disables the file sink. */
	file?: string | null;
	/** Rotate when the file would exceed this size; default 5 MiB. */
	maxBytes?: number;
	/** Number of rotated files to keep (pi-web.log.1 … .N); default 3. */
	keep?: number;
}

const SECRET_KEY = /pass(word|phrase)?|secret|token|authorization|private_?key|cookie/i;

/** Masks values of secret-looking keys (recursively) so they never reach the log. */
export function redact(value: unknown, depth = 0): unknown {
	if (depth > 6 || value === null || typeof value !== "object") return value;
	if (value instanceof Error) {
		const out: Record<string, unknown> = { message: value.message };
		const code = (value as { code?: unknown }).code;
		if (code !== undefined) out.code = code;
		return out;
	}
	if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
	if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		out[key] = SECRET_KEY.test(key) && item !== undefined && item !== null && item !== "" ? "***" : redact(item, depth + 1);
	}
	return out;
}

function formatExtra(extra: Record<string, unknown> | undefined): string {
	if (!extra || Object.keys(extra).length === 0) return "";
	try {
		return ` ${JSON.stringify(redact(extra), (_key, v) => (typeof v === "bigint" ? v.toString() : v))}`;
	} catch {
		return " [unserializable extra]";
	}
}

class FileSink {
	private size = -1;

	constructor(
		private readonly file: string,
		private readonly maxBytes: number,
		private readonly keep: number,
	) {}

	write(line: string): void {
		try {
			if (this.size < 0) {
				mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
				this.size = existsSync(this.file) ? statSync(this.file).size : 0;
			}
			const bytes = Buffer.byteLength(line);
			if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
			appendFileSync(this.file, line, { mode: 0o600 });
			this.size += bytes;
		} catch {
			// Logging must never take the server down.
		}
	}

	private rotate(): void {
		for (let i = this.keep; i >= 1; i--) {
			const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
			const to = `${this.file}.${i}`;
			try {
				if (i === this.keep && existsSync(to)) unlinkSync(to);
				if (existsSync(from)) renameSync(from, to);
			} catch {
				// ignore
			}
		}
		this.size = 0;
	}
}

interface Sink {
	minLevel: number;
	console: boolean;
	file: FileSink | null;
}

class ScopedLogger implements Logger {
	constructor(
		private readonly sink: Sink,
		private readonly scope: string,
	) {}

	debug(msg: string, extra?: Record<string, unknown>): void {
		this.log("debug", msg, extra);
	}
	info(msg: string, extra?: Record<string, unknown>): void {
		this.log("info", msg, extra);
	}
	warn(msg: string, extra?: Record<string, unknown>): void {
		this.log("warn", msg, extra);
	}
	error(msg: string, extra?: Record<string, unknown>): void {
		this.log("error", msg, extra);
	}

	child(scope: string): Logger {
		return new ScopedLogger(this.sink, this.scope ? `${this.scope}:${scope}` : scope);
	}

	private log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
		if (LEVELS[level] < this.sink.minLevel) return;
		const scope = this.scope ? ` [${this.scope}]` : "";
		const body = `${level.toUpperCase().padEnd(5)}${scope} ${msg}${formatExtra(extra)}`;
		const line = `${new Date().toISOString()} ${body}\n`;
		this.sink.file?.write(line);
		if (this.sink.console) {
			(level === "warn" || level === "error" ? process.stderr : process.stdout).write(line);
		}
	}
}

function levelFromEnv(): LogLevel | undefined {
	const value = process.env.PI_WEB_LOG_LEVEL?.toLowerCase();
	return value && value in LEVELS ? (value as LogLevel) : undefined;
}

export function createLogger(paths: Pick<HostPaths, "logsDir">, options: LoggerOptions = {}): Logger {
	const file = options.file === undefined ? path.join(paths.logsDir, "pi-web.log") : options.file;
	const sink: Sink = {
		minLevel: LEVELS[options.level ?? levelFromEnv() ?? "info"],
		console: options.console ?? true,
		file: file ? new FileSink(file, options.maxBytes ?? 5 * 1024 * 1024, options.keep ?? 3) : null,
	};
	return new ScopedLogger(sink, "");
}

/** A logger that discards everything (tests, optional dependencies). */
export function createNullLogger(): Logger {
	const logger: Logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		child: () => logger,
	};
	return logger;
}
