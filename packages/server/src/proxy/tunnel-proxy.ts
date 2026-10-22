/**
 * TunnelProxy: serves the proxy streams the remote agent opens over the Link. Enforces the
 * per-server domain allowlist, connects out (directly or through the host's upstream proxy),
 * pipes bytes both ways and keeps per-server statistics.
 *
 * The remote side is untrusted (any process there can read the proxy token), so besides the
 * name allowlist every target is resolved on the host and refused when it lands on the host
 * itself (loopback, own interfaces) or on a private/link-local network, unless the user allowed
 * that exact target (a provider base URL host:port, or an exact entry in extraDomains). The
 * vetted address is dialled directly, so a second DNS answer cannot redirect the connection.
 * Pi-Web's own listen port on the host is never reachable.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { isPlainObject, matchDomain, type ProxyStats, type ServerConfig } from "@pi-web/shared";
import type { LinkStream, StreamOpenControl } from "@pi-web/shared/link";
import { type AgentClient, ApiError, type AppContext, type TunnelProxy } from "../core/types.js";
import { hostAddresses, isHostLocalAddress, isInternalAddress, isNumericHostShorthand, normalizeIp } from "./address.js";
import { collectProviderEndpoints, dynamicProviderEndpoints, formatEndpoint, matchProviderEndpoint, type ProviderEndpoint } from "./domains.js";
import { dialUpstream, formatAuthority, selectUpstreamProxy } from "./upstream.js";

export type TunnelProxyContext = Pick<AppContext, "log" | "store" | "hub" | "connections" | "hostPi">;

export interface TunnelProxyOptions {
	/** Environment for HTTPS_PROXY / NO_PROXY (default process.env). */
	env?: NodeJS.ProcessEnv;
	/** Minimum interval between stats publications per server (default 1000ms). */
	publishIntervalMs?: number;
	/** Provider domain cache lifetime (default 60s). */
	domainsTtlMs?: number;
	connectTimeoutMs?: number;
	/** Close the other half this long after one side of a tunnel closed (default 60s). */
	lingerMs?: number;
	/** Test hook: replaces the outbound dialer (direct connections receive the vetted IP). */
	dial?: (host: string, port: number, proxy: URL | undefined) => Promise<Duplex>;
	/** Test hook: resolves a host name to its addresses (default dns.lookup, all families). */
	lookup?: (host: string) => Promise<string[]>;
	/** Test hook: this machine's own addresses (default: every interface address). */
	ownAddresses?: () => ReadonlySet<string>;
}

interface HostStat {
	requests: number;
	bytesUp: number;
	bytesDown: number;
	lastAt: number;
}

interface ServerProxyState {
	active: number;
	byHost: Map<string, HostStat>;
	denied: Map<string, { count: number; lastAt: number }>;
	tunnels: Set<() => void>;
	publishTimer?: NodeJS.Timeout;
	lastPublishAt: number;
}

const MAX_HOST_ENTRIES = 200;
const DOMAIN_RE = /^(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Names that always mean this machine, whatever DNS says. */
function isLocalName(host: string): boolean {
	return host === "localhost" || host.endsWith(".localhost");
}

function normalizeTargetHost(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!host || host.length > 253) return undefined;
	if (isIP(host)) return host;
	// "127.1", "2130706433", "0x7f.1": resolvers turn these into loopback addresses.
	if (isNumericHostShorthand(host)) return undefined;
	return DOMAIN_RE.test(host) && !host.startsWith("*") ? host : undefined;
}

async function defaultLookup(host: string): Promise<string[]> {
	const results = await dnsLookup(host, { all: true, verbatim: true });
	return results.map((r) => r.address);
}

/** Why the allowlist admits a target. */
interface Admission {
	allowed: boolean;
	/** The user named this exact target: it may resolve to loopback/private addresses. */
	exact: boolean;
}

/** Normalizes user input for the allowlist: host name, "*.domain", IP, or a URL (its host is used). */
export function normalizeDomainPattern(input: string): string | undefined {
	let value = input.trim().toLowerCase();
	if (value.includes("://")) {
		try {
			value = new URL(value).hostname;
		} catch {
			return undefined;
		}
	}
	value = value.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!value) return undefined;
	if (isIP(value)) return value;
	return DOMAIN_RE.test(value) ? value : undefined;
}

function evictOldest<V extends { lastAt: number }>(map: Map<string, V>): void {
	if (map.size <= MAX_HOST_ENTRIES) return;
	let oldestKey: string | undefined;
	let oldest = Infinity;
	for (const [key, value] of map) {
		if (value.lastAt < oldest) {
			oldest = value.lastAt;
			oldestKey = key;
		}
	}
	if (oldestKey !== undefined) map.delete(oldestKey);
}

class TunnelProxyImpl implements TunnelProxy {
	private readonly env: NodeJS.ProcessEnv;
	private readonly publishIntervalMs: number;
	private readonly domainsTtlMs: number;
	private readonly connectTimeoutMs: number;
	private readonly lingerMs: number;
	private readonly clients = new Map<string, AgentClient>();
	private readonly states = new Map<string, ServerProxyState>();
	private endpointCache: { runtime: unknown; at: number; endpoints: ProviderEndpoint[] } | undefined;
	private endpointsInflight: Promise<ProviderEndpoint[]> | undefined;
	private readonly localPorts = new Set<number>();
	private readonly lookup: (host: string) => Promise<string[]>;
	private readonly ownAddresses: () => ReadonlySet<string>;

	constructor(
		private readonly ctx: TunnelProxyContext,
		private readonly options: TunnelProxyOptions,
	) {
		this.env = options.env ?? process.env;
		this.publishIntervalMs = options.publishIntervalMs ?? 1000;
		this.domainsTtlMs = options.domainsTtlMs ?? 60_000;
		this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
		this.lingerMs = options.lingerMs ?? 60_000;
		this.lookup = options.lookup ?? defaultLookup;
		this.ownAddresses = options.ownAddresses ?? hostAddresses;
	}

	attach(serverId: string, client: AgentClient): void {
		const previous = this.clients.get(serverId);
		if (previous && previous !== client) this.closeTunnels(serverId);
		this.clients.set(serverId, client);
		client.peer.onStreamOpen((meta, control) => {
			this.onStreamOpen(serverId, client, meta, control).catch((err: unknown) => {
				control.reject(`代理内部错误：${errorMessage(err)}`, 500);
			});
		});
		client.peer.once("close", () => {
			if (this.clients.get(serverId) === client) this.clients.delete(serverId);
		});
	}

	detach(serverId: string): void {
		this.clients.delete(serverId);
		this.closeTunnels(serverId);
	}

	stats(serverId: string): ProxyStats {
		const state = this.states.get(serverId);
		if (!state) return { active: 0, byHost: [], denied: [] };
		return {
			active: state.active,
			byHost: [...state.byHost].map(([host, s]) => ({ host, ...s })).sort((a, b) => b.lastAt - a.lastAt),
			denied: [...state.denied].map(([host, d]) => ({ host, ...d })).sort((a, b) => b.lastAt - a.lastAt),
		};
	}

	async allowDomain(serverId: string, domain: string): Promise<ServerConfig> {
		const server = this.ctx.store.getServer(serverId);
		if (!server) throw new ApiError(404, "SERVER_NOT_FOUND", "服务器不存在");
		const pattern = normalizeDomainPattern(domain);
		if (!pattern) throw new ApiError(400, "INVALID_DOMAIN", `域名格式不正确：${domain}`);
		let updated = server;
		if (!server.proxy.extraDomains.includes(pattern)) {
			updated = {
				...server,
				proxy: { ...server.proxy, extraDomains: [...server.proxy.extraDomains, pattern] },
				updatedAt: Date.now(),
			};
			await this.ctx.store.saveServer(updated);
		}
		const state = this.states.get(serverId);
		if (state) {
			for (const host of [...state.denied.keys()]) if (matchDomain(host, [pattern])) state.denied.delete(host);
			this.schedulePublish(serverId);
		}
		return updated;
	}

	async providerDomains(): Promise<string[]> {
		return (await this.providerEndpoints()).map(formatEndpoint);
	}

	protectLocalPort(port: number): void {
		if (Number.isInteger(port) && port > 0) this.localPorts.add(port);
	}

	private providerEndpoints(): Promise<ProviderEndpoint[]> {
		if (this.endpointsInflight) return this.endpointsInflight;
		this.endpointsInflight = this.loadProviderEndpoints().finally(() => {
			this.endpointsInflight = undefined;
		});
		return this.endpointsInflight;
	}

	private async loadProviderEndpoints(): Promise<ProviderEndpoint[]> {
		let runtime: Awaited<ReturnType<TunnelProxyContext["hostPi"]["modelRuntime"]>> | undefined;
		try {
			runtime = await this.ctx.hostPi.modelRuntime();
		} catch (err) {
			this.ctx.log.warn("provider domains: host pi model runtime unavailable", { error: errorMessage(err) });
		}
		const now = Date.now();
		const cache = this.endpointCache;
		if (cache && cache.runtime === runtime && now - cache.at < this.domainsTtlMs) return cache.endpoints;
		const endpoints = runtime ? await collectProviderEndpoints(runtime) : dynamicProviderEndpoints();
		// Without a runtime, retry soon instead of caching the fallback for the full TTL.
		this.endpointCache = { runtime, at: runtime ? now : now - this.domainsTtlMs + 5000, endpoints };
		return endpoints;
	}

	private async admission(server: ServerConfig, host: string, port: number): Promise<Admission> {
		const { proxy } = server;
		const exactExtra = proxy.extraDomains.some((pattern) => normalizeDomainPattern(pattern) === host);
		const provider = matchProviderEndpoint(host, port, await this.providerEndpoints());
		const exact = exactExtra || provider?.exact === true;
		if (exact || provider || matchDomain(host, proxy.extraDomains)) return { allowed: true, exact };
		return { allowed: proxy.scope === "tools" && proxy.toolsPolicy === "all", exact: false };
	}

	/** Ports of this Pi-Web on the host: never reachable through a tunnel. */
	private protectedPorts(): Set<number> {
		const ports = new Set(this.localPorts);
		ports.add(this.ctx.store.getSettings().listenPort ?? 7878);
		return ports;
	}

	/**
	 * Refusal reason for the resolved addresses of a target, or undefined when they may be used.
	 * Host-local targets (loopback, own interfaces) and private/link-local networks need an exact
	 * user entry; Pi-Web's own port on this machine is refused even then.
	 */
	private addressRefusal(host: string, port: number, addresses: readonly string[], admission: Admission): string | undefined {
		const own = this.ownAddresses();
		for (const address of addresses) {
			const local = isHostLocalAddress(address, own);
			if (local && this.protectedPorts().has(port)) return `不允许访问 Pi-Web 自身：${formatAuthority(host, port)}`;
			if ((local || isInternalAddress(address)) && !admission.exact) {
				return `目标解析到本机或内网地址（${normalizeIp(address)}），需在白名单中精确添加：${host}`;
			}
		}
		return undefined;
	}

	private async onStreamOpen(serverId: string, client: AgentClient, meta: unknown, control: StreamOpenControl): Promise<void> {
		if (this.clients.get(serverId) !== client) {
			control.reject("Host 代理未就绪", 503);
			return;
		}
		if (!isPlainObject(meta) || meta.kind !== "proxy") {
			control.reject("不支持的流类型", 400);
			return;
		}
		const host = normalizeTargetHost(meta.host);
		const port = Number(meta.port);
		if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
			control.reject("无效的目标地址", 400);
			return;
		}
		const server = this.ctx.store.getServer(serverId);
		if (!server || server.proxy.mode !== "tunnel") {
			control.reject("该服务器未启用隧道代理", 403);
			return;
		}
		const admission = await this.admission(server, host, port);
		if (!admission.allowed) {
			this.recordDenied(serverId, host);
			control.reject(`目标不在白名单：${host}`, 403);
			return;
		}
		const authority = formatAuthority(host, port);
		const upstream = selectUpstreamProxy(host, port, { configured: this.ctx.store.getSettings().upstreamProxy, env: this.env });
		let addresses: string[] = [];
		if (isIP(host)) addresses = [host];
		else if (isLocalName(host)) addresses = ["127.0.0.1"];
		else {
			try {
				addresses = await this.lookup(host);
			} catch (err) {
				// Through an upstream proxy the proxy resolves the name (the host may have no DNS).
				if (!upstream) {
					control.reject(`无法解析 ${host}：${errorMessage(err)}`, 502);
					return;
				}
			}
		}
		const refusal = this.addressRefusal(host, port, addresses, admission);
		if (refusal) {
			this.recordDenied(serverId, host);
			control.reject(refusal, 403);
			return;
		}
		let socket: Duplex;
		try {
			socket = upstream ? await this.dial(host, port, upstream) : await this.dialFirst(addresses, port);
		} catch (err) {
			this.ctx.log.debug("proxy connect failed", { serverId, target: authority, error: errorMessage(err) });
			control.reject(`连接 ${authority} 失败：${errorMessage(err)}`, 502);
			return;
		}
		if (this.clients.get(serverId) !== client || client.peer.closed) {
			socket.destroy();
			control.reject("Link 已断开", 502);
			return;
		}
		let stream: LinkStream;
		try {
			stream = control.accept();
		} catch {
			socket.destroy();
			return;
		}
		this.pipe(serverId, host, stream, socket);
	}

	private dial(host: string, port: number, upstream: URL | undefined): Promise<Duplex> {
		return this.options.dial ? this.options.dial(host, port, upstream) : dialUpstream(host, port, upstream, this.connectTimeoutMs);
	}

	/** Connects directly to the vetted addresses, in resolver order. */
	private async dialFirst(addresses: readonly string[], port: number): Promise<Duplex> {
		let lastError: unknown = new Error("没有可用的地址");
		for (const address of addresses) {
			try {
				return await this.dial(normalizeIp(address), port, undefined);
			} catch (err) {
				lastError = err;
			}
		}
		throw lastError;
	}

	private pipe(serverId: string, host: string, stream: LinkStream, socket: Duplex): void {
		const state = this.state(serverId);
		const now = Date.now();
		const hostStat = state.byHost.get(host) ?? { requests: 0, bytesUp: 0, bytesDown: 0, lastAt: now };
		hostStat.requests++;
		hostStat.lastAt = now;
		state.byHost.set(host, hostStat);
		evictOldest(state.byHost);
		state.active++;

		const abort = () => {
			stream.destroy();
			socket.destroy();
		};
		state.tunnels.add(abort);
		let closed = 0;
		let linger: NodeJS.Timeout | undefined;
		const onClose = () => {
			closed++;
			if (closed === 1) {
				linger = setTimeout(abort, this.lingerMs);
				linger.unref?.();
				return;
			}
			if (linger) clearTimeout(linger);
			state.tunnels.delete(abort);
			state.active = Math.max(0, state.active - 1);
			this.schedulePublish(serverId);
		};
		stream.once("close", onClose);
		socket.once("close", onClose);
		stream.on("error", abort);
		socket.on("error", abort);
		stream.on("data", (chunk: Buffer) => {
			hostStat.bytesUp += chunk.length;
			hostStat.lastAt = Date.now();
			this.schedulePublish(serverId);
		});
		socket.on("data", (chunk: Buffer) => {
			hostStat.bytesDown += chunk.length;
			hostStat.lastAt = Date.now();
			this.schedulePublish(serverId);
		});
		stream.pipe(socket);
		socket.pipe(stream);
		this.schedulePublish(serverId);
	}

	private recordDenied(serverId: string, host: string): void {
		const state = this.state(serverId);
		const entry = state.denied.get(host) ?? { count: 0, lastAt: 0 };
		entry.count++;
		entry.lastAt = Date.now();
		state.denied.set(host, entry);
		evictOldest(state.denied);
		this.ctx.log.info("proxy request denied", { serverId, host });
		this.schedulePublish(serverId);
	}

	private closeTunnels(serverId: string): void {
		const state = this.states.get(serverId);
		if (!state) return;
		for (const abort of [...state.tunnels]) abort();
	}

	private state(serverId: string): ServerProxyState {
		let state = this.states.get(serverId);
		if (!state) {
			state = { active: 0, byHost: new Map(), denied: new Map(), tunnels: new Set(), lastPublishAt: 0 };
			this.states.set(serverId, state);
		}
		return state;
	}

	private schedulePublish(serverId: string): void {
		const state = this.state(serverId);
		if (state.publishTimer) return;
		const delay = Math.max(0, state.lastPublishAt + this.publishIntervalMs - Date.now());
		state.publishTimer = setTimeout(() => {
			state.publishTimer = undefined;
			state.lastPublishAt = Date.now();
			const stats = this.stats(serverId);
			try {
				this.ctx.hub.publish(`proxy:${serverId}`, stats);
				this.ctx.connections.updateStatus(serverId, { proxy: stats });
			} catch (err) {
				this.ctx.log.debug("proxy stats publish failed", { serverId, error: errorMessage(err) });
			}
		}, delay);
		state.publishTimer.unref?.();
	}
}

export function createTunnelProxy(ctx: TunnelProxyContext, options: TunnelProxyOptions = {}): TunnelProxy {
	return new TunnelProxyImpl(ctx, options);
}
