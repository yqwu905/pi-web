/**
 * Composition root: builds every host service, wires their events together and
 * owns the background lifecycle (start after listen, graceful shutdown).
 */
import { readFileSync } from "node:fs";
import type { DeployProgress, ServerRuntimeStatus } from "@pi-web/shared";
import { createConversationService } from "./conv/index.js";
import { createLogger } from "./core/log.js";
import { createHostPaths, ensureHostDirs } from "./core/paths.js";
import { createSecrets } from "./core/secrets.js";
import { createStore } from "./core/store.js";
import type { AgentClient, AppContext, Logger, Store } from "./core/types.js";
import { createDeployer } from "./deploy/index.js";
import { createHostPi } from "./hostpi.js";
import { createTunnelProxy } from "./proxy/index.js";
import { createAccessControl } from "./routes/auth.js";
import type { AccessControl } from "./routes/auth.js";
import { readSshConfig } from "./ssh/ssh-config.js";
import { createConnectionManager } from "./ssh/connection-manager.js";
import { createOAuthKeeper } from "./sync/oauth-keeper.js";
import { createSyncer } from "./sync/syncer.js";
import { createEventHub } from "./ws.js";
import type { WsHub } from "./ws.js";

export interface ContextOptions {
	/** --data-dir (default $PI_WEB_DATA_DIR or ~/.pi-web-host). */
	dataDir?: string;
	/** Override the package version (tests). */
	version?: string;
	/** Override the logger (tests). */
	log?: Logger;
}

export interface AppRuntime {
	readonly ctx: AppContext;
	/** The EventHub (also ctx.hub) with socket handling for /ws. */
	readonly hub: WsHub;
	readonly auth: AccessControl;
	/** ~/.ssh/config reader for GET /api/ssh-config. */
	readonly sshConfigHosts: () => Promise<ReturnType<typeof readSshConfig>>;
	/** Starts background work: sync watcher, OAuth keeper, auto-connect. Call once the HTTP server listens. */
	start(): Promise<void>;
	/** Stops background work and closes every SSH connection. Idempotent. */
	shutdown(): Promise<void>;
}

const CONTEXT_KEYS = [
	"version",
	"paths",
	"log",
	"store",
	"secrets",
	"hub",
	"hostPi",
	"connections",
	"deployer",
	"proxy",
	"syncer",
	"oauth",
	"conversations",
] as const satisfies ReadonlyArray<keyof AppContext>;

type MutableContext = { -readonly [K in keyof AppContext]?: AppContext[K] };

/**
 * An AppContext whose properties are read on access, so services can be constructed in
 * dependency order while still reaching peers created after them (at call time).
 */
function lazyContext(services: MutableContext): AppContext {
	const ctx = {} as AppContext;
	for (const key of CONTEXT_KEYS) {
		Object.defineProperty(ctx, key, { enumerable: true, get: () => services[key] });
	}
	return ctx;
}

export function readPackageVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function createAppRuntime(options: ContextOptions = {}): Promise<AppRuntime> {
	const version = options.version ?? readPackageVersion();
	let store: Store | undefined;
	const paths = createHostPaths({ dataDir: options.dataDir, settings: () => store?.getSettings() });
	ensureHostDirs(paths);
	const log = options.log ?? createLogger(paths);
	store = createStore(paths, { log: log.child("store") });
	const secrets = createSecrets(paths, { log: log.child("secrets") });
	const hub = createEventHub({ version, log: log.child("ws") });

	const services: MutableContext = { version, paths, log, store, secrets, hub };
	const ctx = lazyContext(services);
	services.hostPi = createHostPi(ctx);
	services.connections = createConnectionManager(ctx);
	services.deployer = createDeployer(ctx);
	services.proxy = createTunnelProxy(ctx);
	services.syncer = createSyncer(ctx);
	services.oauth = createOAuthKeeper(ctx);
	services.conversations = createConversationService(ctx);

	const auth = createAccessControl(ctx);
	if (store.getSettings().accessTokenEnabled) await auth.ensureToken();

	wireEvents(ctx);

	let started = false;
	let shutdownPromise: Promise<void> | undefined;

	return {
		ctx,
		hub,
		auth,
		sshConfigHosts: async () => readSshConfig(),

		async start() {
			if (started) return;
			started = true;
			try {
				await ctx.syncer.start();
			} catch (err) {
				log.error("sync watcher failed to start", { error: errorMessage(err) });
			}
			try {
				await ctx.oauth.start();
			} catch (err) {
				log.error("OAuth keeper failed to start", { error: errorMessage(err) });
			}
			ctx.connections.autoConnectAll().catch((err: unknown) => {
				log.warn("auto-connect failed", { error: errorMessage(err) });
			});
		},

		shutdown() {
			shutdownPromise ??= (async () => {
				const results = await Promise.allSettled([ctx.syncer.stop(), ctx.oauth.stop()]);
				for (const result of results) {
					if (result.status === "rejected") log.warn("service stop failed", { error: errorMessage(result.reason) });
				}
				try {
					await ctx.connections.shutdown();
				} catch (err) {
					log.warn("connection shutdown failed", { error: errorMessage(err) });
				}
				hub.close();
			})();
			return shutdownPromise;
		},
	};
}

/**
 * Event hookups between services. The Syncer and the OAuthKeeper publish their own
 * topics ("sync", "oauth"); agent.configure is sent by the connection manager before
 * it emits "agent-connected", so the conversation registry only ever sees configured agents.
 */
function wireEvents(ctx: AppContext): void {
	const log = ctx.log.child("context");

	ctx.connections.on("status", (status: ServerRuntimeStatus) => ctx.hub.publish("servers", status));
	ctx.deployer.on("progress", (progress: DeployProgress) => ctx.hub.publish(`deploy:${progress.serverId}`, progress));

	// Per-server chain so a quick reconnect cannot interleave two attach sequences.
	const chains = new Map<string, Promise<void>>();

	const step = async (serverId: string, name: string, fn: () => unknown): Promise<void> => {
		try {
			await fn();
		} catch (err) {
			log.warn(`${name} failed`, { serverId, error: errorMessage(err) });
		}
	};

	const onAgentConnected = async (serverId: string, client: AgentClient): Promise<void> => {
		if (ctx.connections.get(serverId).agentClient !== client) return; // already superseded
		await step(serverId, "proxy.attach", () => ctx.proxy.attach(serverId, client));
		await step(serverId, "conversations.attach", () => ctx.conversations.attach(serverId, client));
		await step(serverId, "syncer.onAgentConnected", () => ctx.syncer.onAgentConnected(serverId));
	};

	ctx.connections.on("agent-connected", (serverId: string, client: AgentClient) => {
		const previous = chains.get(serverId) ?? Promise.resolve();
		const next = previous.then(() => onAgentConnected(serverId, client));
		chains.set(serverId, next);
		void next.finally(() => {
			if (chains.get(serverId) === next) chains.delete(serverId);
		});
	});

	ctx.connections.on("agent-disconnected", (serverId: string) => {
		try {
			ctx.proxy.detach(serverId);
		} catch (err) {
			log.warn("proxy.detach failed", { serverId, error: errorMessage(err) });
		}
		ctx.conversations.detach(serverId);
	});
}
