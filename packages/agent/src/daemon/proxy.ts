import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { ProxyStreamMeta } from "@pi-web/shared";
import type { LinkPeer, LinkStream } from "@pi-web/shared/link";
import { errorMessage } from "./errors.js";
import type { AgentLogger } from "./logger.js";

const MAX_HEAD_BYTES = 64 * 1024;
const HEAD_TIMEOUT_MS = 30_000;
const HEAD_END = Buffer.from("\r\n\r\n");

export interface ProxyListenerOptions {
	/** Host peer used for tunnel streams (the most recently connected one). */
	getPeer: () => LinkPeer | undefined;
	log?: Pick<AgentLogger, "debug" | "info" | "warn" | "error">;
	/** Timeout for the host to accept a stream. Default 30s. */
	openTimeoutMs?: number;
	/** Older tokens still accepted (e.g. those of pi processes started before a token change). */
	extraTokens?: () => Iterable<string>;
}

interface ParsedHead {
	method: string;
	target: string;
	version: string;
	/** Header lines in original order. */
	headers: Array<[string, string]>;
}

function parseHead(head: string): ParsedHead | null {
	const lines = head.split("\r\n");
	const requestLine = lines.shift() ?? "";
	const match = /^([A-Za-z]+) (\S+) (HTTP\/\d(?:\.\d)?)$/.exec(requestLine);
	if (!match) return null;
	const headers: Array<[string, string]> = [];
	for (const line of lines) {
		if (!line) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) return null;
		headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
	}
	return { method: match[1].toUpperCase(), target: match[2], version: match[3], headers };
}

function header(head: ParsedHead, name: string): string | undefined {
	const lower = name.toLowerCase();
	return head.headers.find(([k]) => k.toLowerCase() === lower)?.[1];
}

/** Parses "host:port" / "[v6]:port" authority. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
	const m = /^\[([^\]]+)\]:(\d+)$/.exec(authority) ?? /^([^:\s]+):(\d+)$/.exec(authority);
	if (!m) return null;
	const port = Number(m[2]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { host: m[1], port };
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

function simpleResponse(status: number, reason: string, body = "", extraHeaders: string[] = []): string {
	const payload = Buffer.from(body, "utf8");
	return [
		`HTTP/1.1 ${status} ${reason}`,
		...extraHeaders,
		"Content-Type: text/plain; charset=utf-8",
		`Content-Length: ${payload.length}`,
		"Connection: close",
		"",
		body,
	].join("\r\n");
}

/**
 * Local HTTP proxy entry point (127.0.0.1:port) for pi processes. Authenticated
 * requests are forwarded as Link streams to the host's TunnelProxy: CONNECT tunnels
 * and absolute-URI HTTP requests (rewritten to origin-form).
 */
export class ProxyListener {
	private server: Server | null = null;
	private token = "";
	private currentPort = 0;
	private readonly sockets = new Set<Socket>();

	constructor(private readonly options: ProxyListenerOptions) {}

	get listening(): boolean {
		return this.server !== null;
	}

	get port(): number {
		return this.currentPort;
	}

	get activeConnections(): number {
		return this.sockets.size;
	}

	/** (Re)starts the listener. Changing only the token does not restart it. */
	async start(port: number, token: string): Promise<void> {
		this.token = token;
		if (this.server && this.currentPort === port) return;
		await this.stop();
		const server = createServer({ allowHalfOpen: true }, (socket) => this.onConnection(socket));
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			server.once("error", onError);
			server.listen(port, "127.0.0.1", () => {
				server.off("error", onError);
				resolve();
			});
		});
		server.on("error", (err) => this.options.log?.error("proxy listener error", { error: err.message }));
		this.server = server;
		this.currentPort = (server.address() as { port: number }).port;
		this.options.log?.info("proxy listening", { port: this.currentPort });
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		this.currentPort = 0;
		if (!server) return;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private onConnection(socket: Socket): void {
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("error", () => {});
		socket.setTimeout(HEAD_TIMEOUT_MS, () => socket.destroy());
		let buffer: Buffer = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf(HEAD_END);
			if (end < 0) {
				if (buffer.length > MAX_HEAD_BYTES) {
					socket.off("data", onData);
					this.reply(socket, 431, "Request Header Fields Too Large", "请求头过大");
				}
				return;
			}
			socket.off("data", onData);
			socket.pause();
			const head = buffer.subarray(0, end).toString("latin1");
			const rest = Buffer.from(buffer.subarray(end + HEAD_END.length));
			void this.handle(socket, head, rest).catch((err) => {
				this.options.log?.warn("proxy request failed", { error: errorMessage(err) });
				socket.destroy();
			});
		};
		socket.on("data", onData);
		socket.on("end", () => {
			if (buffer.indexOf(HEAD_END) < 0) socket.destroy();
		});
	}

	private reply(socket: Socket, status: number, reason: string, body: string, extraHeaders: string[] = []): void {
		if (socket.destroyed) return;
		socket.end(simpleResponse(status, reason, body, extraHeaders));
		socket.once("finish", () => socket.destroy());
	}

	private authorized(head: ParsedHead): boolean {
		const value = header(head, "proxy-authorization");
		if (!value || !this.token) return false;
		const m = /^Basic\s+(\S+)$/i.exec(value);
		if (!m) return false;
		const presented = digest(Buffer.from(m[1], "base64").toString("utf8"));
		const tokens = new Set([this.token, ...(this.options.extraTokens?.() ?? [])]);
		let ok = false;
		for (const token of tokens) {
			if (token && timingSafeEqual(presented, digest(`pw:${token}`))) ok = true;
		}
		return ok;
	}

	private async handle(socket: Socket, rawHead: string, rest: Buffer): Promise<void> {
		const head = parseHead(rawHead);
		if (!head) {
			this.reply(socket, 400, "Bad Request", "无法解析的代理请求");
			return;
		}
		if (!this.authorized(head)) {
			this.reply(socket, 407, "Proxy Authentication Required", "代理认证失败", ['Proxy-Authenticate: Basic realm="pi-web"']);
			return;
		}
		if (head.method === "CONNECT") {
			const target = parseAuthority(head.target);
			if (!target) {
				this.reply(socket, 400, "Bad Request", `无效的目标：${head.target}`);
				return;
			}
			const stream = await this.open(socket, { kind: "proxy", host: target.host, port: target.port, protocol: "connect" });
			if (!stream) return;
			if (!socket.destroyed) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			this.splice(socket, stream, rest);
			return;
		}
		let url: URL;
		try {
			url = new URL(head.target);
		} catch {
			this.reply(socket, 400, "Bad Request", "仅支持 CONNECT 或绝对 URI 的 HTTP 代理请求");
			return;
		}
		if (url.protocol !== "http:") {
			this.reply(socket, 400, "Bad Request", `不支持的协议：${url.protocol}`);
			return;
		}
		const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
		const port = url.port ? Number(url.port) : 80;
		const stream = await this.open(socket, { kind: "proxy", host, port, protocol: "http" });
		if (!stream) return;
		const drop = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive"]);
		const lines = [`${head.method} ${url.pathname}${url.search} ${head.version}`];
		let hasHost = false;
		for (const [name, value] of head.headers) {
			const lower = name.toLowerCase();
			if (drop.has(lower)) continue;
			if (lower === "host") hasHost = true;
			lines.push(`${name}: ${value}`);
		}
		if (!hasHost) lines.splice(1, 0, `Host: ${url.host}`);
		lines.push("Connection: close", "", "");
		stream.write(Buffer.from(lines.join("\r\n"), "latin1"));
		this.splice(socket, stream, rest);
	}

	private async open(socket: Socket, meta: ProxyStreamMeta): Promise<LinkStream | null> {
		const peer = this.options.getPeer();
		if (!peer || peer.closed) {
			this.reply(socket, 502, "Bad Gateway", "Pi-Web host not connected");
			return null;
		}
		try {
			return await peer.openStream(meta, { timeoutMs: this.options.openTimeoutMs ?? 30_000 });
		} catch (err) {
			const status = (err as { data?: { status?: unknown } }).data?.status;
			const message = errorMessage(err);
			this.options.log?.debug("proxy stream rejected", { host: meta.host, port: meta.port, status, error: message });
			if (status === 403) this.reply(socket, 403, "Forbidden", message);
			else this.reply(socket, 502, "Bad Gateway", message);
			return null;
		}
	}

	private splice(socket: Socket, stream: LinkStream, rest: Buffer): void {
		if (socket.destroyed) {
			// The client went away while the host was dialing.
			stream.destroy();
			return;
		}
		socket.setTimeout(0);
		const destroyBoth = () => {
			socket.destroy();
			stream.destroy();
		};
		stream.on("error", destroyBoth);
		socket.on("error", destroyBoth);
		socket.on("close", () => {
			if (!stream.destroyed) stream.destroy();
		});
		stream.on("close", () => {
			if (!socket.destroyed) socket.end();
		});
		if (rest.length > 0) stream.write(rest);
		socket.pipe(stream);
		stream.pipe(socket);
		socket.resume();
	}
}
