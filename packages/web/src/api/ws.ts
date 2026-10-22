/**
 * Single multiplexed WebSocket to the host (`/ws`).
 *
 * - Topic subscriptions are ref-counted: the first handler of a topic sends `subscribe`,
 *   the last one leaving sends `unsubscribe`. Changes are batched per microtask, so an
 *   unsubscribe immediately followed by a subscribe (React StrictMode) sends nothing.
 * - Auto-reconnect with exponential backoff (0.5s → 15s, jitter); every topic is
 *   re-subscribed after reconnecting. Events published while disconnected are lost, so
 *   consumers that need continuity listen to `onOpen` ({ reconnect: true }) and resync.
 * - Heartbeat: sends `{type:"ping"}` every 25s and reconnects when nothing arrived for 65s.
 *
 * React code should use the hooks in ./hooks.ts (useTopic, useWsStatus, useWsReconnect).
 */
import type { WsClientMessage, WsServerMessage, WsTopic } from "@pi-web/shared";
import { wsProtocols } from "./auth-token";

export type WsState = "connecting" | "open" | "reconnecting";

export interface WsStatus {
	state: WsState;
	/** Failed attempts since the last successful open. */
	attempt: number;
	/** When the next reconnect attempt is scheduled (epoch ms), while reconnecting. */
	nextRetryAt: number | null;
	/** Increments on every successful open; > 1 means at least one reconnect happened. */
	generation: number;
	/** Host version from the hello message. */
	serverVersion?: string;
}

export type TopicHandler<T = unknown> = (data: T, topic: WsTopic) => void;

const PING_INTERVAL_MS = 25_000;
const STALE_AFTER_MS = 65_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;

/** Exponential backoff with ±20% jitter (exported for tests). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
	const raw = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
	return Math.round(raw * (0.8 + random() * 0.4));
}

/** Topics to (un)subscribe so that the server-side set `sent` matches `desired`. */
export function diffTopics(desired: Iterable<string>, sent: Iterable<string>): { subscribe: string[]; unsubscribe: string[] } {
	const want = new Set(desired);
	const have = new Set(sent);
	return {
		subscribe: [...want].filter((t) => !have.has(t)),
		unsubscribe: [...have].filter((t) => !want.has(t)),
	};
}

function defaultUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}/ws`;
}

export class WsClient {
	private socket: WebSocket | null = null;
	private readonly handlers = new Map<string, Set<TopicHandler>>();
	/** Topics the current socket is subscribed to. */
	private sent = new Set<string>();
	private flushQueued = false;
	private started = false;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private lastMessageAt = 0;
	private status: WsStatus = { state: "connecting", attempt: 0, nextRetryAt: null, generation: 0 };
	private readonly statusListeners = new Set<(status: WsStatus) => void>();
	private readonly openListeners = new Set<(info: { reconnect: boolean }) => void>();

	constructor(private readonly url: () => string = defaultUrl) {}

	/** Opens the connection (idempotent). Called automatically by the first subscribe. */
	start(): void {
		if (this.started) return;
		this.started = true;
		if (typeof window !== "undefined") {
			window.addEventListener("online", this.wake);
			document.addEventListener("visibilitychange", this.onVisibility);
		}
		this.connect();
	}

	/** Closes the connection and stops reconnecting. */
	stop(): void {
		this.started = false;
		if (typeof window !== "undefined") {
			window.removeEventListener("online", this.wake);
			document.removeEventListener("visibilitychange", this.onVisibility);
		}
		this.clearTimers();
		const s = this.socket;
		this.socket = null;
		s?.close();
	}

	getStatus(): WsStatus {
		return this.status;
	}

	/** Status changes (state, attempt, generation). Returns an unsubscribe function. */
	onStatus(listener: (status: WsStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	/** Called after every successful open; `reconnect` is false for the very first one. */
	onOpen(listener: (info: { reconnect: boolean }) => void): () => void {
		this.openListeners.add(listener);
		return () => this.openListeners.delete(listener);
	}

	/** Ref-counted topic subscription. Returns an unsubscribe function. */
	subscribe<T = unknown>(topic: WsTopic, handler: TopicHandler<T>): () => void {
		this.start();
		let set = this.handlers.get(topic);
		if (!set) {
			set = new Set();
			this.handlers.set(topic, set);
		}
		const h = handler as TopicHandler;
		set.add(h);
		this.queueFlush();
		return () => {
			const current = this.handlers.get(topic);
			if (!current) return;
			current.delete(h);
			if (current.size === 0) this.handlers.delete(topic);
			this.queueFlush();
		};
	}

	/** Skips the backoff wait and reconnects now (no-op while open). */
	reconnectNow(): void {
		if (!this.started || this.status.state === "open") return;
		if (this.socket && this.socket.readyState === WebSocket.CONNECTING) return;
		this.clearTimers();
		this.connect();
	}

	private readonly wake = () => this.reconnectNow();
	private readonly onVisibility = () => {
		if (document.visibilityState === "visible") this.reconnectNow();
	};

	private setStatus(patch: Partial<WsStatus>): void {
		this.status = { ...this.status, ...patch };
		for (const l of [...this.statusListeners]) l(this.status);
	}

	private connect(): void {
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.url(), wsProtocols());
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		this.sent = new Set();
		socket.onopen = () => {
			if (this.socket !== socket) return;
			this.lastMessageAt = Date.now();
			const generation = this.status.generation + 1;
			this.setStatus({ state: "open", attempt: 0, nextRetryAt: null, generation });
			this.flush();
			this.startHeartbeat();
			for (const l of [...this.openListeners]) {
				try {
					l({ reconnect: generation > 1 });
				} catch (error) {
					console.error("[ws] open listener failed", error);
				}
			}
		};
		socket.onmessage = (ev) => {
			if (this.socket !== socket) return;
			this.lastMessageAt = Date.now();
			if (typeof ev.data !== "string") return;
			let msg: WsServerMessage;
			try {
				msg = JSON.parse(ev.data) as WsServerMessage;
			} catch {
				return;
			}
			this.handleMessage(msg);
		};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.sent = new Set();
			this.clearTimers();
			if (this.started) this.scheduleReconnect();
		};
		socket.onerror = () => {
			// onclose follows and schedules the reconnect.
		};
	}

	private handleMessage(msg: WsServerMessage): void {
		switch (msg.type) {
			case "hello":
				this.setStatus({ serverVersion: msg.version });
				break;
			case "event": {
				const set = this.handlers.get(msg.topic);
				if (!set) return;
				for (const h of [...set]) {
					try {
						h(msg.data, msg.topic);
					} catch (error) {
						console.error(`[ws] handler for ${msg.topic} failed`, error);
					}
				}
				break;
			}
			case "error":
				console.warn("[ws] server error:", msg.message);
				break;
			default:
				break;
		}
	}

	private scheduleReconnect(): void {
		const attempt = this.status.attempt;
		const delay = backoffDelay(attempt);
		this.setStatus({ state: "reconnecting", attempt: attempt + 1, nextRetryAt: Date.now() + delay });
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			if (this.started) this.connect();
		}, delay);
	}

	private startHeartbeat(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = setInterval(() => {
			const s = this.socket;
			if (!s || s.readyState !== WebSocket.OPEN) return;
			if (Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
				s.close();
				return;
			}
			this.send({ type: "ping" });
		}, PING_INTERVAL_MS);
	}

	private clearTimers(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.retryTimer = null;
		this.pingTimer = null;
	}

	private queueFlush(): void {
		if (this.flushQueued) return;
		this.flushQueued = true;
		queueMicrotask(() => {
			this.flushQueued = false;
			this.flush();
		});
	}

	private flush(): void {
		const s = this.socket;
		if (!s || s.readyState !== WebSocket.OPEN) return;
		const { subscribe, unsubscribe } = diffTopics(this.handlers.keys(), this.sent);
		if (subscribe.length) this.send({ type: "subscribe", topics: subscribe });
		if (unsubscribe.length) this.send({ type: "unsubscribe", topics: unsubscribe });
		for (const t of subscribe) this.sent.add(t);
		for (const t of unsubscribe) this.sent.delete(t);
	}

	private send(msg: WsClientMessage): void {
		const s = this.socket;
		if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
	}
}

/** The app-wide connection. */
export const wsClient = new WsClient();
