import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostProxyDispatcher, createProxyAgent, installHostHttpDispatcher } from "../../src/core/http.js";

const cleanups: Array<() => unknown> = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["NO_PROXY", "no_proxy"];

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	delete process.env.no_proxy;
	process.env.NO_PROXY = "";
});

afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

function listen(server: Server | HttpServer): Promise<number> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function targetServer(): Promise<number> {
	const server = createHttpServer((_req, res) => res.end("hello"));
	cleanups.push(() => new Promise((r) => server.close(r)));
	cleanups.push(() => server.closeAllConnections());
	return listen(server);
}

/** HTTP CONNECT proxy that records each tunnel request and forwards it. */
async function connectProxy(): Promise<{ url: string; requests: string[] }> {
	const requests: string[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((client) => {
		sockets.add(client);
		client.once("data", (chunk: Buffer) => {
			const head = chunk.toString("latin1");
			requests.push(head.split("\r\n")[0] ?? "");
			const match = /^CONNECT (\S+):(\d+) /.exec(head);
			if (!match) {
				client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
				return;
			}
			const upstream = connect(Number(match[2]), match[1] as string, () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				upstream.pipe(client);
				client.pipe(upstream);
			});
			sockets.add(upstream);
			upstream.on("error", () => client.destroy());
			client.on("error", () => upstream.destroy());
		});
	});
	const port = await listen(server);
	cleanups.push(() => {
		for (const socket of sockets) socket.destroy();
		return new Promise((r) => server.close(r));
	});
	return { url: `http://127.0.0.1:${port}`, requests };
}

describe("HostProxyDispatcher", () => {
	it("routes requests through settings.upstreamProxy", async () => {
		const target = await targetServer();
		const proxy = await connectProxy();
		const dispatcher = new HostProxyDispatcher(() => proxy.url);
		cleanups.push(() => dispatcher.close());
		const response = await fetch(`http://127.0.0.1:${target}/x`, { dispatcher });
		expect(await response.text()).toBe("hello");
		expect(proxy.requests).toEqual([`CONNECT 127.0.0.1:${target} HTTP/1.1`]);
	});

	it("honours NO_PROXY even with an explicit upstream proxy", async () => {
		const target = await targetServer();
		const proxy = await connectProxy();
		process.env.NO_PROXY = "example.invalid,127.0.0.1";
		const dispatcher = new HostProxyDispatcher(() => proxy.url);
		cleanups.push(() => dispatcher.close());
		const response = await fetch(`http://127.0.0.1:${target}/`, { dispatcher });
		expect(await response.text()).toBe("hello");
		expect(proxy.requests).toEqual([]);
	});

	it("reuses one agent per setting and replaces it when the setting changes", async () => {
		const target = await targetServer();
		const first = await connectProxy();
		const second = await connectProxy();
		let setting: string | undefined = first.url;
		const created: string[] = [];
		const dispatcher = new HostProxyDispatcher(
			() => setting,
			(value) => {
				created.push(value);
				return createProxyAgent(value);
			},
		);
		cleanups.push(() => dispatcher.close());
		const a = dispatcher.agent();
		expect(dispatcher.agent()).toBe(a);
		expect(await (await fetch(`http://127.0.0.1:${target}/`, { dispatcher })).text()).toBe("hello");
		setting = ` ${second.url} `;
		expect(await (await fetch(`http://127.0.0.1:${target}/`, { dispatcher })).text()).toBe("hello");
		expect(dispatcher.agent()).not.toBe(a);
		expect(created).toEqual([first.url, second.url]);
		expect(first.requests).toHaveLength(1);
		expect(second.requests).toHaveLength(1);
	});

	// Last: installs process-wide globals (this test file runs in its own worker).
	it("makes global fetch (pi-ai's OAuth refresh) follow the setting", async () => {
		const target = await targetServer();
		const proxy = await connectProxy();
		let setting: string | undefined = proxy.url;
		const dispatcher = installHostHttpDispatcher(() => setting);
		expect(installHostHttpDispatcher(() => undefined)).toBe(dispatcher);
		const response = await globalThis.fetch(`http://127.0.0.1:${target}/oauth/token`, { method: "POST", body: "{}" });
		expect(await response.text()).toBe("hello");
		expect(proxy.requests).toEqual([`CONNECT 127.0.0.1:${target} HTTP/1.1`]);
		setting = undefined;
		process.env.NO_PROXY = "127.0.0.1";
		expect(await (await globalThis.fetch(`http://127.0.0.1:${target}/`)).text()).toBe("hello");
		expect(proxy.requests).toHaveLength(1);
		await dispatcher.close();
	});
});
