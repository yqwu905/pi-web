import { EventEmitter } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "@pi-web/shared";
import { LinkPeer, type LinkStream } from "@pi-web/shared/link";
import { ApiError, type AgentClient, type ConnectionManager, type HostPi, type TunnelProxy } from "../../src/core/types.js";
import { createTunnelProxy, type TunnelProxyOptions } from "../../src/proxy/tunnel-proxy.js";
import { FakeConnections, FakeHub, MemoryStore, makeServer, noopLogger, waitFor } from "../sync/fakes.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

function listen(server: Server): Promise<number> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function echoServer(): Promise<number> {
	const server = createServer((socket) => socket.pipe(socket));
	cleanups.push(() => new Promise((r) => server.close(r)));
	return listen(server);
}

/** Minimal HTTP CONNECT proxy that forwards every tunnel to `targetPort` on 127.0.0.1. */
async function fakeUpstreamProxy(targetPort: number, reply = "HTTP/1.1 200 Connection Established") {
	const requests: string[] = [];
	const sockets = new Set<Socket>();
	const server = createServer({ allowHalfOpen: true }, (client) => {
		sockets.add(client);
		let buffer = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			client.off("data", onData);
			requests.push(buffer.subarray(0, end).toString());
			const rest = buffer.subarray(end + 4);
			if (!reply.includes(" 200 ")) {
				client.end(`${reply}\r\n\r\n`);
				return;
			}
			const target = connect(targetPort, "127.0.0.1", () => {
				client.write(`${reply}\r\n\r\n`);
				if (rest.length) target.write(rest);
				client.pipe(target);
				target.pipe(client);
			});
			target.on("error", () => client.destroy());
		};
		client.on("data", onData);
		client.on("error", () => {});
	});
	cleanups.push(
		() =>
			new Promise((r) => {
				for (const s of sockets) s.destroy();
				server.close(r);
			}),
	);
	const port = await listen(server);
	return { port, requests };
}

/** A connected host/agent LinkPeer pair over a loopback TCP socket. */
async function linkPair(): Promise<{ host: LinkPeer; agent: LinkPeer }> {
	const server = createServer();
	const port = await listen(server);
	const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
	const clientSocket = connect(port, "127.0.0.1");
	const serverSocket = await accepted;
	server.close();
	const host = new LinkPeer(clientSocket, { side: "host" });
	const agent = new LinkPeer(serverSocket, { side: "agent" });
	cleanups.push(() => {
		host.destroy();
		agent.destroy();
	});
	return { host, agent };
}

function fakeClient(serverId: string, peer: LinkPeer): AgentClient {
	const client = new EventEmitter() as AgentClient & { serverId: string; peer: LinkPeer };
	Object.assign(client, { serverId, peer, hello: {}, call: async () => ({}), close: () => peer.destroy() });
	return client;
}

function fakeHostPi(providers: Array<{ id: string; baseUrl?: string; models?: Array<{ baseUrl: string }> }>, configured: string[] = []): HostPi {
	const runtime = {
		getProviders: () =>
			providers.map((p) => ({ id: p.id, name: p.id, baseUrl: p.baseUrl, getModels: () => p.models ?? [], auth: {} })),
		checkAuth: async (id: string) => (configured.includes(id) ? { type: "api_key" } : undefined),
	} as unknown as ModelRuntime;
	return { agentDir: "/tmp/agent", version: async () => "1.4.0", modelRuntime: async () => runtime, invalidate() {} };
}

/** Resolver for tests (the sandbox has no DNS). */
const DNS: Record<string, string[]> = {
	"localtest.me": ["127.0.0.1"],
	"rebind.example": ["93.184.216.34", "10.0.0.7"],
	"public.example": ["93.184.216.34"],
	"metadata.example": ["169.254.169.254"],
	"bedrock-runtime.us-east-1.amazonaws.com": ["52.94.0.1"],
	"evil-bucket.s3.amazonaws.com": ["52.216.0.1"],
	"ec2-1-2-3-4.compute-1.amazonaws.com": ["1.2.3.4"],
	"own.example": ["192.0.2.10"],
};
async function fakeLookup(host: string): Promise<string[]> {
	const found = DNS[host];
	if (!found) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
	return found;
}

/** A dialer that records targets and connects every direct dial to `echoPort`. */
function recordingDial(echoPort: number) {
	const dialed: Array<{ host: string; port: number; proxy?: string }> = [];
	const dial = async (host: string, port: number, proxy: URL | undefined) => {
		dialed.push({ host, port, proxy: proxy?.host });
		const socket = connect(echoPort, "127.0.0.1");
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return socket;
	};
	return { dial, dialed };
}

interface Env {
	proxy: TunnelProxy;
	agent: LinkPeer;
	store: MemoryStore;
	hub: FakeHub;
	connections: FakeConnections;
	client: AgentClient;
}

async function setup(server: Partial<ServerConfig> = {}, options: TunnelProxyOptions = {}, hostPi = fakeHostPi([])): Promise<Env> {
	const store = new MemoryStore([makeServer(server)]);
	const hub = new FakeHub();
	const connections = new FakeConnections();
	const proxy = createTunnelProxy(
		{ log: noopLogger, store, hub, connections: connections as unknown as ConnectionManager, hostPi },
		{ env: {}, publishIntervalMs: 20, lookup: fakeLookup, ownAddresses: () => new Set(["127.0.0.1", "::1", "192.0.2.10"]), ...options },
	);
	const { host, agent } = await linkPair();
	const client = fakeClient("s1", host);
	proxy.attach("s1", client);
	return { proxy, agent, store, hub, connections, client };
}

function proxyConfig(patch: Partial<ServerConfig["proxy"]>): Partial<ServerConfig> {
	return { proxy: { ...makeServer().proxy, ...patch } };
}

async function roundTrip(stream: LinkStream, payload: string): Promise<string> {
	const chunks: Buffer[] = [];
	stream.on("data", (c: Buffer) => chunks.push(c));
	const ended = new Promise<void>((resolve) => stream.once("end", resolve));
	stream.end(payload);
	await ended;
	return Buffer.concat(chunks).toString();
}

async function openRejected(agent: LinkPeer, host: string, port: number): Promise<{ status?: number; message: string }> {
	try {
		await agent.openStream({ kind: "proxy", host, port, protocol: "connect" });
	} catch (err) {
		const e = err as { message: string; data?: { status?: number } };
		return { status: e.data?.status, message: e.message };
	}
	throw new Error("stream unexpectedly accepted");
}

describe("TunnelProxy", () => {
	it("tunnels allowed destinations and keeps statistics", async () => {
		const echoPort = await echoServer();
		const env = await setup(proxyConfig({ extraDomains: ["127.0.0.1"] }));
		const stream = await env.agent.openStream({ kind: "proxy", host: "127.0.0.1", port: echoPort, protocol: "connect" });
		expect(await roundTrip(stream, "hello tunnel")).toBe("hello tunnel");
		await waitFor(() => env.proxy.stats("s1").active === 0);
		const stats = env.proxy.stats("s1");
		expect(stats.byHost).toEqual([{ host: "127.0.0.1", requests: 1, bytesUp: 12, bytesDown: 12, lastAt: expect.any(Number) }]);
		expect(stats.denied).toEqual([]);
		await waitFor(() => env.hub.topic("proxy:s1").length > 0 && env.connections.lastPatch("s1")?.proxy?.active === 0);
		expect(env.connections.lastPatch("s1")?.proxy?.byHost[0].bytesDown).toBe(12);
	});

	it("allows provider endpoints of the host pi configuration by host and port", async () => {
		const echoPort = await echoServer();
		const hostPi = fakeHostPi([
			{ id: "local", baseUrl: `http://127.0.0.1:${echoPort}/v1` },
			{ id: "ollama", baseUrl: "http://localhost:11434/v1" },
			{ id: "vertex", models: [{ baseUrl: "https://{location}-aiplatform.googleapis.com" }] },
			{ id: "anthropic", baseUrl: "https://api.anthropic.com" },
		]);
		const env = await setup({}, {}, hostPi);
		const domains = await env.proxy.providerDomains();
		expect(domains).toEqual(
			expect.arrayContaining([
				`127.0.0.1:${echoPort}`,
				"localhost:11434",
				"api.anthropic.com:443",
				"*.githubcopilot.com:443",
				"chatgpt.com:443",
				"bedrock-runtime.{aws-region}.amazonaws.com:443",
				"{gcp-region}-aiplatform.googleapis.com:443",
			]),
		);
		// No registrable-domain wildcards that anyone can host servers under.
		expect(domains).not.toContain("*.amazonaws.com:443");
		expect(domains).not.toContain("*.googleapis.com:443");
		expect(domains.some((d) => d.includes("{location}"))).toBe(false);
		const stream = await env.agent.openStream({ kind: "proxy", host: "127.0.0.1", port: echoPort, protocol: "connect" });
		expect(await roundTrip(stream, "x")).toBe("x");
		// A loopback provider is allowed on its own port only.
		expect((await openRejected(env.agent, "localhost", 7878)).status).toBe(403);
		expect((await openRejected(env.agent, "127.0.0.1", echoPort + 1 === 65536 ? 1 : echoPort + 1)).status).toBe(403);
	});

	it("matches dynamic provider endpoints by service, not by registrable domain", async () => {
		const echoPort = await echoServer();
		const { dial, dialed } = recordingDial(echoPort);
		const env = await setup({}, { dial }, fakeHostPi([]));
		const ok = await env.agent.openStream({ kind: "proxy", host: "bedrock-runtime.us-east-1.amazonaws.com", port: 443, protocol: "connect" });
		expect(await roundTrip(ok, "bedrock")).toBe("bedrock");
		// The vetted address is dialled, not the name (no second DNS answer).
		expect(dialed).toEqual([{ host: "52.94.0.1", port: 443, proxy: undefined }]);
		for (const host of ["evil-bucket.s3.amazonaws.com", "ec2-1-2-3-4.compute-1.amazonaws.com", "bedrock-runtime.s3.amazonaws.com", "storage.googleapis.com"]) {
			expect((await openRejected(env.agent, host, 443)).status, host).toBe(403);
		}
		expect((await openRejected(env.agent, "bedrock-runtime.us-east-1.amazonaws.com", 8443)).status).toBe(403);
	});

	it("rejects destinations outside the allowlist with 403 and counts them", async () => {
		const env = await setup();
		const rejected = await openRejected(env.agent, "evil.example", 443);
		expect(rejected.status).toBe(403);
		expect(rejected.message).toBe("目标不在白名单：evil.example");
		await openRejected(env.agent, "evil.example", 443);
		expect(env.proxy.stats("s1").denied).toEqual([{ host: "evil.example", count: 2, lastAt: expect.any(Number) }]);
		expect((await openRejected(env.agent, "bad host!", 443)).status).toBe(400);
	});

	it("rejects everything when the server's proxy is off", async () => {
		const echoPort = await echoServer();
		const env = await setup(proxyConfig({ mode: "off", extraDomains: ["127.0.0.1"] }));
		const rejected = await openRejected(env.agent, "127.0.0.1", echoPort);
		expect(rejected.status).toBe(403);
	});

	it("allows any public destination for scope tools + policy all", async () => {
		const echoPort = await echoServer();
		const upstream = await fakeUpstreamProxy(echoPort);
		const env = await setup(proxyConfig({ scope: "tools", toolsPolicy: "all" }), { env: { HTTPS_PROXY: `http://127.0.0.1:${upstream.port}` } });
		const stream = await env.agent.openStream({ kind: "proxy", host: "pypi.example.org", port: 443, protocol: "connect" });
		expect(await roundTrip(stream, "pip")).toBe("pip");
		expect((await openRejected(env.agent, "localhost", 7878)).status).toBe(403);
		// Names resolving to loopback are refused even through the upstream proxy.
		expect((await openRejected(env.agent, "localtest.me", 7878)).status).toBe(403);
	});

	it("never reaches the host's loopback, own addresses or private networks without an exact entry", async () => {
		const echoPort = await echoServer();
		const { dial, dialed } = recordingDial(echoPort);
		const env = await setup(proxyConfig({ scope: "tools", toolsPolicy: "all" }), { dial });
		// Numeric shorthands resolvers turn into 127.0.0.1 / 0.0.0.0 are not host names.
		for (const host of ["127.1", "2130706433", "0177.0.0.1", "0x7f000001", "0x7f.1", "0"]) {
			expect((await openRejected(env.agent, host, 7878)).status, host).toBe(400);
		}
		for (const host of [
			"127.0.0.1",
			"localhost",
			"api.localhost",
			"localtest.me",
			"::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"0.0.0.0",
			"::",
			"10.1.2.3",
			"172.16.0.1",
			"192.168.1.1",
			"100.64.0.1",
			"169.254.169.254",
			"metadata.example",
			"fe80::1",
			"fd00::1",
			"rebind.example",
			"own.example",
			"192.0.2.10",
		]) {
			const rejected = await openRejected(env.agent, host, 8080);
			expect(rejected.status, host).toBe(403);
		}
		expect(dialed).toEqual([]);
		const ok = await env.agent.openStream({ kind: "proxy", host: "public.example", port: 443, protocol: "connect" });
		expect(await roundTrip(ok, "pub")).toBe("pub");
		expect(dialed).toEqual([{ host: "93.184.216.34", port: 443, proxy: undefined }]);
	});

	it("never tunnels to Pi-Web's own port, even for exact entries", async () => {
		const echoPort = await echoServer();
		const env = await setup(proxyConfig({ extraDomains: ["127.0.0.1", "localhost"] }));
		const listen = env.store.settings.listenPort;
		const own = await openRejected(env.agent, "127.0.0.1", listen);
		expect(own.status).toBe(403);
		expect(own.message).toContain("Pi-Web");
		expect((await openRejected(env.agent, "localhost", listen)).status).toBe(403);
		const stream = await env.agent.openStream({ kind: "proxy", host: "localhost", port: echoPort, protocol: "connect" });
		expect(await roundTrip(stream, "ok")).toBe("ok");
		// The port the CLI actually listens on (e.g. --port) is protected as well.
		env.proxy.protectLocalPort(echoPort);
		expect((await openRejected(env.agent, "127.0.0.1", echoPort)).status).toBe(403);
	});

	it("needs an exact entry for private targets: wildcards do not cover them", async () => {
		const echoPort = await echoServer();
		const { dial } = recordingDial(echoPort);
		const env = await setup(proxyConfig({ extraDomains: ["*.example"] }), { dial });
		expect((await openRejected(env.agent, "metadata.example", 80)).status).toBe(403);
		const ok = await env.agent.openStream({ kind: "proxy", host: "public.example", port: 443, protocol: "connect" });
		expect(await roundTrip(ok, "w")).toBe("w");
		await env.proxy.allowDomain("s1", "metadata.example");
		const exact = await env.agent.openStream({ kind: "proxy", host: "metadata.example", port: 80, protocol: "connect" });
		expect(await roundTrip(exact, "e")).toBe("e");
	});

	it("goes through settings.upstreamProxy with credentials", async () => {
		const echoPort = await echoServer();
		const upstream = await fakeUpstreamProxy(echoPort);
		const env = await setup(proxyConfig({ extraDomains: ["*.example.test"] }));
		env.store.settings.upstreamProxy = `http://user:pa%3Ass@127.0.0.1:${upstream.port}`;
		const stream = await env.agent.openStream({ kind: "proxy", host: "llm.example.test", port: 443, protocol: "connect" });
		expect(await roundTrip(stream, "through upstream")).toBe("through upstream");
		expect(upstream.requests).toHaveLength(1);
		expect(upstream.requests[0]).toContain("CONNECT llm.example.test:443 HTTP/1.1");
		expect(upstream.requests[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from("user:pa:ss").toString("base64")}`);
	});

	it("honors HTTPS_PROXY and NO_PROXY of the host environment", async () => {
		const echoPort = await echoServer();
		const upstream = await fakeUpstreamProxy(echoPort);
		const env = await setup(proxyConfig({ extraDomains: ["127.0.0.1", "api.example.test"] }), {
			env: { https_proxy: `127.0.0.1:${upstream.port}`, NO_PROXY: "localhost,127.0.0.0/8" },
		});
		const direct = await env.agent.openStream({ kind: "proxy", host: "127.0.0.1", port: echoPort, protocol: "connect" });
		expect(await roundTrip(direct, "direct")).toBe("direct");
		expect(upstream.requests).toHaveLength(0);
		const proxied = await env.agent.openStream({ kind: "proxy", host: "api.example.test", port: 443, protocol: "http" });
		expect(await roundTrip(proxied, "proxied")).toBe("proxied");
		expect(upstream.requests).toHaveLength(1);
	});

	it("rejects with 502 when the destination or the upstream proxy fails", async () => {
		const closed = createServer();
		const closedPort = await listen(closed);
		await new Promise((r) => closed.close(r));
		const env = await setup(proxyConfig({ extraDomains: ["127.0.0.1", "api.example.test"] }));
		const refused = await openRejected(env.agent, "127.0.0.1", closedPort);
		expect(refused.status).toBe(502);
		expect(refused.message).toContain(`127.0.0.1:${closedPort}`);

		const echoPort = await echoServer();
		const upstream = await fakeUpstreamProxy(echoPort, "HTTP/1.1 403 Forbidden");
		env.store.settings.upstreamProxy = `http://127.0.0.1:${upstream.port}`;
		const denied = await openRejected(env.agent, "api.example.test", 443);
		expect(denied.status).toBe(502);
		expect(denied.message).toContain("403");
	});

	it("adds domains to the allowlist", async () => {
		const env = await setup();
		await openRejected(env.agent, "api.new.test", 443);
		expect(env.proxy.stats("s1").denied).toHaveLength(1);
		const updated = await env.proxy.allowDomain("s1", " https://API.New.Test/v1 ");
		expect(updated.proxy.extraDomains).toEqual(["api.new.test"]);
		expect(env.store.getServer("s1")!.proxy.extraDomains).toEqual(["api.new.test"]);
		expect(env.proxy.stats("s1").denied).toEqual([]);
		await env.proxy.allowDomain("s1", "*.wild.test");
		expect(env.store.getServer("s1")!.proxy.extraDomains).toEqual(["api.new.test", "*.wild.test"]);
		await expect(env.proxy.allowDomain("s1", "not a domain")).rejects.toBeInstanceOf(ApiError);
		await expect(env.proxy.allowDomain("nope", "a.test")).rejects.toMatchObject({ status: 404 });
	});

	it("stops serving after detach and closes open tunnels", async () => {
		const echoPort = await echoServer();
		const env = await setup(proxyConfig({ extraDomains: ["127.0.0.1"] }));
		const stream = await env.agent.openStream({ kind: "proxy", host: "127.0.0.1", port: echoPort, protocol: "connect" });
		stream.on("error", () => {});
		await waitFor(() => env.proxy.stats("s1").active === 1);
		const closed = new Promise<void>((resolve) => stream.once("close", resolve));
		env.proxy.detach("s1");
		await closed;
		await waitFor(() => env.proxy.stats("s1").active === 0);
		expect((await openRejected(env.agent, "127.0.0.1", echoPort)).status).toBe(503);
	});
});
