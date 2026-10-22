/** Outbound TCP for the tunnel: direct, or through the host's upstream HTTP(S) proxy via CONNECT. */
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { matchesNoProxy, parseNoProxy } from "./no-proxy.js";

export interface UpstreamProxy {
	url: URL;
}

export interface UpstreamSelection {
	/** settings.upstreamProxy (takes precedence over the environment). */
	configured?: string;
	env: NodeJS.ProcessEnv;
}

const MAX_RESPONSE_HEAD = 16 * 1024;

export function formatAuthority(host: string, port: number): string {
	return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function parseProxyUrl(value: string | undefined): URL | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	try {
		const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
		return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

/** The upstream proxy to use for `host:port`, or undefined for a direct connection. */
export function selectUpstreamProxy(host: string, port: number, selection: UpstreamSelection): URL | undefined {
	const env = selection.env;
	const url = parseProxyUrl(selection.configured) ?? parseProxyUrl(env.HTTPS_PROXY ?? env.https_proxy);
	if (!url) return undefined;
	const noProxy = parseNoProxy(env.NO_PROXY ?? env.no_proxy);
	return matchesNoProxy(host, port, noProxy) ? undefined : url;
}

/** Proxy URL without credentials, for logs and error messages. */
export function redactProxyUrl(url: URL): string {
	return `${url.protocol}//${url.host}`;
}

function waitConnected(socket: Socket, secure: boolean, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const event = secure ? "secureConnect" : "connect";
		const timer = setTimeout(() => {
			cleanup();
			socket.destroy();
			reject(new Error(`连接超时（${Math.round(timeoutMs / 1000)}s）`));
		}, timeoutMs);
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		const onConnect = () => {
			cleanup();
			resolve();
		};
		const cleanup = () => {
			clearTimeout(timer);
			socket.off("error", onError);
			socket.off(event, onConnect);
		};
		socket.once("error", onError);
		socket.once(event, onConnect);
	});
}

function readConnectResponse(socket: Socket, timeoutMs: number): Promise<{ status: number; statusText: string; rest: Buffer }> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => fail(new Error("上游代理响应超时")), timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			socket.off("data", onData);
			socket.off("error", fail);
			socket.off("close", onClose);
		};
		function fail(err: Error) {
			cleanup();
			socket.destroy();
			reject(err);
		}
		function onClose() {
			fail(new Error("上游代理关闭了连接"));
		}
		function onData(chunk: Buffer) {
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) {
				if (buffer.length > MAX_RESPONSE_HEAD) fail(new Error("上游代理响应头过大"));
				return;
			}
			cleanup();
			socket.pause();
			const head = buffer.subarray(0, end).toString("latin1");
			const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/m.exec(head.split("\r\n")[0] ?? "");
			if (!match) {
				socket.destroy();
				reject(new Error("上游代理响应格式错误"));
				return;
			}
			resolve({ status: Number(match[1]), statusText: match[2] ?? "", rest: buffer.subarray(end + 4) });
		}
		socket.on("data", onData);
		socket.once("error", fail);
		socket.once("close", onClose);
	});
}

/** Opens a TCP connection to host:port, through `proxy` (HTTP CONNECT) when given. */
export async function dialUpstream(host: string, port: number, proxy: URL | undefined, timeoutMs = 15_000): Promise<Socket> {
	if (!proxy) {
		const socket = netConnect({ host, port, allowHalfOpen: true });
		await waitConnected(socket, false, timeoutMs);
		return socket;
	}
	const secure = proxy.protocol === "https:";
	const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
	const proxyPort = Number(proxy.port) || (secure ? 443 : 80);
	const socket: Socket = secure
		? tlsConnect({ host: proxyHost, port: proxyPort, servername: isIP(proxyHost) ? undefined : proxyHost })
		: netConnect({ host: proxyHost, port: proxyPort, allowHalfOpen: true });
	try {
		await waitConnected(socket, secure, timeoutMs);
	} catch (err) {
		throw new Error(`无法连接上游代理 ${redactProxyUrl(proxy)}：${(err as Error).message}`);
	}
	const authority = formatAuthority(host, port);
	const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
	if (proxy.username || proxy.password) {
		const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
		lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}`);
	}
	socket.write(`${lines.join("\r\n")}\r\n\r\n`);
	const response = await readConnectResponse(socket, timeoutMs);
	if (response.status !== 200) {
		socket.destroy();
		throw new Error(`上游代理拒绝连接 ${authority}：${response.status} ${response.statusText}`.trim());
	}
	if (response.rest.length > 0) socket.unshift(response.rest);
	return socket;
}
