/**
 * EventHub: fans out host events to browser WebSockets on /ws by topic
 * (see WsTopic in @pi-web/shared/api).
 */
import type { WsClientMessage, WsServerMessage } from "@pi-web/shared";
import type { RawData, WebSocket } from "ws";
import type { EventHub, Logger } from "./core/types.js";

export interface WsHub extends EventHub {
	/** Takes ownership of an accepted /ws socket: sends hello, then serves subscribe/unsubscribe/ping. */
	handleSocket(socket: WebSocket): void;
	/** Number of connected sockets. */
	readonly size: number;
	/** Closes every socket and stops the heartbeat. */
	close(): void;
}

export interface EventHubOptions {
	version: string;
	log?: Logger;
	/** Protocol-level ping interval; sockets that did not answer the previous ping are terminated. Default 30s. */
	pingIntervalMs?: number;
	/**
	 * A socket whose unsent buffer exceeds this many bytes is considered stuck and is terminated
	 * (the browser reconnects and resyncs). Default 8 MiB.
	 */
	maxBufferedBytes?: number;
	/** Default 2000. */
	maxTopicsPerSocket?: number;
}

const WS_OPEN = 1;
const MAX_TOPIC_LENGTH = 256;

interface HubClient {
	socket: WebSocket;
	topics: Set<string>;
	alive: boolean;
}

export function isWsHub(hub: EventHub): hub is WsHub {
	return typeof (hub as Partial<WsHub>).handleSocket === "function";
}

export function createEventHub(options: EventHubOptions): WsHub {
	const log = options.log;
	const pingIntervalMs = options.pingIntervalMs ?? 30_000;
	const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;
	const maxTopics = options.maxTopicsPerSocket ?? 2000;
	const clients = new Set<HubClient>();
	const byTopic = new Map<string, Set<HubClient>>();

	const heartbeat = setInterval(() => {
		for (const client of clients) {
			if (!client.alive) {
				log?.debug("ws client missed pong, terminating");
				drop(client, true);
				continue;
			}
			client.alive = false;
			try {
				client.socket.ping();
			} catch {
				drop(client, true);
			}
		}
	}, pingIntervalMs);
	heartbeat.unref?.();

	function drop(client: HubClient, terminate: boolean): void {
		if (!clients.delete(client)) return;
		for (const topic of client.topics) unindex(client, topic);
		client.topics.clear();
		if (terminate) {
			try {
				client.socket.terminate();
			} catch {
				// already gone
			}
		}
	}

	function unindex(client: HubClient, topic: string): void {
		const set = byTopic.get(topic);
		if (!set) return;
		set.delete(client);
		if (set.size === 0) byTopic.delete(topic);
	}

	function sendRaw(client: HubClient, payload: string): void {
		const socket = client.socket;
		if (socket.readyState !== WS_OPEN) return;
		if (socket.bufferedAmount > maxBufferedBytes) {
			log?.warn("ws client too slow, terminating", { bufferedAmount: socket.bufferedAmount });
			drop(client, true);
			return;
		}
		try {
			socket.send(payload, (err) => {
				if (err) drop(client, true);
			});
		} catch {
			drop(client, true);
		}
	}

	function send(client: HubClient, message: WsServerMessage): void {
		sendRaw(client, JSON.stringify(message));
	}

	function onMessage(client: HubClient, raw: RawData, isBinary: boolean): void {
		client.alive = true;
		if (isBinary) {
			send(client, { type: "error", message: "不支持二进制消息" });
			return;
		}
		let message: WsClientMessage;
		try {
			message = JSON.parse(rawToString(raw)) as WsClientMessage;
		} catch {
			send(client, { type: "error", message: "消息不是有效的 JSON" });
			return;
		}
		if (!message || typeof message !== "object") {
			send(client, { type: "error", message: "消息格式错误" });
			return;
		}
		switch (message.type) {
			case "ping":
				send(client, { type: "pong" });
				return;
			case "subscribe":
			case "unsubscribe": {
				const topics = Array.isArray(message.topics) ? message.topics : null;
				if (!topics || topics.some((t) => typeof t !== "string" || t.length === 0 || t.length > MAX_TOPIC_LENGTH)) {
					send(client, { type: "error", message: "topics 必须是非空字符串数组" });
					return;
				}
				if (message.type === "subscribe") {
					for (const topic of topics) {
						if (client.topics.has(topic)) continue;
						if (client.topics.size >= maxTopics) {
							send(client, { type: "error", message: `订阅的主题过多（上限 ${maxTopics}）` });
							return;
						}
						client.topics.add(topic);
						let set = byTopic.get(topic);
						if (!set) {
							set = new Set();
							byTopic.set(topic, set);
						}
						set.add(client);
					}
				} else {
					for (const topic of topics) {
						if (client.topics.delete(topic)) unindex(client, topic);
					}
				}
				return;
			}
			default:
				send(client, { type: "error", message: "未知的消息类型" });
		}
	}

	return {
		get size() {
			return clients.size;
		},

		handleSocket(socket: WebSocket): void {
			const client: HubClient = { socket, topics: new Set(), alive: true };
			clients.add(client);
			socket.on("pong", () => {
				client.alive = true;
			});
			socket.on("message", (raw: RawData, isBinary: boolean) => onMessage(client, raw, isBinary));
			socket.on("close", () => drop(client, false));
			socket.on("error", () => drop(client, true));
			send(client, { type: "hello", version: options.version });
		},

		publish(topic: string, data: unknown): void {
			const subscribers = byTopic.get(topic);
			if (!subscribers || subscribers.size === 0) return;
			let payload: string;
			try {
				payload = JSON.stringify({ type: "event", topic, data } satisfies WsServerMessage);
			} catch (err) {
				log?.error("ws publish: unserializable payload", { topic, error: (err as Error).message });
				return;
			}
			for (const client of [...subscribers]) sendRaw(client, payload);
		},

		subscriberCount(topic: string): number {
			return byTopic.get(topic)?.size ?? 0;
		},

		close(): void {
			clearInterval(heartbeat);
			for (const client of [...clients]) {
				try {
					client.socket.close(1001, "server shutting down");
				} catch {
					// ignore
				}
				drop(client, false);
			}
		},
	};
}

function rawToString(raw: RawData): string {
	if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
	if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
	return raw.toString("utf8");
}
