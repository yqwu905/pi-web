/**
 * Link: the framed, multiplexed protocol spoken between the Pi-Web host and the
 * remote pi-web-agent over a single byte stream (an SSH exec channel on the host
 * side, a Unix socket on the agent side).
 *
 * Frame layout: [type:u8][stream:u32 BE][len:u32 BE][payload:len bytes]
 *
 * - Msg / MsgPart (stream 0): one JSON message (request/response/event). Messages
 *   larger than MAX_FRAME_PAYLOAD are split into MsgPart frames terminated by a Msg
 *   frame holding the final piece.
 * - Open / OpenResult / Data / Close / Window: byte streams with credit-based flow
 *   control (used for the LLM tunnel proxy). Host-opened stream ids are odd,
 *   agent-opened ids are even.
 */
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";

export const LINK_PROTOCOL_VERSION = 1;

/** Written by the bridge on stdout before the first frame; the host skips any shell noise before it. */
export const LINK_PREAMBLE = "PIWEB-LINK/1\n";

export const FrameType = {
	Msg: 1,
	Open: 2,
	Data: 3,
	Close: 4,
	Window: 5,
	OpenResult: 6,
	MsgPart: 7,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export const FRAME_HEADER_SIZE = 9;
export const MAX_FRAME_PAYLOAD = 256 * 1024;
export const MAX_MESSAGE_SIZE = 64 * 1024 * 1024;
export const STREAM_WINDOW = 512 * 1024;
const DATA_CHUNK = 64 * 1024;
const MAX_PREAMBLE_SCAN = 256 * 1024;

export interface Frame {
	type: number;
	stream: number;
	payload: Buffer;
}

export class LinkProtocolError extends Error {
	readonly code = "LINK_PROTOCOL";
}

export class LinkRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "LinkRequestError";
	}
}

export function encodeFrame(type: number, stream: number, payload?: Buffer | string): Buffer {
	const body =
		payload === undefined ? Buffer.alloc(0) : typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
	if (body.length > MAX_FRAME_PAYLOAD) {
		throw new LinkProtocolError(`frame payload too large: ${body.length}`);
	}
	const frame = Buffer.allocUnsafe(FRAME_HEADER_SIZE + body.length);
	frame.writeUInt8(type, 0);
	frame.writeUInt32BE(stream >>> 0, 1);
	frame.writeUInt32BE(body.length, 5);
	body.copy(frame, FRAME_HEADER_SIZE);
	return frame;
}

/** Incremental frame parser. Feed it arbitrary chunks; it returns the complete frames. */
export class FrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): Frame[] {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const frames: Frame[] = [];
		let offset = 0;
		while (this.buffer.length - offset >= FRAME_HEADER_SIZE) {
			const type = this.buffer.readUInt8(offset);
			const stream = this.buffer.readUInt32BE(offset + 1);
			const len = this.buffer.readUInt32BE(offset + 5);
			if (len > MAX_FRAME_PAYLOAD) {
				throw new LinkProtocolError(`incoming frame payload too large: ${len}`);
			}
			if (this.buffer.length - offset - FRAME_HEADER_SIZE < len) break;
			const start = offset + FRAME_HEADER_SIZE;
			frames.push({ type, stream, payload: Buffer.from(this.buffer.subarray(start, start + len)) });
			offset = start + len;
		}
		this.buffer = offset === this.buffer.length ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(offset));
		return frames;
	}
}

export interface LinkRequestMessage {
	t: "req";
	id: number;
	method: string;
	params?: unknown;
}
export interface LinkErrorPayload {
	code: string;
	message: string;
	data?: unknown;
}
export interface LinkResponseMessage {
	t: "res";
	id: number;
	result?: unknown;
	error?: LinkErrorPayload;
}
export interface LinkEventMessage {
	t: "evt";
	event: string;
	data?: unknown;
}
export type LinkMessage = LinkRequestMessage | LinkResponseMessage | LinkEventMessage;

export interface StreamOpenResultPayload {
	ok: boolean;
	error?: string;
	/** Optional HTTP-ish status the opener can surface (e.g. 403 for a denied proxy target). */
	status?: number;
}

export type RequestHandler = (params: any, peer: LinkPeer) => unknown | Promise<unknown>;

export interface StreamOpenControl {
	accept(): LinkStream;
	reject(error: string, status?: number): void;
}
export type StreamOpenHandler = (meta: any, control: StreamOpenControl) => void;

export interface LinkPeerOptions {
	side: "host" | "agent";
	/** Default timeout for request(); 0 disables. Default 60s. */
	requestTimeoutMs?: number;
	/** When set, incoming bytes are discarded until this exact marker has been seen. */
	preamble?: string;
}

interface PendingRequest {
	method: string;
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer?: NodeJS.Timeout;
}

/**
 * One end of a Link. Both the host (over an SSH channel) and the agent (over a Unix
 * socket) use this same class so the two sides cannot drift apart.
 *
 * Events: "event" (name, data), "close" (error | undefined), "junk" (text seen before the preamble).
 */
export class LinkPeer extends EventEmitter {
	readonly side: "host" | "agent";
	/** Resolves once the preamble has been seen (immediately when no preamble is expected). */
	readonly ready: Promise<void>;
	/** Bytes discarded before the preamble, for diagnostics. */
	preambleJunk = "";

	private readonly decoder = new FrameDecoder();
	private readonly requestTimeoutMs: number;
	private readonly handlers = new Map<string, RequestHandler>();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly streams = new Map<number, LinkStream>();
	private nextRequestId = 1;
	private nextStreamId: number;
	private msgParts: Buffer[] = [];
	private msgPartsLength = 0;
	private preamble: Buffer | null;
	private preambleBuffer: Buffer = Buffer.alloc(0);
	private resolveReady!: () => void;
	private rejectReady!: (err: Error) => void;
	private streamOpenHandler?: StreamOpenHandler;
	private drainWaiters: Array<() => void> = [];
	private closedError: Error | undefined;
	private isClosed = false;

	constructor(
		private readonly transport: Duplex,
		options: LinkPeerOptions,
	) {
		super();
		this.side = options.side;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
		this.nextStreamId = options.side === "host" ? 1 : 2;
		this.preamble = options.preamble ? Buffer.from(options.preamble, "utf8") : null;
		this.ready = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		// Avoid unhandled rejections when nobody awaits `ready`.
		this.ready.catch(() => {});
		if (!this.preamble) this.resolveReady();

		this.handlers.set("link.ping", () => ({ now: Date.now() }));

		transport.on("data", (chunk: Buffer | string) => this.onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
		transport.on("drain", () => this.flushDrainWaiters());
		transport.on("error", (err: Error) => this.destroy(err));
		transport.on("close", () => this.destroy());
		transport.on("end", () => this.destroy());
	}

	get closed(): boolean {
		return this.isClosed;
	}

	/** Register a handler for incoming requests of `method`. */
	handle(method: string, handler: RequestHandler): this {
		this.handlers.set(method, handler);
		return this;
	}

	/** Register the handler that decides about streams opened by the other side. */
	onStreamOpen(handler: StreamOpenHandler): this {
		this.streamOpenHandler = handler;
		return this;
	}

	request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> {
		if (this.isClosed) {
			return Promise.reject(new LinkRequestError("LINK_CLOSED", this.closedError?.message ?? "link closed"));
		}
		const id = this.nextRequestId++;
		return new Promise<T>((resolve, reject) => {
			const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
			const entry: PendingRequest = { method, resolve, reject };
			if (timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new LinkRequestError("TIMEOUT", `${method} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				entry.timer.unref?.();
			}
			this.pending.set(id, entry);
			try {
				this.sendMessage({ t: "req", id, method, params });
			} catch (err) {
				if (entry.timer) clearTimeout(entry.timer);
				this.pending.delete(id);
				reject(err as Error);
			}
		});
	}

	/** Fire-and-forget event to the other side. Returns false when the link is closed. */
	emitEvent(event: string, data?: unknown): boolean {
		if (this.isClosed) return false;
		try {
			this.sendMessage({ t: "evt", event, data });
			return true;
		} catch {
			return false;
		}
	}

	/** Open a byte stream; resolves once the other side accepted it. */
	openStream(meta: unknown, options?: { timeoutMs?: number }): Promise<LinkStream> {
		if (this.isClosed) {
			return Promise.reject(new LinkRequestError("LINK_CLOSED", this.closedError?.message ?? "link closed"));
		}
		const id = this.nextStreamId;
		this.nextStreamId += 2;
		const stream = new LinkStream(this, id);
		this.streams.set(id, stream);
		return new Promise<LinkStream>((resolve, reject) => {
			const timeoutMs = options?.timeoutMs ?? 30_000;
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							stream.pendingOpen = undefined;
							this.streams.delete(id);
							this.sendFrameSafe(FrameType.Close, id, JSON.stringify({ error: "open timeout" }));
							reject(new LinkRequestError("TIMEOUT", `stream open timed out after ${timeoutMs}ms`));
						}, timeoutMs)
					: undefined;
			timer?.unref?.();
			stream.pendingOpen = {
				resolve: () => {
					if (timer) clearTimeout(timer);
					resolve(stream);
				},
				reject: (err) => {
					if (timer) clearTimeout(timer);
					reject(err);
				},
			};
			this.sendFrameSafe(FrameType.Open, id, JSON.stringify(meta ?? {}));
		});
	}

	/** Gracefully end the transport. */
	close(): void {
		if (this.isClosed) return;
		this.transport.end();
		this.destroy();
	}

	destroy(err?: Error): void {
		if (this.isClosed) return;
		this.isClosed = true;
		this.closedError = err;
		const closeErr = new LinkRequestError("LINK_CLOSED", err?.message ?? "link closed");
		for (const [id, entry] of this.pending) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(closeErr);
			this.pending.delete(id);
		}
		for (const stream of [...this.streams.values()]) {
			stream.pendingOpen?.reject(closeErr);
			stream.pendingOpen = undefined;
			stream.destroy(closeErr);
		}
		this.streams.clear();
		this.flushDrainWaiters();
		this.rejectReady(closeErr);
		if (!this.transport.destroyed) this.transport.destroy();
		this.emit("close", err);
	}

	// ---- internals shared with LinkStream ----

	/** @internal */
	isTransportBlocked(): boolean {
		return this.transport.writableNeedDrain;
	}

	/** @internal */
	onceDrain(fn: () => void): void {
		if (this.isClosed) {
			fn();
			return;
		}
		this.drainWaiters.push(fn);
	}

	/** @internal */
	sendFrameSafe(type: number, stream: number, payload?: Buffer | string): void {
		if (this.isClosed || this.transport.destroyed) return;
		this.transport.write(encodeFrame(type, stream, payload));
	}

	/** @internal */
	removeStream(id: number): void {
		this.streams.delete(id);
	}

	private flushDrainWaiters(): void {
		const waiters = this.drainWaiters;
		this.drainWaiters = [];
		for (const fn of waiters) fn();
	}

	private sendMessage(message: LinkMessage): void {
		const body = Buffer.from(JSON.stringify(message), "utf8");
		if (body.length > MAX_MESSAGE_SIZE) {
			throw new LinkRequestError("MESSAGE_TOO_LARGE", `message too large: ${body.length} bytes`);
		}
		let offset = 0;
		while (body.length - offset > MAX_FRAME_PAYLOAD) {
			this.sendFrameSafe(FrameType.MsgPart, 0, body.subarray(offset, offset + MAX_FRAME_PAYLOAD));
			offset += MAX_FRAME_PAYLOAD;
		}
		this.sendFrameSafe(FrameType.Msg, 0, body.subarray(offset));
	}

	private onData(chunk: Buffer): void {
		if (this.isClosed) return;
		if (this.preamble) {
			this.preambleBuffer = Buffer.concat([this.preambleBuffer, chunk]);
			const index = this.preambleBuffer.indexOf(this.preamble);
			if (index < 0) {
				if (this.preambleBuffer.length > MAX_PREAMBLE_SCAN) {
					this.preambleJunk += this.preambleBuffer.subarray(0, this.preambleBuffer.length - this.preamble.length).toString("utf8");
					this.preambleBuffer = Buffer.from(this.preambleBuffer.subarray(this.preambleBuffer.length - this.preamble.length));
				}
				return;
			}
			if (index > 0) {
				this.preambleJunk += this.preambleBuffer.subarray(0, index).toString("utf8");
				this.emit("junk", this.preambleJunk);
			}
			chunk = Buffer.from(this.preambleBuffer.subarray(index + this.preamble.length));
			this.preamble = null;
			this.preambleBuffer = Buffer.alloc(0);
			this.resolveReady();
			if (chunk.length === 0) return;
		}
		let frames: Frame[];
		try {
			frames = this.decoder.push(chunk);
		} catch (err) {
			this.destroy(err as Error);
			return;
		}
		for (const frame of frames) {
			try {
				this.dispatch(frame);
			} catch (err) {
				this.destroy(err as Error);
				return;
			}
		}
	}

	private dispatch(frame: Frame): void {
		switch (frame.type) {
			case FrameType.MsgPart: {
				this.msgPartsLength += frame.payload.length;
				if (this.msgPartsLength > MAX_MESSAGE_SIZE) throw new LinkProtocolError("incoming message too large");
				this.msgParts.push(frame.payload);
				return;
			}
			case FrameType.Msg: {
				let body = frame.payload;
				if (this.msgParts.length > 0) {
					body = Buffer.concat([...this.msgParts, frame.payload]);
					this.msgParts = [];
					this.msgPartsLength = 0;
				}
				this.onMessage(JSON.parse(body.toString("utf8")) as LinkMessage);
				return;
			}
			case FrameType.Open:
				this.onRemoteOpen(frame.stream, frame.payload);
				return;
			case FrameType.OpenResult: {
				const stream = this.streams.get(frame.stream);
				if (!stream?.pendingOpen) return;
				const result = parseJson<StreamOpenResultPayload>(frame.payload) ?? { ok: false, error: "bad open result" };
				const pendingOpen = stream.pendingOpen;
				stream.pendingOpen = undefined;
				if (result.ok) {
					pendingOpen.resolve();
				} else {
					this.streams.delete(frame.stream);
					pendingOpen.reject(
						new LinkRequestError("STREAM_REJECTED", result.error ?? "stream rejected", { status: result.status }),
					);
				}
				return;
			}
			case FrameType.Data:
				this.streams.get(frame.stream)?.onRemoteData(frame.payload);
				return;
			case FrameType.Window:
				if (frame.payload.length >= 4) this.streams.get(frame.stream)?.onWindow(frame.payload.readUInt32BE(0));
				return;
			case FrameType.Close: {
				const info = frame.payload.length > 0 ? parseJson<{ error?: string }>(frame.payload) : {};
				const stream = this.streams.get(frame.stream);
				if (!stream) return;
				if (stream.pendingOpen) {
					const pendingOpen = stream.pendingOpen;
					stream.pendingOpen = undefined;
					this.streams.delete(frame.stream);
					pendingOpen.reject(new LinkRequestError("STREAM_REJECTED", info?.error ?? "stream closed"));
					return;
				}
				stream.onRemoteClose(info ?? {});
				return;
			}
			default:
				// Unknown frame types are ignored for forward compatibility.
				return;
		}
	}

	private onMessage(message: LinkMessage): void {
		if (message.t === "req") {
			void this.onRequest(message);
		} else if (message.t === "res") {
			const entry = this.pending.get(message.id);
			if (!entry) return;
			this.pending.delete(message.id);
			if (entry.timer) clearTimeout(entry.timer);
			if (message.error) {
				entry.reject(new LinkRequestError(message.error.code, message.error.message, message.error.data));
			} else {
				entry.resolve(message.result);
			}
		} else if (message.t === "evt") {
			this.emit("event", message.event, message.data);
		}
	}

	private async onRequest(message: LinkRequestMessage): Promise<void> {
		const handler = this.handlers.get(message.method);
		if (!handler) {
			this.trySend({
				t: "res",
				id: message.id,
				error: { code: "METHOD_NOT_FOUND", message: `unknown method: ${message.method}` },
			});
			return;
		}
		try {
			const result = await handler(message.params, this);
			this.trySend({ t: "res", id: message.id, result: result === undefined ? null : result });
		} catch (err) {
			const e = err as { code?: unknown; message?: unknown; data?: unknown };
			this.trySend({
				t: "res",
				id: message.id,
				error: {
					code: typeof e?.code === "string" ? e.code : "ERROR",
					message: typeof e?.message === "string" ? e.message : String(err),
					data: e?.data,
				},
			});
		}
	}

	private trySend(message: LinkMessage): void {
		try {
			this.sendMessage(message);
		} catch (err) {
			if (message.t === "res") {
				try {
					this.sendMessage({
						t: "res",
						id: message.id,
						error: { code: "SEND_FAILED", message: (err as Error).message },
					});
				} catch {
					// give up: the link is unusable
				}
			}
		}
	}

	private onRemoteOpen(id: number, payload: Buffer): void {
		const meta = parseJson<unknown>(payload) ?? {};
		if (!this.streamOpenHandler) {
			this.sendFrameSafe(FrameType.OpenResult, id, JSON.stringify({ ok: false, error: "streams not supported" }));
			return;
		}
		let settled = false;
		const control: StreamOpenControl = {
			accept: () => {
				if (settled) throw new Error("stream open already settled");
				settled = true;
				const stream = new LinkStream(this, id);
				this.streams.set(id, stream);
				this.sendFrameSafe(FrameType.OpenResult, id, JSON.stringify({ ok: true }));
				return stream;
			},
			reject: (error, status) => {
				if (settled) return;
				settled = true;
				this.sendFrameSafe(FrameType.OpenResult, id, JSON.stringify({ ok: false, error, status }));
			},
		};
		try {
			this.streamOpenHandler(meta, control);
		} catch (err) {
			control.reject((err as Error).message ?? "stream open failed");
		}
	}
}

/**
 * A multiplexed byte stream over a Link. Behaves like a half-closable TCP socket:
 * end() sends FIN, destroy(err) resets both directions.
 */
export class LinkStream extends Duplex {
	/** @internal set while the opener waits for OpenResult */
	pendingOpen?: { resolve: () => void; reject: (err: Error) => void };

	private sendWindow = STREAM_WINDOW;
	private unacked = 0;
	private pendingWrite?: { chunk: Buffer; offset: number; callback: (err?: Error | null) => void };
	private localFin = false;
	private remoteFin = false;
	private resetSent = false;

	constructor(
		private readonly peer: LinkPeer,
		readonly id: number,
	) {
		super({ allowHalfOpen: true });
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
		this.pendingWrite = { chunk, offset: 0, callback };
		this.flushWrite();
	}

	override _final(callback: (err?: Error | null) => void): void {
		this.localFin = true;
		this.peer.sendFrameSafe(FrameType.Close, this.id);
		this.maybeRelease();
		callback();
	}

	override _read(): void {
		this.sendCredit(true);
	}

	override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
		if (!(this.localFin && this.remoteFin) && !this.resetSent && !this.peer.closed) {
			this.resetSent = true;
			this.peer.sendFrameSafe(FrameType.Close, this.id, JSON.stringify({ error: err?.message ?? "reset" }));
		}
		const pendingWrite = this.pendingWrite;
		this.pendingWrite = undefined;
		pendingWrite?.callback(err ?? new Error("stream destroyed"));
		this.peer.removeStream(this.id);
		callback(err);
	}

	/** @internal */
	onRemoteData(data: Buffer): void {
		if (this.destroyed || this.remoteFin) return;
		this.unacked += data.length;
		if (this.push(data)) this.sendCredit(false);
	}

	/** @internal */
	onWindow(credit: number): void {
		this.sendWindow += credit;
		this.flushWrite();
	}

	/** @internal */
	onRemoteClose(info: { error?: string }): void {
		if (info.error) {
			this.resetSent = true;
			// Deferred so a caller that awaits openStream() can attach an "error" listener first.
			const err = new Error(info.error);
			setImmediate(() => this.destroy(err));
			return;
		}
		if (this.remoteFin) return;
		this.remoteFin = true;
		this.push(null);
		this.maybeRelease();
	}

	private maybeRelease(): void {
		if (this.localFin && this.remoteFin) this.peer.removeStream(this.id);
	}

	private sendCredit(force: boolean): void {
		if (this.unacked <= 0 || this.destroyed) return;
		if (!force && this.unacked < STREAM_WINDOW / 4) return;
		const credit = Buffer.allocUnsafe(4);
		credit.writeUInt32BE(this.unacked, 0);
		this.unacked = 0;
		this.peer.sendFrameSafe(FrameType.Window, this.id, credit);
	}

	private flushWrite(): void {
		const pending = this.pendingWrite;
		if (!pending) return;
		while (pending.offset < pending.chunk.length) {
			if (this.destroyed || this.peer.closed) {
				this.pendingWrite = undefined;
				pending.callback(new Error("stream closed"));
				return;
			}
			if (this.sendWindow <= 0) return;
			if (this.peer.isTransportBlocked()) {
				this.peer.onceDrain(() => this.flushWrite());
				return;
			}
			const size = Math.min(DATA_CHUNK, this.sendWindow, pending.chunk.length - pending.offset);
			this.peer.sendFrameSafe(FrameType.Data, this.id, pending.chunk.subarray(pending.offset, pending.offset + size));
			this.sendWindow -= size;
			pending.offset += size;
		}
		this.pendingWrite = undefined;
		pending.callback();
	}
}

function parseJson<T>(payload: Buffer): T | undefined {
	try {
		return JSON.parse(payload.toString("utf8")) as T;
	} catch {
		return undefined;
	}
}
