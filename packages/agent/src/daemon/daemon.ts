import { randomBytes } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import { homedir, loadavg } from "node:os";
import {
	AGENT_PROTOCOL_VERSION,
	type AgentConfig,
	type AgentEventMap,
	type AgentHelloResult,
	type AgentLogsParams,
	type AgentMethodMap,
	type AgentStatus,
} from "@pi-web/shared";
import type { LinkPeer } from "@pi-web/shared/link";
import { AGENT_VERSION } from "../version.js";
import { ConfigStore, validateAgentConfig } from "./config.js";
import { ConversationManager } from "./conversations.js";
import { AgentError, errorMessage } from "./errors.js";
import { fsList, fsMkdir, fsRead, fsRealpath, fsStat } from "./handlers/fs.js";
import { gitDiff, gitLog, gitStatus } from "./handlers/git.js";
import { SessionsHandler } from "./handlers/sessions.js";
import { SyncHandler } from "./handlers/sync.js";
import { AgentLogger } from "./logger.js";
import { ensureRemoteDirs, type RemotePaths, remotePaths } from "./paths.js";
import { ProxyListener } from "./proxy.js";
import { LinkServer, type ListenOutcome } from "./server.js";

export interface DaemonOptions {
	root: string;
	/** Echo log lines to stderr. */
	echoLogs?: boolean;
	/** Called after a graceful shutdown finished (main exits the process). */
	onShutdown?: () => void;
	/** Called once the daemon stopped accepting connections (main releases the instance lock). */
	onStopAccepting?: () => void;
	conversation?: Partial<ConstructorParameters<typeof ConversationManager>[0]>;
}

type Handlers = {
	[M in keyof AgentMethodMap]: (
		params: AgentMethodMap[M][0],
		peer: LinkPeer,
	) => AgentMethodMap[M][1] | Promise<AgentMethodMap[M][1]>;
};

/** The pi-web-agent daemon: socket server, conversations, proxy listener and request handlers. */
export class Daemon {
	readonly paths: RemotePaths;
	readonly log: AgentLogger;
	readonly config: ConfigStore;
	readonly conversations: ConversationManager;
	readonly proxy: ProxyListener;
	readonly server: LinkServer;
	readonly sessions: SessionsHandler;
	readonly sync: SyncHandler;
	readonly startedAt = Date.now();
	private shuttingDown: Promise<void> | null = null;
	private accepting = true;
	/**
	 * Proxy token handed to pi (process env, run/proxy.env): new for every daemon process, so a
	 * token captured while the fixed proxy port was not ours stops working. The host's configured
	 * token stays accepted for the deploy self-check but is never handed to processes.
	 */
	private readonly sessionProxyToken = randomBytes(24).toString("hex");

	constructor(private readonly options: DaemonOptions) {
		this.paths = remotePaths(options.root);
		this.log = new AgentLogger(this.paths.agentLog, { echo: options.echoLogs });
		this.config = new ConfigStore(this.paths);
		this.server = new LinkServer((peer) => this.registerHandlers(peer));
		this.log.onEntry = (entry) => this.server.broadcast("agent.log", entry);
		this.proxy = new ProxyListener({
			getPeer: () => this.server.latestPeer(),
			log: this.log,
			extraTokens: () => [...this.conversations.liveProxyTokens(), this.config.config?.proxy.token ?? ""],
		});
		this.conversations = new ConversationManager({
			paths: this.paths,
			getConfig: () => this.effectiveConfig(),
			emit: (event, data) => this.emit(event, data),
			log: this.log,
			...options.conversation,
		});
		const agentDir = () => this.config.config?.agentDir ?? this.paths.defaultAgentDir;
		this.sessions = new SessionsHandler({
			getAgentDir: agentDir,
			getExtraEnv: () => this.config.config?.extraEnv,
			findRunning: (file) => this.conversations.findBySessionFile(file)?.convId,
			trashDir: this.paths.trashSessionsDir,
		});
		this.sync = new SyncHandler({
			paths: this.paths,
			getAgentDir: () => {
				const dir = this.config.config?.agentDir;
				if (!dir) throw new AgentError("NOT_CONFIGURED", "Agent 尚未配置");
				return dir;
			},
		});
	}

	/** Prepares directories, loads the config and listens. Returns "already-running" when another daemon owns the socket. */
	async start(): Promise<ListenOutcome> {
		await ensureRemoteDirs(this.paths);
		const config = await this.config.load();
		const outcome = await this.server.listen(this.paths.socket);
		if (outcome === "already-running") return outcome;
		this.log.info("pi-web-agent started", { version: AGENT_VERSION, pid: process.pid, root: this.paths.root });
		// A proxy.env left by an earlier daemon names a port that is not ours until we bind it.
		await this.config.removeProxyEnv().catch(() => {});
		if (config) {
			// Already logged as an error by applyProxy; the host sees it in agent.status (not listening).
			await this.applyProxy(config).catch(() => {});
		}
		return outcome;
	}

	/** The stored config with the proxy token pi processes use. */
	private effectiveConfig(): AgentConfig | null {
		const config = this.config.config;
		if (!config?.proxy.enabled) return config;
		return { ...config, proxy: { ...config.proxy, token: this.sessionProxyToken } };
	}

	emit<E extends keyof AgentEventMap>(event: E, data: AgentEventMap[E]): void {
		this.server.broadcast(event, data);
	}

	/**
	 * First shutdown phase: stop listening (socket file removed), stop the proxy and let
	 * main release the instance lock, so a replacement daemon can start right away.
	 */
	async stopAccepting(): Promise<void> {
		if (!this.accepting) return;
		this.accepting = false;
		this.server.stopListening();
		this.options.onStopAccepting?.();
		await this.proxy.stop().catch(() => {});
		await this.config.removeProxyEnv().catch(() => {});
	}

	/** Graceful shutdown: stop accepting, stop conversations (stdin close → SIGTERM → SIGKILL), close peers. */
	shutdown(reason: string): Promise<void> {
		if (this.shuttingDown) return this.shuttingDown;
		this.shuttingDown = (async () => {
			this.log.info("shutting down", { reason, conversations: this.conversations.liveCount });
			await this.stopAccepting();
			await this.conversations.shutdownAll().catch(() => {});
			this.conversations.dispose();
			await this.server.close().catch(() => {});
			this.options.onShutdown?.();
		})();
		return this.shuttingDown;
	}

	hello(): AgentHelloResult {
		return {
			agentVersion: AGENT_VERSION,
			protocol: AGENT_PROTOCOL_VERSION,
			pid: process.pid,
			startedAt: this.startedAt,
			home: homedir(),
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.versions.node,
			remoteRoot: this.paths.root,
			config: this.config.config,
		};
	}

	async status(): Promise<AgentStatus> {
		let diskFreeBytes: number | undefined;
		try {
			const s = await statfs(this.paths.root);
			diskFreeBytes = Number(s.bavail) * Number(s.bsize);
		} catch {
			diskFreeBytes = undefined;
		}
		return {
			agentVersion: AGENT_VERSION,
			pid: process.pid,
			uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
			conversations: this.conversations.list(),
			proxy: { listening: this.proxy.listening, port: this.proxy.port, activeConnections: this.proxy.activeConnections },
			diskFreeBytes,
			loadavg: loadavg(),
		};
	}

	async configure(raw: unknown): Promise<{ ok: true }> {
		const config = validateAgentConfig(raw);
		await mkdir(config.agentDir, { recursive: true, mode: 0o700 }).catch(() => {});
		await this.config.save(config);
		// pi processes get the variables from extraEnv; the file is for R/bin/pi and the web terminal.
		await this.config.writeEnvFile(config.extraEnv);
		this.log.info("configured", {
			agentDir: config.agentDir,
			piVersion: config.piVersion,
			proxy: config.proxy.enabled ? `127.0.0.1:${config.proxy.port}` : "off",
			idleTimeoutMin: config.idleTimeoutMin,
			env: Object.keys(config.extraEnv).length,
		});
		await this.applyProxy(config);
		return { ok: true };
	}

	/**
	 * Binds the proxy listener and only then publishes run/proxy.env (removed whenever the port is
	 * not ours: disabled, bind failure, shutdown).
	 */
	private async applyProxy(config: AgentConfig): Promise<void> {
		if (!config.proxy.enabled || !this.accepting) {
			await this.proxy.stop();
			await this.config.removeProxyEnv();
			return;
		}
		try {
			await this.proxy.start(config.proxy.port, this.sessionProxyToken);
		} catch (err) {
			await this.config.removeProxyEnv().catch(() => {});
			this.log.error("proxy listen failed", { port: config.proxy.port, error: errorMessage(err) });
			throw new AgentError("PROXY_LISTEN_FAILED", `代理端口 ${config.proxy.port} 监听失败：${errorMessage(err)}`);
		}
		const effective = this.effectiveConfig();
		if (!effective) return;
		await this.config.writeProxyEnv(effective.proxy, { pid: process.pid, commandMatch: process.argv[1] });
	}

	private handlers(): Handlers {
		return {
			hello: () => this.hello(),
			"agent.configure": (params) => this.configure(params),
			"agent.status": () => this.status(),
			"agent.logs": (params: AgentLogsParams) => ({ lines: this.log.tail(params?.tail ?? 200) }),
			"agent.shutdown": async () => {
				// Stop accepting before answering: a bridge started right after this response
				// must reach a new daemon, not this one.
				await this.stopAccepting();
				setImmediate(() => void this.shutdown("agent.shutdown"));
				return { ok: true };
			},
			"conv.start": (params) => this.conversations.start(params),
			"conv.list": () => ({ conversations: this.conversations.list() }),
			"conv.send": (params) => this.conversations.send(params),
			"conv.snapshot": (params) => this.conversations.snapshot(params),
			"conv.uiResponse": (params) => this.conversations.uiResponse(params),
			"conv.replay": (params) => this.conversations.replay(params),
			"conv.stop": (params) => this.conversations.stop(params),
			"conv.companion": (params) => this.conversations.companion(params),
			"sessions.list": (params) => this.sessions.list(params),
			"sessions.read": (params) => this.sessions.read(params),
			"sessions.delete": (params) => this.sessions.delete(params),
			"fs.list": (params) => fsList(params),
			"fs.read": (params) => fsRead(params),
			"fs.stat": (params) => fsStat(params),
			"fs.mkdir": (params) => fsMkdir(params),
			"fs.realpath": (params) => fsRealpath(params),
			"git.status": (params) => gitStatus(params),
			"git.diff": (params) => gitDiff(params),
			"git.log": (params) => gitLog(params),
			"sync.manifest": (params) => this.sync.manifest(params),
			"sync.apply": (params) => this.sync.apply(params),
		};
	}

	private registerHandlers(peer: LinkPeer): void {
		for (const [method, handler] of Object.entries(this.handlers())) {
			peer.handle(method, async (params, p) => {
				try {
					return await (handler as (params: unknown, peer: LinkPeer) => unknown)(params, p);
				} catch (err) {
					if (!(err instanceof AgentError)) this.log.warn("request failed", { method, error: errorMessage(err) });
					throw err;
				}
			});
		}
		this.log.debug("host connected", { peers: this.server.peerCount + 1 });
	}
}
