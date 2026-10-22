/**
 * Host-side outbound HTTP through the host's proxy settings.
 *
 * pi's CLI installs a proxy-aware undici dispatcher in its own entry point
 * (pi-coding-agent dist/core/http-dispatcher.js, not exported). Pi-Web embeds pi's
 * libraries instead of running that entry point, so without doing the same, pi-ai's
 * OAuth token refreshes (plain global fetch) would ignore HTTP(S)_PROXY: Node's fetch
 * does not read proxy variables. settings.upstreamProxy takes precedence over the
 * environment; NO_PROXY is honoured either way.
 */
import { EventEmitter } from "node:events";
import { Client, Dispatcher, EnvHttpProxyAgent, Pool, install, setGlobalDispatcher } from "undici";

// Node's 250ms default can terminate valid connection attempts on high-latency routes (same as pi).
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

const ignoreDispatcherError = (_error: unknown): void => {};

/**
 * Undici can emit an internal Client "error" while terminating a mid-stream body; the body
 * stream still rejects on its own, so a listener only prevents EventEmitter's unhandled
 * "error" crash (pi does the same).
 */
function withErrorListener<T extends Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", ignoreDispatcherError);
	return dispatcher;
}

function createClient(origin: URL | string, options: object): Dispatcher {
	return withErrorListener(new Client(origin, options as Client.Options));
}

function createOriginDispatcher(origin: URL | string, options: object): Dispatcher {
	const opts = options as Pool.Options;
	if (opts.connections === 1) return createClient(origin, opts);
	return withErrorListener(new Pool(origin, { ...opts, factory: createClient }));
}

/** Normalized proxy URL from settings.upstreamProxy ("" = use the environment). */
function proxyKey(upstreamProxy: string | undefined): string {
	return upstreamProxy?.trim() ?? "";
}

/**
 * A proxy-aware agent like pi's: `upstreamProxy` (when set) for http and https, otherwise
 * HTTP_PROXY / HTTPS_PROXY from the environment, bypassing NO_PROXY hosts.
 */
export function createProxyAgent(upstreamProxy?: string): EnvHttpProxyAgent {
	const proxy = proxyKey(upstreamProxy);
	return withErrorListener(
		new EnvHttpProxyAgent({
			...(proxy ? { httpProxy: proxy, httpsProxy: proxy } : {}),
			allowH2: false,
			proxyTunnel: true,
			connect: { autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
			clientFactory: createClient,
			factory: createOriginDispatcher,
		}),
	);
}

/**
 * Dispatcher that follows settings.upstreamProxy at runtime: requests go through one shared
 * agent per proxy value; the previous agent is closed gracefully when the setting changes.
 */
export class HostProxyDispatcher extends Dispatcher {
	private current: { key: string; agent: EnvHttpProxyAgent } | undefined;

	constructor(
		private readonly upstreamProxy: () => string | undefined,
		private readonly createAgent: (upstreamProxy: string) => EnvHttpProxyAgent = createProxyAgent,
	) {
		super();
	}

	/** The agent for the current setting (created on first use or after a change). */
	agent(): EnvHttpProxyAgent {
		const key = proxyKey(this.upstreamProxy());
		const current = this.current;
		if (current?.key === key) return current.agent;
		const agent = this.createAgent(key);
		this.current = { key, agent };
		current?.agent.close().catch(() => {});
		return agent;
	}

	override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
		return this.agent().dispatch(options, handler);
	}

	override close(): Promise<void>;
	override close(callback: () => void): void;
	override close(callback?: () => void): Promise<void> | void {
		const agent = this.current?.agent;
		this.current = undefined;
		const done = agent ? agent.close() : Promise.resolve();
		if (!callback) return done;
		done.then(callback, callback);
	}

	override destroy(err: Error | null, callback: () => void): void;
	override destroy(callback: () => void): void;
	override destroy(err: Error | null): Promise<void>;
	override destroy(): Promise<void>;
	override destroy(errOrCallback?: Error | null | (() => void), maybeCallback?: () => void): Promise<void> | void {
		const callback = typeof errOrCallback === "function" ? errOrCallback : maybeCallback;
		const err = typeof errOrCallback === "function" ? null : (errOrCallback ?? null);
		const agent = this.current?.agent;
		this.current = undefined;
		const done = agent ? agent.destroy(err) : Promise.resolve();
		if (!callback) return done;
		done.then(callback, callback);
	}
}

let installed: HostProxyDispatcher | undefined;

/**
 * Makes global fetch (pi-ai's OAuth refresh, model listing, …) use the host's proxy settings.
 * Like pi's configureHttpDispatcher it also installs undici's fetch so fetch and the dispatcher
 * share one implementation. Idempotent; returns the global dispatcher.
 */
export function installHostHttpDispatcher(upstreamProxy: () => string | undefined): HostProxyDispatcher {
	if (installed) return installed;
	const dispatcher = new HostProxyDispatcher(upstreamProxy);
	setGlobalDispatcher(dispatcher);
	install?.();
	installed = dispatcher;
	return dispatcher;
}
