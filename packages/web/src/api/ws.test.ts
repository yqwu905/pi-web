import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient, backoffDelay, diffTopics } from "./ws";

class FakeSocket {
	static instances: FakeSocket[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	readyState = FakeSocket.CONNECTING;
	sent: unknown[] = [];
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.();
	}
	open() {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}
	receive(msg: unknown) {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("pure helpers", () => {
	it("computes backoff with jitter and a cap", () => {
		expect(backoffDelay(0, () => 0.5)).toBe(500);
		expect(backoffDelay(3, () => 0.5)).toBe(4000);
		expect(backoffDelay(20, () => 0.5)).toBe(15000);
		expect(backoffDelay(0, () => 0)).toBe(400);
		expect(backoffDelay(0, () => 1)).toBe(600);
	});
	it("diffs topic sets", () => {
		expect(diffTopics(["a", "b"], ["b", "c"])).toEqual({ subscribe: ["a"], unsubscribe: ["c"] });
		expect(diffTopics([], [])).toEqual({ subscribe: [], unsubscribe: [] });
	});
});

describe("WsClient", () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("ref-counts topics and batches (un)subscribe messages", async () => {
		const client = new WsClient(() => "ws://test/ws");
		const h1 = vi.fn();
		const h2 = vi.fn();
		const off1 = client.subscribe("servers", h1);
		const off2 = client.subscribe("servers", h2);
		const off3 = client.subscribe("convs", () => {});
		const sock = FakeSocket.instances[0];
		sock.open();
		expect(sock.sent).toEqual([{ type: "subscribe", topics: ["servers", "convs"] }]);

		sock.receive({ type: "event", topic: "servers", data: { serverId: "s1" } });
		expect(h1).toHaveBeenCalledWith({ serverId: "s1" }, "servers");
		expect(h2).toHaveBeenCalledTimes(1);

		off1();
		await flush();
		expect(sock.sent).toHaveLength(1);
		off2();
		off3();
		await flush();
		expect(sock.sent[1]).toEqual({ type: "unsubscribe", topics: ["servers", "convs"] });

		// Unsubscribe immediately followed by subscribe sends nothing.
		const off4 = client.subscribe("sync", () => {});
		await flush();
		off4();
		client.subscribe("sync", () => {});
		await flush();
		expect(sock.sent.slice(2)).toEqual([{ type: "subscribe", topics: ["sync"] }]);
		client.stop();
	});

	it("reconnects with backoff and resubscribes", async () => {
		const client = new WsClient(() => "ws://test/ws");
		const opens: boolean[] = [];
		client.onOpen(({ reconnect }) => opens.push(reconnect));
		client.subscribe("conv:c1", () => {});
		const first = FakeSocket.instances[0];
		first.open();
		expect(client.getStatus()).toMatchObject({ state: "open", generation: 1 });

		first.close();
		expect(client.getStatus().state).toBe("reconnecting");
		expect(FakeSocket.instances).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		const second = FakeSocket.instances[1];
		expect(second).toBeDefined();
		second.open();
		expect(second.sent).toEqual([{ type: "subscribe", topics: ["conv:c1"] }]);
		expect(opens).toEqual([false, true]);
		expect(client.getStatus()).toMatchObject({ state: "open", attempt: 0, generation: 2 });
		client.stop();
	});

	it("pings and drops stale connections", () => {
		const client = new WsClient(() => "ws://test/ws");
		client.start();
		const sock = FakeSocket.instances[0];
		sock.open();
		vi.advanceTimersByTime(25_000);
		expect(sock.sent).toContainEqual({ type: "ping" });
		vi.advanceTimersByTime(50_000);
		expect(sock.readyState).toBe(FakeSocket.CLOSED);
		expect(client.getStatus().state).toBe("reconnecting");
		client.stop();
	});
});
