import { once } from "node:events";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProxyStreamMeta } from "@pi-web/shared";
import { LinkPeer } from "@pi-web/shared/link";
import { parseAuthority, ProxyListener } from "../src/daemon/proxy.js";
import { socketPair } from "./helpers.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const AUTH = `Proxy-Authorization: Basic ${Buffer.from(`pw:${TOKEN}`).toString("base64")}`;

let echo: Server;
let http: HttpServer;
let lastHttpRequest: { url?: string; headers: Record<string, unknown> } | null;
let listener: ProxyListener;
let host: LinkPeer | undefined;
let agentPeer: LinkPeer | undefined;
const opened: ProxyStreamMeta[] = [];

function port(server: Server | HttpServer): number {
	return (server.address() as { port: number }).port;
}

/** Host side of the link: connects proxy streams to local TCP targets, rejects "blocked.test". */
function connectHost(): void {
	const [a, b] = socketPair();
	host = new LinkPeer(a, { side: "host" });
	agentPeer = new LinkPeer(b, { side: "agent" });
	host.onStreamOpen((meta: ProxyStreamMeta, control) => {
		opened.push(meta);
		if (meta.host === "blocked.test") {
			control.reject("目标不在白名单：blocked.test", 403);
			return;
		}
		if (meta.host === "down.test") {
			control.reject("connect ECONNREFUSED", 502);
			return;
		}
		const upstream = connect(meta.port, "127.0.0.1");
		upstream.once("connect", () => {
			const stream = control.accept();
			stream.pipe(upstream);
			upstream.pipe(stream);
			upstream.on("error", () => stream.destroy());
			stream.on("error", () => upstream.destroy());
		});
		upstream.once("error", (err) => control.reject(err.message, 502));
	});
}

async function rawRequest(text: string | Buffer, opts: { waitEnd?: boolean } = {}): Promise<{ socket: Socket; data: () => string }> {
	const socket = connect(listener.port, "127.0.0.1");
	await once(socket, "connect");
	const received: Buffer[] = [];
	socket.on("data", (c: Buffer) => received.push(c));
	socket.write(text);
	if (opts.waitEnd ?? true) await once(socket, "close");
	return { socket, data: () => Buffer.concat(received).toString("utf8") };
}

beforeEach(async () => {
	opened.length = 0;
	lastHttpRequest = null;
	echo = createServer((s) => s.pipe(s));
	await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
	http = createHttpServer((req, res) => {
		lastHttpRequest = { url: req.url, headers: req.headers };
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => res.end(`echo:${req.method}:${req.url}:${body}`));
	});
	await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
	connectHost();
	listener = new ProxyListener({ getPeer: () => agentPeer });
	await listener.start(0, TOKEN);
});

afterEach(async () => {
	await listener.stop();
	host?.close();
	agentPeer?.close();
	echo.close();
	http.close();
});

describe("parseAuthority", () => {
	it("parses host:port and bracketed IPv6", () => {
		expect(parseAuthority("api.openai.com:443")).toEqual({ host: "api.openai.com", port: 443 });
		expect(parseAuthority("[::1]:8443")).toEqual({ host: "::1", port: 8443 });
		expect(parseAuthority("nohost")).toBeNull();
		expect(parseAuthority("a:70000")).toBeNull();
	});
});

describe("ProxyListener", () => {
	it("requires Proxy-Authorization (407)", async () => {
		const none = await rawRequest("CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: x\r\n\r\n");
		expect(none.data()).toMatch(/^HTTP\/1.1 407 /);
		expect(none.data()).toContain('Proxy-Authenticate: Basic realm="pi-web"');
		const wrong = await rawRequest(
			`CONNECT 127.0.0.1:1 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from("pw:nope").toString("base64")}\r\n\r\n`,
		);
		expect(wrong.data()).toMatch(/^HTTP\/1.1 407 /);
		expect(opened).toHaveLength(0);
	});

	it("tunnels CONNECT through a link stream, including early bytes", async () => {
		const req = await rawRequest(`CONNECT 127.0.0.1:${port(echo)} HTTP/1.1\r\nHost: x\r\n${AUTH}\r\n\r\nearly`, { waitEnd: false });
		await new Promise((r) => setTimeout(r, 100));
		expect(listener.activeConnections).toBe(1);
		req.socket.write("-more");
		await new Promise((r) => setTimeout(r, 100));
		expect(req.data()).toBe("HTTP/1.1 200 Connection Established\r\n\r\nearly-more");
		expect(opened).toEqual([{ kind: "proxy", host: "127.0.0.1", port: port(echo), protocol: "connect" }]);
		req.socket.end();
		await once(req.socket, "close");
		await new Promise((r) => setTimeout(r, 50));
		expect(listener.activeConnections).toBe(0);
	});

	it("forwards absolute-URI HTTP requests in origin-form", async () => {
		const body = "payload";
		const req = await rawRequest(
			`POST http://127.0.0.1:${port(http)}/v1/x?y=1 HTTP/1.1\r\nHost: 127.0.0.1:${port(http)}\r\n${AUTH}\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
		);
		expect(req.data()).toMatch(/^HTTP\/1.1 200 OK/);
		expect(req.data()).toContain(`echo:POST:/v1/x?y=1:${body}`);
		expect(lastHttpRequest?.url).toBe("/v1/x?y=1");
		expect(lastHttpRequest?.headers["proxy-authorization"]).toBeUndefined();
		expect(lastHttpRequest?.headers["proxy-connection"]).toBeUndefined();
		expect(lastHttpRequest?.headers.connection).toBe("close");
		expect(opened.at(-1)).toEqual({ kind: "proxy", host: "127.0.0.1", port: port(http), protocol: "http" });
	});

	it("maps host rejections to 403/502 and reports a missing host", async () => {
		const blocked = await rawRequest(`CONNECT blocked.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
		expect(blocked.data()).toMatch(/^HTTP\/1.1 403 /);
		expect(blocked.data()).toContain("目标不在白名单：blocked.test");
		const down = await rawRequest(`CONNECT down.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
		expect(down.data()).toMatch(/^HTTP\/1.1 502 /);

		agentPeer?.close();
		const noHost = await rawRequest(`CONNECT 127.0.0.1:${port(echo)} HTTP/1.1\r\n${AUTH}\r\n\r\n`);
		expect(noHost.data()).toMatch(/^HTTP\/1.1 502 /);
		expect(noHost.data()).toContain("Pi-Web host not connected");
	});

	it("rejects malformed and non-proxy requests", async () => {
		const origin = await rawRequest(`GET /path HTTP/1.1\r\n${AUTH}\r\n\r\n`);
		expect(origin.data()).toMatch(/^HTTP\/1.1 400 /);
		const garbage = await rawRequest("hello\r\n\r\n");
		expect(garbage.data()).toMatch(/^HTTP\/1.1 400 /);
	});

	it("keeps accepting tokens of running pi processes", async () => {
		await listener.stop();
		let live = ["old-token-of-running-pi"];
		listener = new ProxyListener({ getPeer: () => agentPeer, extraTokens: () => live });
		await listener.start(0, TOKEN);
		const oldAuth = `Proxy-Authorization: Basic ${Buffer.from("pw:old-token-of-running-pi").toString("base64")}`;
		const ok = await rawRequest(`GET http://127.0.0.1:${port(http)}/ok HTTP/1.1\r\n${oldAuth}\r\n\r\n`);
		expect(ok.data()).toMatch(/^HTTP\/1.1 200 /);
		live = [];
		const denied = await rawRequest(`GET http://127.0.0.1:${port(http)}/ok HTTP/1.1\r\n${oldAuth}\r\n\r\n`);
		expect(denied.data()).toMatch(/^HTTP\/1.1 407 /);
	});

	it("updates the token without restarting and restarts on port change", async () => {
		const before = listener.port;
		await listener.start(before, "another-token-123");
		expect(listener.port).toBe(before);
		const old = await rawRequest(`CONNECT 127.0.0.1:${port(echo)} HTTP/1.1\r\n${AUTH}\r\n\r\n`);
		expect(old.data()).toMatch(/^HTTP\/1.1 407 /);
		await listener.stop();
		expect(listener.listening).toBe(false);
		await listener.start(0, TOKEN);
		expect(listener.listening).toBe(true);
	});
});
