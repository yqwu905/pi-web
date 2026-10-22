/**
 * Web terminal sessions (xterm.js + /ws/term). Sessions live at module level so switching
 * between workspace tabs (文件 / Git …) keeps the shells running: the page attaches a
 * session's element on mount and detaches it on unmount. A session ends when its tab is
 * closed, its workspace is removed, or the browser page goes away.
 *
 * React reads tab metadata from `useTerminalStore`; xterm objects stay outside React.
 */
import { FitAddon } from "@xterm/addon-fit";
import { type IDisposable, Terminal } from "@xterm/xterm";
import {
	binaryStringToBytes,
	parseTermControl,
	resizeMessage,
	type TerminalStatus,
	terminalLabel,
	terminalTheme,
	termSocketUrl,
} from "./lib/terminal";
import { wsProtocols } from "../../api/auth-token";
import { patchTab, type TerminalTab, terminalSessions, useTerminalStore } from "./terminal-store";

function cssVar(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name);
}

const DIM = "\x1b[90m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const encoder = new TextEncoder();

class TerminalSession {
	readonly element: HTMLDivElement;
	private readonly term: Terminal;
	private readonly fitAddon = new FitAddon();
	private readonly disposables: IDisposable[] = [];
	private socket: WebSocket | null = null;
	private generation = 0;
	private opened = false;
	private disposed = false;
	private status: TerminalStatus = "connecting";
	private reported = "";
	private readonly fontFamily = cssVar("--font-mono").trim() || "monospace";

	constructor(
		private readonly id: string,
		private readonly serverId: string,
		private readonly cwd: string,
		fontSize: number,
	) {
		this.element = document.createElement("div");
		this.element.style.width = "100%";
		this.element.style.height = "100%";
		this.term = new Terminal({
			fontFamily: this.fontFamily,
			fontSize,
			lineHeight: 1.2,
			cursorBlink: true,
			scrollback: 5000,
			theme: terminalTheme(cssVar),
		});
		this.term.loadAddon(this.fitAddon);
		this.disposables.push(
			this.term.onData((data) => this.send(encoder.encode(data))),
			this.term.onBinary((data) => this.send(binaryStringToBytes(data))),
			this.term.onResize(({ cols, rows }) => {
				this.reportSize();
				if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(resizeMessage(cols, rows));
			}),
			this.term.onTitleChange((title) => patchTab(this.id, { title })),
		);
	}

	/** Shows the terminal inside `host`; opens xterm and connects on first use. */
	attach(host: HTMLElement): void {
		if (this.disposed) return;
		if (this.element.parentElement !== host) host.appendChild(this.element);
		if (!this.opened) {
			this.term.open(this.element);
			this.opened = true;
			this.fit();
			this.connect();
			// The first measurement may use a fallback font: re-measure once the web font is loaded
			// (a different fontFamily string makes xterm measure again).
			void document.fonts
				?.load(`${this.term.options.fontSize ?? 13}px ${this.fontFamily}`)
				.then((faces) => {
					if (this.disposed || faces.length === 0) return;
					this.term.options.fontFamily = `${this.fontFamily}, monospace`;
					this.fit();
				})
				.catch(() => {});
		} else {
			this.fit();
			this.term.refresh(0, this.term.rows - 1);
		}
	}

	detach(): void {
		this.element.remove();
	}

	/** Resizes the terminal to its element (no-op while hidden). */
	fit(): void {
		if (!this.opened || this.disposed || !this.element.isConnected) return;
		if (this.element.clientWidth === 0 || this.element.clientHeight === 0) return;
		try {
			this.fitAddon.fit();
		} catch {
			// renderer not ready yet
		}
		this.reportSize();
	}

	private reportSize(): void {
		const size = `${this.term.cols}x${this.term.rows}`;
		if (size === this.reported) return;
		this.reported = size;
		patchTab(this.id, { cols: this.term.cols, rows: this.term.rows });
	}

	focus(): void {
		if (this.opened) this.term.focus();
	}

	clear(): void {
		this.term.clear();
		this.focus();
	}

	setFontSize(size: number): void {
		if (this.term.options.fontSize === size) return;
		this.term.options.fontSize = size;
		this.fit();
	}

	/** Opens (or re-opens) the shell channel; output of earlier connections stays in the scrollback. */
	connect(): void {
		if (this.disposed) return;
		const reconnect = this.generation > 0;
		this.closeSocket();
		const gen = ++this.generation;
		if (reconnect) this.term.write(`\r\n${DIM}── 重新连接 ──${RESET}\r\n`);
		this.setStatus("connecting", { error: undefined, exitCode: undefined });
		let ws: WebSocket;
		try {
			ws = new WebSocket(
				termSocketUrl(window.location, { serverId: this.serverId, cwd: this.cwd, cols: this.term.cols, rows: this.term.rows }),
				wsProtocols(),
			);
		} catch (e) {
			this.setStatus("error", { error: e instanceof Error ? e.message : String(e) });
			return;
		}
		ws.binaryType = "arraybuffer";
		const current = () => gen === this.generation && !this.disposed;
		ws.onmessage = (ev: MessageEvent) => {
			if (!current()) return;
			if (ev.data instanceof ArrayBuffer) {
				this.term.write(new Uint8Array(ev.data));
				return;
			}
			const text = String(ev.data);
			const control = parseTermControl(text);
			if (!control) {
				this.term.write(text);
				return;
			}
			if (control.type === "ready") {
				this.setStatus("connected");
				ws.send(resizeMessage(this.term.cols, this.term.rows));
			} else if (control.type === "exit") {
				this.setStatus("exited", { exitCode: control.code });
				this.term.write(`\r\n${DIM}[会话已结束${control.code !== null ? `，退出码 ${control.code}` : ""}。点击「重新连接」可重新打开]${RESET}\r\n`);
			} else {
				this.setStatus("error", { error: control.message });
				this.term.write(`\r\n${RED}[错误] ${control.message}${RESET}\r\n`);
			}
		};
		ws.onclose = (ev: CloseEvent) => {
			if (!current()) return;
			this.socket = null;
			if (this.status === "connecting") {
				this.setStatus("error", { error: ev.reason || "无法建立终端连接" });
				this.term.write(`\r\n${RED}[无法建立终端连接]${RESET}\r\n`);
			} else if (this.status === "connected") {
				this.setStatus("closed");
				this.term.write(`\r\n${DIM}[连接已断开。点击「重新连接」可重新打开]${RESET}\r\n`);
			}
		};
		this.socket = ws;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.closeSocket();
		for (const d of this.disposables) d.dispose();
		this.term.dispose();
		this.element.remove();
	}

	private send(bytes: Uint8Array<ArrayBuffer>): void {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(bytes);
	}

	private setStatus(status: TerminalStatus, extra: Partial<TerminalTab> = {}): void {
		this.status = status;
		patchTab(this.id, { status, ...extra });
	}

	private closeSocket(): void {
		const ws = this.socket;
		this.socket = null;
		if (!ws) return;
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;
		if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
			try {
				ws.close(1000);
			} catch {
				// already closing
			}
		}
	}
}

let counter = 0;

export function getTerminalSession(id: string): TerminalSession | undefined {
	const session = terminalSessions.get(id);
	return session instanceof TerminalSession ? session : undefined;
}

/** Opens a new terminal tab (connects when its element is first attached) and makes it active. */
export function openTerminal(options: { workspaceId: string; serverId: string; cwd: string; fontSize: number }): string {
	counter += 1;
	const id = `term-${Date.now().toString(36)}-${counter}`;
	const existing = useTerminalStore.getState().tabs.filter((t) => t.workspaceId === options.workspaceId).map((t) => t.label);
	terminalSessions.set(id, new TerminalSession(id, options.serverId, options.cwd, options.fontSize));
	const tab: TerminalTab = {
		id,
		workspaceId: options.workspaceId,
		serverId: options.serverId,
		cwd: options.cwd,
		label: terminalLabel(options.cwd, existing),
		status: "connecting",
		cols: 0,
		rows: 0,
	};
	useTerminalStore.setState((s) => ({ tabs: [...s.tabs, tab], active: { ...s.active, [options.workspaceId]: id } }));
	return id;
}

export function setTerminalsFontSize(size: number): void {
	for (const session of terminalSessions.values()) if (session instanceof TerminalSession) session.setFontSize(size);
}

export { closeTerminal, closeWorkspaceTerminals, setActiveTerminal, type TerminalTab, useTerminalStore } from "./terminal-store";
