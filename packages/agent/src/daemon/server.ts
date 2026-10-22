import { EventEmitter } from "node:events";
import { chmod, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { LinkPeer } from "@pi-web/shared/link";
import { errnoCode } from "./errors.js";

export type ListenOutcome = "listening" | "already-running";

/**
 * Unix-socket server: one LinkPeer per connected bridge (host). Events are broadcast to
 * every connected peer. Emits "peer" (peer) and "peer-closed" (peer).
 */
/** The host pings every 15s: a peer silent for this long is gone (e.g. its laptop slept). */
export const PEER_IDLE_TIMEOUT_MS = 60_000;

export interface LinkServerOptions {
	/** Destroy a peer that sent nothing for this long (default PEER_IDLE_TIMEOUT_MS). */
	idleTimeoutMs?: number;
	/** Destroy a peer whose unsent bytes exceed this (default: LinkPeer's default cap). */
	maxBufferedBytes?: number;
}

export class LinkServer extends EventEmitter {
	private server: Server | null = null;
	private closing: Promise<void> = Promise.resolve();
	/** Connected peers in connection order (newest last). */
	private readonly peers: LinkPeer[] = [];

	constructor(
		private readonly setupPeer: (peer: LinkPeer) => void,
		private readonly options: LinkServerOptions = {},
	) {
		super();
	}

	get peerCount(): number {
		return this.peers.length;
	}

	/** Most recently connected peer that is still open. */
	latestPeer(): LinkPeer | undefined {
		for (let i = this.peers.length - 1; i >= 0; i--) {
			if (!this.peers[i].closed) return this.peers[i];
		}
		return undefined;
	}

	broadcast(event: string, data: unknown): void {
		for (const peer of this.peers) peer.emitEvent(event, data);
	}

	/**
	 * Listens on `socketPath`. On EADDRINUSE, probes the socket: when another instance
	 * answers, returns "already-running"; otherwise removes the stale socket and retries.
	 */
	async listen(socketPath: string): Promise<ListenOutcome> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this.tryListen(socketPath);
				await chmod(socketPath, 0o600).catch(() => {});
				return "listening";
			} catch (err) {
				if (errnoCode(err) !== "EADDRINUSE") throw err;
				if (await isSocketAlive(socketPath)) return "already-running";
				await unlink(socketPath).catch(() => {});
			}
		}
		throw new Error(`cannot listen on ${socketPath}`);
	}

	/** Stops accepting connections and removes the socket file; connected peers stay open. */
	stopListening(): void {
		const server = this.server;
		this.server = null;
		if (server) this.closing = new Promise<void>((resolve) => server.close(() => resolve()));
	}

	async close(): Promise<void> {
		this.stopListening();
		for (const peer of [...this.peers]) peer.close();
		await this.closing;
	}

	private tryListen(socketPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((socket) => this.onConnection(socket));
			const onError = (err: Error) => {
				server.close();
				reject(err);
			};
			server.once("error", onError);
			server.listen(socketPath, () => {
				server.off("error", onError);
				server.on("error", () => {});
				this.server = server;
				resolve();
			});
		});
	}

	private onConnection(socket: Socket): void {
		socket.on("error", () => {});
		// Events are broadcast without backpressure: a peer that stopped reading (dead SSH session
		// lingering in TCP retransmits) is dropped by the idle timeout or the write-buffer cap
		// instead of buffering every event in memory. The host reconnects and resyncs.
		const peer = new LinkPeer(socket, {
			side: "agent",
			requestTimeoutMs: 60_000,
			idleTimeoutMs: this.options.idleTimeoutMs ?? PEER_IDLE_TIMEOUT_MS,
			maxBufferedBytes: this.options.maxBufferedBytes,
		});
		this.peers.push(peer);
		peer.once("close", () => {
			const index = this.peers.indexOf(peer);
			if (index >= 0) this.peers.splice(index, 1);
			this.emit("peer-closed", peer);
		});
		this.setupPeer(peer);
		this.emit("peer", peer);
	}
}

/** True when something accepts connections on the unix socket. */
export function isSocketAlive(socketPath: string, timeoutMs = 1000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const done = (alive: boolean) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(alive);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}
