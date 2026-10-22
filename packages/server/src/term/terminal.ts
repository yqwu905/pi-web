/**
 * Web terminal: bridges a browser WebSocket (/ws/term) to an SSH exec channel with a pty.
 * Binary frames carry terminal bytes both ways; text frames carry JSON control messages
 * (TermClientControl from the browser, TermServerControl to it).
 */
import { posix as posixPath } from "node:path";
import { shellQuote } from "@pi-web/shared";
import type { TermServerControl } from "@pi-web/shared";
import type { ClientChannel } from "ssh2";
import type { RawData, WebSocket } from "ws";
import type { AppContext, Logger } from "../core/types.js";

export type TerminalDeps = Pick<AppContext, "store" | "connections" | "log">;

export interface TerminalQuery {
	serverId?: string;
	cwd?: string;
	cols?: string | number;
	rows?: string | number;
}

export interface TerminalOptions {
	/** Pause the SSH channel while the socket has more than this many unsent bytes. Default 1 MiB. */
	highWaterMark?: number;
	/** Resume once the socket buffer drains below this. Default 256 KiB. */
	lowWaterMark?: number;
}

const WS_OPEN = 1;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 1000;

/** Quotes a remote path for sh, keeping a leading "~" expandable. */
export function remoteShellPath(p: string): string {
	if (p === "~") return `"$HOME"`;
	if (p.startsWith("~/")) {
		const rest = p.slice(2);
		return rest ? `"$HOME"/${shellQuote(rest)}` : `"$HOME"/`;
	}
	return shellQuote(p);
}

/** The command run in the pty: cd to the workspace, put `pi` on PATH, start a login shell. */
export function buildTerminalCommand(cwd: string, remoteRoot: string): string {
	const binDir = remoteShellPath(posixPath.join(remoteRoot, "bin"));
	return `cd ${remoteShellPath(cwd)} 2>/dev/null; export PATH=${binDir}:"$PATH"; exec "\${SHELL:-/bin/sh}" -l`;
}

function dimension(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(MAX_DIMENSION, Math.max(1, Math.floor(n)));
}

function toBuffer(raw: RawData): Buffer {
	if (Array.isArray(raw)) return Buffer.concat(raw);
	if (raw instanceof ArrayBuffer) return Buffer.from(raw);
	return raw;
}

/** Serves one terminal socket until either side closes. Never throws. */
export async function handleTerminalSocket(
	deps: TerminalDeps,
	socket: WebSocket,
	query: TerminalQuery,
	options: TerminalOptions = {},
): Promise<void> {
	const log: Logger = deps.log.child("term");
	const highWaterMark = options.highWaterMark ?? 1024 * 1024;
	const lowWaterMark = options.lowWaterMark ?? 256 * 1024;

	let channel: ClientChannel | null = null;
	let socketClosed = false;
	let channelClosed = false;
	let paused = false;
	let exitCode: number | null = null;
	const pendingInput: Buffer[] = [];
	let pendingResize: { cols: number; rows: number } | null = null;

	const sendControl = (message: TermServerControl) => {
		if (socket.readyState !== WS_OPEN) return;
		try {
			socket.send(JSON.stringify(message));
		} catch {
			// socket going away
		}
	};

	const closeSocket = (code: number, reason?: string) => {
		if (socket.readyState === WS_OPEN) {
			try {
				socket.close(code, reason);
			} catch {
				socket.terminate();
			}
		}
	};

	const closeChannel = () => {
		if (!channel || channelClosed) return;
		channelClosed = true;
		try {
			channel.close();
		} catch {
			// already closed
		}
	};

	const fail = (message: string, code = 1011) => {
		sendControl({ type: "error", message });
		closeSocket(code);
		closeChannel();
	};

	const applyResize = (cols: number, rows: number) => {
		if (!channel) {
			pendingResize = { cols, rows };
			return;
		}
		try {
			channel.setWindow(rows, cols, 0, 0);
		} catch (err) {
			log.debug("setWindow failed", { error: (err as Error).message });
		}
	};

	const writeInput = (data: Buffer) => {
		if (!channel) {
			pendingInput.push(data);
			return;
		}
		if (!channelClosed) channel.write(data);
	};

	const sendOutput = (chunk: Buffer) => {
		if (socket.readyState !== WS_OPEN) return;
		socket.send(chunk, { binary: true }, () => {
			if (paused && socket.bufferedAmount <= lowWaterMark) {
				paused = false;
				channel?.resume();
			}
		});
		if (!paused && socket.bufferedAmount > highWaterMark) {
			paused = true;
			channel?.pause();
		}
	};

	socket.on("message", (raw: RawData, isBinary: boolean) => {
		const data = toBuffer(raw);
		if (isBinary) {
			writeInput(data);
			return;
		}
		let control: unknown;
		try {
			control = JSON.parse(data.toString("utf8"));
		} catch {
			writeInput(data);
			return;
		}
		if (control && typeof control === "object" && (control as { type?: unknown }).type === "resize") {
			const c = control as { cols?: unknown; rows?: unknown };
			applyResize(dimension(c.cols, DEFAULT_COLS), dimension(c.rows, DEFAULT_ROWS));
		}
	});
	socket.on("close", () => {
		socketClosed = true;
		closeChannel();
	});
	socket.on("error", () => {
		socketClosed = true;
		closeChannel();
	});

	const serverId = typeof query.serverId === "string" ? query.serverId : "";
	const server = serverId ? deps.store.getServer(serverId) : undefined;
	if (!server) {
		fail("服务器不存在", 1008);
		return;
	}
	const cwd = typeof query.cwd === "string" && query.cwd.trim() !== "" ? query.cwd : "~";
	const cols = dimension(query.cols, DEFAULT_COLS);
	const rows = dimension(query.rows, DEFAULT_ROWS);

	try {
		const connection = deps.connections.get(serverId);
		await connection.ensureSsh();
		if (socketClosed) return;
		const remoteRoot = server.deployed?.remoteRoot ?? connection.agentClient?.hello.remoteRoot ?? server.remoteRoot;
		const opened = await connection.openPty({
			command: buildTerminalCommand(cwd, remoteRoot),
			cols,
			rows,
			term: "xterm-256color",
		});
		channel = opened;
		if (socketClosed) {
			closeChannel();
			return;
		}
	} catch (err) {
		log.warn("terminal open failed", { serverId, error: (err as Error).message });
		fail(`无法打开终端：${(err as Error).message}`);
		return;
	}

	const ch = channel;
	ch.on("data", (chunk: Buffer) => sendOutput(chunk));
	ch.stderr?.on("data", (chunk: Buffer) => sendOutput(chunk));
	ch.on("exit", (code: number | null) => {
		exitCode = typeof code === "number" ? code : null;
	});
	ch.on("error", (err: Error) => {
		log.debug("terminal channel error", { serverId, error: err.message });
	});
	ch.on("close", (closeCode?: number | null) => {
		channelClosed = true;
		// ssh2 repeats the exit status as the "close" arguments when "exit" fired before we listened.
		if (exitCode === null && typeof closeCode === "number") exitCode = closeCode;
		sendControl({ type: "exit", code: exitCode });
		closeSocket(1000);
	});

	sendControl({ type: "ready" });
	if (pendingResize) {
		const { cols: c, rows: r } = pendingResize;
		pendingResize = null;
		applyResize(c, r);
	}
	for (const data of pendingInput.splice(0)) ch.write(data);
}
