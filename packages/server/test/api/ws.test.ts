import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { WsServerMessage } from "@pi-web/shared";
import { buildApp } from "../../src/app.js";
import { createEventHub } from "../../src/ws.js";
import type { WsHub } from "../../src/ws.js";
import { createFakeContext, flush, until } from "./fakes.js";

interface Client {
	ws: WebSocket;
	messages: WsServerMessage[];
	send(message: unknown): void;
}

describe("/ws EventHub", () => {
	let app: FastifyInstance | undefined;
	let hub: WsHub;
	let port = 0;
	const clients: WebSocket[] = [];

	async function start(options: { token?: boolean; pingIntervalMs?: number } = {}) {
		hub = createEventHub({ version: "1.2.3", pingIntervalMs: options.pingIntervalMs });
		const fake = createFakeContext({ hub });
		if (options.token) {
			fake.store.settings.accessTokenEnabled = true;
			await fake.secrets.set("accessToken", "secret-token");
		}
		app = await buildApp(fake.ctx);
		await app.listen({ host: "127.0.0.1", port: 0 });
		port = (app.server.address() as { port: number }).port;
		return fake;
	}

	async function connect(headers: Record<string, string> = {}): Promise<Client> {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
		clients.push(ws);
		const messages: WsServerMessage[] = [];
		ws.on("message", (data) => messages.push(JSON.parse(String(data))));
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		await until(() => messages.length > 0);
		return { ws, messages, send: (m) => ws.send(JSON.stringify(m)) };
	}

	afterEach(async () => {
		for (const ws of clients.splice(0)) {
			ws.on("error", () => {});
			if (ws.readyState === WebSocket.OPEN) ws.terminate();
		}
		hub?.close();
		await app?.close();
		app = undefined;
	});

	it("greets with hello and delivers events only for subscribed topics", async () => {
		await start();
		const a = await connect();
		const b = await connect();
		expect(a.messages[0]).toEqual({ type: "hello", version: "1.2.3" });

		a.send({ type: "subscribe", topics: ["servers", "conv:c1"] });
		b.send({ type: "subscribe", topics: ["servers"] });
		await until(() => hub.subscriberCount("servers") === 2);
		expect(hub.subscriberCount("conv:c1")).toBe(1);
		expect(hub.size).toBe(2);

		hub.publish("conv:c1", { seq: 1 });
		hub.publish("servers", { serverId: "s" });
		hub.publish("nobody", { x: 1 });
		await until(() => a.messages.length === 3 && b.messages.length === 2);
		expect(a.messages.slice(1)).toEqual([
			{ type: "event", topic: "conv:c1", data: { seq: 1 } },
			{ type: "event", topic: "servers", data: { serverId: "s" } },
		]);
		expect(b.messages.slice(1)).toEqual([{ type: "event", topic: "servers", data: { serverId: "s" } }]);

		a.send({ type: "unsubscribe", topics: ["conv:c1"] });
		await until(() => hub.subscriberCount("conv:c1") === 0);
		hub.publish("conv:c1", { seq: 2 });
		await flush();
		expect(a.messages).toHaveLength(3);
	});

	it("answers ping and reports malformed messages", async () => {
		await start();
		const c = await connect();
		c.send({ type: "ping" });
		c.ws.send("not json");
		c.send({ type: "subscribe", topics: "servers" });
		c.send({ type: "dance" });
		c.ws.send(Buffer.from([1, 2, 3]));
		await until(() => c.messages.length === 6);
		expect(c.messages.slice(1)).toEqual([
			{ type: "pong" },
			{ type: "error", message: "消息不是有效的 JSON" },
			{ type: "error", message: "topics 必须是非空字符串数组" },
			{ type: "error", message: "未知的消息类型" },
			{ type: "error", message: "不支持二进制消息" },
		]);
	});

	it("forgets subscriptions of closed sockets", async () => {
		await start();
		const c = await connect();
		c.send({ type: "subscribe", topics: ["sync"] });
		await until(() => hub.subscriberCount("sync") === 1);
		c.ws.close();
		await until(() => hub.subscriberCount("sync") === 0 && hub.size === 0);
		expect(() => hub.publish("sync", {})).not.toThrow();
	});

	it("terminates sockets that stop answering protocol pings", async () => {
		await start({ pingIntervalMs: 30 });
		const c = await connect();
		// Keep answering: the socket survives several heartbeats.
		await new Promise((r) => setTimeout(r, 120));
		expect(hub.size).toBe(1);
		// A client that no longer answers pings gets dropped.
		(c.ws as unknown as { _receiver: EventEmitter })._receiver.removeAllListeners("ping");
		c.ws.pong = () => {};
		await until(() => hub.size === 0, 2000);
	});

	it("rejects cross-origin handshakes and requires the token when enabled", async () => {
		await start({ token: true });
		const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: "http://evil.example", cookie: "pi_web_token=secret-token" } });
		clients.push(bad);
		const badStatus = await new Promise<number>((resolve) => bad.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
		expect(badStatus).toBe(403);

		const anonymous = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		clients.push(anonymous);
		const anonStatus = await new Promise<number>((resolve) => anonymous.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
		expect(anonStatus).toBe(401);

		const ok = await connect({ origin: `http://127.0.0.1:${port}`, cookie: "pi_web_token=secret-token" });
		expect(ok.messages[0]).toEqual({ type: "hello", version: "1.2.3" });
	});
});

describe("EventHub without a server", () => {
	class StuckSocket extends EventEmitter {
		readyState = 1;
		bufferedAmount = 0;
		sent: string[] = [];
		terminated = false;
		send(data: string): void {
			this.sent.push(data);
		}
		ping(): void {}
		close(): void {
			this.readyState = 3;
		}
		terminate(): void {
			this.terminated = true;
			this.readyState = 3;
			this.emit("close");
		}
	}

	it("drops sockets whose send buffer is over the limit instead of buffering forever", () => {
		const hub = createEventHub({ version: "v", maxBufferedBytes: 100 });
		const fast = new StuckSocket();
		const slow = new StuckSocket();
		hub.handleSocket(fast as never);
		hub.handleSocket(slow as never);
		for (const s of [fast, slow]) s.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", topics: ["t"] })), false);
		slow.bufferedAmount = 1000;
		hub.publish("t", { n: 1 });
		expect(slow.terminated).toBe(true);
		expect(fast.sent.at(-1)).toBe(JSON.stringify({ type: "event", topic: "t", data: { n: 1 } }));
		expect(hub.subscriberCount("t")).toBe(1);
		hub.close();
	});

	it("survives sockets whose send throws and unserializable payloads", () => {
		const hub = createEventHub({ version: "v" });
		const broken = new StuckSocket();
		hub.handleSocket(broken as never);
		broken.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", topics: ["t"] })), false);
		broken.send = () => {
			throw new Error("boom");
		};
		expect(() => hub.publish("t", 1)).not.toThrow();
		expect(broken.terminated).toBe(true);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => hub.publish("t", circular)).not.toThrow();
		hub.close();
	});
});
