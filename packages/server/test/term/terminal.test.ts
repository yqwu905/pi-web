import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { buildTerminalCommand, handleTerminalSocket, remoteShellPath } from "../../src/term/index.js";
import { createEventHub } from "../../src/ws.js";
import { createFakeContext, flush, makeServer, until } from "../api/fakes.js";
import type { FakeContext } from "../api/fakes.js";

/** Stand-in for a ws WebSocket on the server side. */
class FakeSocket extends EventEmitter {
	readyState = 1;
	bufferedAmount = 0;
	readonly sent: Array<{ data: Buffer | string; binary: boolean }> = [];
	closeCode?: number;
	private pendingCallbacks: Array<() => void> = [];
	holdCallbacks = false;

	send(data: Buffer | string, options?: { binary?: boolean } | (() => void), cb?: () => void): void {
		const callback = typeof options === "function" ? options : cb;
		const binary = typeof options === "object" && options?.binary === true;
		this.sent.push({ data, binary });
		if (callback) {
			if (this.holdCallbacks) this.pendingCallbacks.push(callback);
			else callback();
		}
	}
	releaseCallbacks(): void {
		const callbacks = this.pendingCallbacks;
		this.pendingCallbacks = [];
		for (const cb of callbacks) cb();
	}
	close(code?: number): void {
		if (this.readyState !== 1) return;
		this.readyState = 3;
		this.closeCode = code;
		this.emit("close", code);
	}
	terminate(): void {
		this.close(1006);
	}
	controls(): unknown[] {
		return this.sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)));
	}
	binaries(): string {
		return Buffer.concat(this.sent.filter((s) => s.binary).map((s) => s.data as Buffer)).toString();
	}
	/** Message from the browser. */
	input(data: string | Buffer, binary: boolean): void {
		this.emit("message", Buffer.isBuffer(data) ? data : Buffer.from(data), binary);
	}
}

async function setup(): Promise<{ fake: FakeContext; socket: FakeSocket }> {
	const fake = createFakeContext();
	await fake.store.saveServer(makeServer());
	return { fake, socket: new FakeSocket() };
}

describe("terminal command", () => {
	it("cds into the workspace, puts the remote bin dir on PATH and starts a login shell", () => {
		expect(buildTerminalCommand("/home/dev/my project", "/home/dev/.pi-web")).toBe(
			`cd '/home/dev/my project' 2>/dev/null; export PATH=/home/dev/.pi-web/bin:"$PATH"; exec "\${SHELL:-/bin/sh}" -l`,
		);
	});

	it("keeps ~ expandable while quoting the rest", () => {
		expect(remoteShellPath("~")).toBe(`"$HOME"`);
		expect(remoteShellPath("~/a b")).toBe(`"$HOME"/'a b'`);
		expect(remoteShellPath("/x/it's")).toBe(`'/x/it'\\''s'`);
		expect(buildTerminalCommand("~", "~/.pi-web")).toContain(`export PATH="$HOME"/.pi-web/bin:"$PATH"`);
	});
});

describe("handleTerminalSocket", () => {
	it("opens a pty with the requested size and bridges bytes both ways", async () => {
		const { fake, socket } = await setup();
		await handleTerminalSocket(fake.ctx, socket as never, { serverId: "srv1", cwd: "/home/dev/project", cols: "120", rows: "40" });
		const conn = fake.connections.get("srv1");
		expect(conn.ensureSshCalls).toBe(1);
		expect(conn.ptyRequests).toEqual([
			{
				command: buildTerminalCommand("/home/dev/project", "/home/dev/.pi-web"),
				cols: 120,
				rows: 40,
				term: "xterm-256color",
			},
		]);
		expect(socket.controls()).toEqual([{ type: "ready" }]);

		const channel = conn.ptyChannel!;
		channel.emit("data", Buffer.from("hello "));
		channel.stderr.emit("data", Buffer.from("err"));
		expect(socket.binaries()).toBe("hello err");

		socket.input("ls\r", true);
		expect(Buffer.concat(channel.written).toString()).toBe("ls\r");
	});

	it("resizes on control frames and treats non-JSON text as input", async () => {
		const { fake, socket } = await setup();
		await handleTerminalSocket(fake.ctx, socket as never, { serverId: "srv1" });
		const channel = fake.connections.get("srv1").ptyChannel!;
		socket.input(JSON.stringify({ type: "resize", cols: 100, rows: 30 }), false);
		socket.input(JSON.stringify({ type: "resize", cols: -5, rows: 99999 }), false);
		socket.input("echo hi\n", false);
		expect(channel.windows).toEqual([
			[30, 100, 0, 0],
			[1000, 1, 0, 0],
		]);
		expect(Buffer.concat(channel.written).toString()).toBe("echo hi\n");
		// Defaults when cwd/size are missing.
		expect(fake.connections.get("srv1").ptyRequests[0]).toMatchObject({ cols: 80, rows: 24 });
		expect(fake.connections.get("srv1").ptyRequests[0].command).toContain(`cd "$HOME" 2>/dev/null`);
	});

	it("queues input and resizes received before the pty is ready", async () => {
		const { fake, socket } = await setup();
		const pending = handleTerminalSocket(fake.ctx, socket as never, { serverId: "srv1" });
		socket.input("early", true);
		socket.input(JSON.stringify({ type: "resize", cols: 90, rows: 20 }), false);
		await pending;
		const channel = fake.connections.get("srv1").ptyChannel!;
		expect(Buffer.concat(channel.written).toString()).toBe("early");
		expect(channel.windows).toEqual([[20, 90, 0, 0]]);
	});

	it("sends an exit frame and closes the socket when the shell exits", async () => {
		const { fake, socket } = await setup();
		await handleTerminalSocket(fake.ctx, socket as never, { serverId: "srv1" });
		fake.connections.get("srv1").ptyChannel!.exit(3);
		expect(socket.controls().at(-1)).toEqual({ type: "exit", code: 3 });
		expect(socket.closeCode).toBe(1000);
	});

	it("closes the channel when the browser goes away", async () => {
		const { fake, socket } = await setup();
		await handleTerminalSocket(fake.ctx, socket as never, { serverId: "srv1" });
		const channel = fake.connections.get("srv1").ptyChannel!;
		socket.close(1001);
		expect(channel.closed).toBe(true);
	});

	it("reports errors with a control frame", async () => {
		const { fake, socket } = await setup();
		await handleTerminalSocket(fake.ctx, socket as never, { serverId: "missing" });
		expect(socket.controls()).toEqual([{ type: "error", message: "服务器不存在" }]);
		expect(socket.closeCode).toBe(1008);

		const other = new FakeSocket();
		fake.connections.get("srv1").ptyError = new Error("channel refused");
		await handleTerminalSocket(fake.ctx, other as never, { serverId: "srv1" });
		expect(other.controls()).toEqual([{ type: "error", message: "无法打开终端：channel refused" }]);
		expect(other.closeCode).toBe(1011);
	});

	it("pauses the channel while the socket is congested", async () => {
		const { fake, socket } = await setup();
		await handleTerminalSocket(fake.ctx, socket as never, { serverId: "srv1" }, { highWaterMark: 10, lowWaterMark: 5 });
		const channel = fake.connections.get("srv1").ptyChannel!;
		socket.holdCallbacks = true;
		socket.bufferedAmount = 50;
		channel.emit("data", Buffer.from("x".repeat(50)));
		expect(channel.paused).toBe(true);
		socket.bufferedAmount = 0;
		socket.releaseCallbacks();
		expect(channel.paused).toBe(false);
	});
});

describe("/ws/term route", () => {
	let app: FastifyInstance | undefined;
	afterEach(async () => {
		await app?.close();
		app = undefined;
	});

	it("serves a real WebSocket end to end", async () => {
		const fake = createFakeContext();
		await fake.store.saveServer(makeServer());
		app = await buildApp(fake.ctx, { hub: createEventHub({ version: "t" }) });
		await app.listen({ host: "127.0.0.1", port: 0 });
		const port = (app.server.address() as { port: number }).port;

		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term?serverId=srv1&cwd=/tmp&cols=50&rows=10`);
		const texts: unknown[] = [];
		const binaries: Buffer[] = [];
		ws.on("message", (data, isBinary) => {
			if (isBinary) binaries.push(data as Buffer);
			else texts.push(JSON.parse(String(data)));
		});
		await until(() => texts.length > 0);
		expect(texts[0]).toEqual({ type: "ready" });
		const conn = fake.connections.get("srv1");
		expect(conn.ptyRequests[0]).toMatchObject({ cols: 50, rows: 10 });

		conn.ptyChannel!.emit("data", Buffer.from("prompt$ "));
		await until(() => binaries.length > 0);
		expect(Buffer.concat(binaries).toString()).toBe("prompt$ ");

		ws.send(Buffer.from("pwd\n"));
		ws.send(JSON.stringify({ type: "resize", cols: 60, rows: 12 }));
		await until(() => conn.ptyChannel!.windows.length > 0);
		expect(Buffer.concat(conn.ptyChannel!.written).toString()).toBe("pwd\n");
		expect(conn.ptyChannel!.windows).toEqual([[12, 60, 0, 0]]);

		const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
		conn.ptyChannel!.exit(0);
		expect(await closed).toBe(1000);
		expect(texts.at(-1)).toEqual({ type: "exit", code: 0 });
		await flush();
	});
});
