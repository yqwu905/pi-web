import { randomBytes } from "node:crypto";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, FrameType, LINK_PREAMBLE, LinkPeer, LinkRequestError, type LinkStream } from "./link.js";

/** Two connected in-memory duplexes, like a socketpair. */
function socketPair(): [Duplex, Duplex] {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	const a = Duplex.from({ readable: bToA, writable: aToB });
	const b = Duplex.from({ readable: aToB, writable: bToA });
	return [a, b];
}

function pair(options?: { preamble?: boolean }) {
	const [a, b] = socketPair();
	const host = new LinkPeer(a, { side: "host", preamble: options?.preamble ? LINK_PREAMBLE : undefined });
	const agent = new LinkPeer(b, { side: "agent" });
	return { host, agent, a, b };
}

function readAll(stream: LinkStream): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on("data", (c: Buffer) => chunks.push(c));
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}

describe("FrameDecoder", () => {
	it("decodes frames split at arbitrary boundaries", () => {
		const bytes = Buffer.concat([
			encodeFrame(FrameType.Msg, 0, "hello"),
			encodeFrame(FrameType.Data, 3, Buffer.from([1, 2, 3])),
		]);
		const decoder = new FrameDecoder();
		const frames = [];
		for (const byte of bytes) frames.push(...decoder.push(Buffer.from([byte])));
		expect(frames).toHaveLength(2);
		expect(frames[0].payload.toString()).toBe("hello");
		expect(frames[1].stream).toBe(3);
		expect([...frames[1].payload]).toEqual([1, 2, 3]);
	});
});

describe("LinkPeer", () => {
	it("round-trips requests, errors and events", async () => {
		const { host, agent } = pair();
		agent.handle("echo", (params) => ({ got: params }));
		agent.handle("fail", () => {
			const err = new Error("nope") as Error & { code: string };
			err.code = "E_NOPE";
			throw err;
		});
		expect(await host.request("echo", { x: 1 })).toEqual({ got: { x: 1 } });
		await expect(host.request("fail")).rejects.toMatchObject({ code: "E_NOPE", message: "nope" });
		await expect(host.request("missing")).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
		const got = new Promise((resolve) => host.on("event", (name, data) => resolve([name, data])));
		agent.emitEvent("conv.event", { seq: 1 });
		expect(await got).toEqual(["conv.event", { seq: 1 }]);
	});

	it("splits and reassembles messages larger than one frame", async () => {
		const { host, agent } = pair();
		const big = "x".repeat(3 * 1024 * 1024 + 17);
		agent.handle("big", (p: { s: string }) => ({ len: p.s.length, back: p.s }));
		const res = await host.request<{ len: number; back: string }>("big", { s: big });
		expect(res.len).toBe(big.length);
		expect(res.back).toBe(big);
	});

	it("skips shell noise before the preamble", async () => {
		const [a, b] = socketPair();
		const host = new LinkPeer(a, { side: "host", preamble: LINK_PREAMBLE });
		b.write("Welcome to server!\nlast login: yesterday\n");
		b.write(LINK_PREAMBLE.slice(0, 4));
		b.write(LINK_PREAMBLE.slice(4));
		const agent = new LinkPeer(b, { side: "agent" });
		agent.handle("ping2", () => "pong");
		await host.ready;
		expect(host.preambleJunk).toContain("Welcome to server!");
		expect(await host.request("ping2")).toBe("pong");
	});

	it("times out requests", async () => {
		const { host, agent } = pair();
		agent.handle("slow", () => new Promise(() => {}));
		await expect(host.request("slow", undefined, { timeoutMs: 50 })).rejects.toBeInstanceOf(LinkRequestError);
	});

	it("streams bytes in both directions with flow control and half-close", async () => {
		const { host, agent } = pair();
		agent.onStreamOpen((meta, control) => {
			expect(meta).toEqual({ kind: "echo" });
			const s = control.accept();
			// echo everything back, then end
			s.pipe(s);
		});
		const stream = await host.openStream({ kind: "echo" });
		const payload = randomBytes(5 * 1024 * 1024 + 123);
		const received = readAll(stream);
		stream.end(payload);
		const back = await received;
		expect(back.length).toBe(payload.length);
		expect(back.equals(payload)).toBe(true);
	});

	it("handles a slow reader without losing data", async () => {
		const { host, agent } = pair();
		let accepted: LinkStream | undefined;
		agent.onStreamOpen((_meta, control) => {
			accepted = control.accept();
			accepted.pause();
		});
		const stream = await host.openStream({ kind: "sink" });
		const payload = randomBytes(2 * 1024 * 1024);
		stream.end(payload);
		await new Promise((r) => setTimeout(r, 50));
		const s = accepted!;
		const received = readAll(s);
		s.resume();
		expect((await received).equals(payload)).toBe(true);
	});

	it("rejects streams and propagates resets", async () => {
		const { host, agent } = pair();
		agent.onStreamOpen((meta: { allow: boolean }, control) => {
			if (!meta.allow) {
				control.reject("denied", 403);
				return;
			}
			const s = control.accept();
			s.on("error", () => {});
			s.destroy(new Error("boom"));
		});
		await expect(host.openStream({ allow: false })).rejects.toMatchObject({ code: "STREAM_REJECTED", data: { status: 403 } });
		const s = await host.openStream({ allow: true });
		const err = await new Promise<Error>((resolve) => s.on("error", resolve));
		expect(err.message).toBe("boom");
	});

	it("rejects pending work when the transport closes", async () => {
		const { host, agent, b } = pair();
		agent.handle("hang", () => new Promise(() => {}));
		const pending = host.request("hang", undefined, { timeoutMs: 0 });
		b.destroy();
		await expect(pending).rejects.toMatchObject({ code: "LINK_CLOSED" });
		expect(host.closed).toBe(true);
	});

	it("drops a peer that stopped reading once its write buffer exceeds the cap", () => {
		// A writable that never drains: like a socket to a dead SSH session.
		const stuck = new Duplex({ read() {}, write(_chunk, _enc, _cb) {}, highWaterMark: 1024 });
		const peer = new LinkPeer(stuck, { side: "agent", maxBufferedBytes: 64 * 1024 });
		const closed = new Promise<Error | undefined>((resolve) => peer.once("close", resolve));
		const event = { output: "x".repeat(10 * 1024) };
		let sent = 0;
		while (peer.emitEvent("conv.event", event) && sent < 1000) sent++;
		expect(peer.closed).toBe(true);
		expect(sent).toBeLessThan(10);
		return expect(closed).resolves.toMatchObject({ message: expect.stringContaining("write buffer overflow") });
	});

	it("drops a peer that sent nothing within the idle timeout and tracks liveness", async () => {
		const [a, b] = socketPair();
		const host = new LinkPeer(a, { side: "host" });
		const agent = new LinkPeer(b, { side: "agent", idleTimeoutMs: 150 });
		const before = agent.lastReceivedAt;
		await new Promise((r) => setTimeout(r, 60));
		await host.request("link.ping");
		expect(agent.lastReceivedAt).toBeGreaterThan(before);
		expect(agent.closed).toBe(false);
		const closed = new Promise<Error | undefined>((resolve) => agent.once("close", resolve));
		await expect(closed).resolves.toMatchObject({ message: expect.stringContaining("idle") });
		host.destroy();
	});
});
