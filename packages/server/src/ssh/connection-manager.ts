import { EventEmitter } from "node:events";
import type { Client } from "ssh2";
import type {
	DeployState,
	HostKeyInfo,
	ServerAuthInput,
	ServerRuntimeStatus,
	TestConnectionResult,
} from "@pi-web/shared";
import { ApiError, badRequest, errorMessage, serverNotFound } from "../core/errors.js";
import { secretKeys } from "../core/secrets.js";
import type { ConnectionManager, Deployer, Logger, Secrets, Store } from "../core/types.js";
import type { LinkAgentClient } from "./agent-client.js";
import type { HostKeyStatus } from "./hostkey.js";
import {
	DEFAULT_SSH_TIMINGS,
	SshServerConnection,
	connectChain,
	resolveJumpHops,
	type HopTarget,
	type ServerConnectionOptions,
} from "./server-connection.js";

/** The parts of AppContext the connection manager needs. `deployer` is read lazily (it is created later). */
export interface ConnectionManagerContext {
	readonly version: string;
	readonly log: Logger;
	readonly store: Store;
	readonly secrets: Secrets;
	readonly deployer?: Pick<Deployer, "agentVersion" | "buildAgentConfig" | "getJob">;
}

/** Fields owned by the connection itself; updateStatus() cannot override them. */
const OWNED_FIELDS = ["serverId", "connection", "latencyMs", "connectedAt", "agent"] as const;

function stripUndefined<T extends object>(value: T): T {
	for (const key of Object.keys(value) as Array<keyof T>) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}

const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/;

export class SshConnectionManager extends EventEmitter implements ConnectionManager {
	private readonly connections = new Map<string, SshServerConnection>();
	private readonly overrides = new Map<string, Partial<ServerRuntimeStatus>>();
	private readonly lastEmitted = new Map<string, string>();
	private readonly log: Logger;

	constructor(
		private readonly ctx: ConnectionManagerContext,
		private readonly options: ServerConnectionOptions = {},
	) {
		super();
		this.log = ctx.log.child("ssh");
		// JsonStore announces saved servers; reconnect sessions whose settings changed.
		const store = ctx.store as Partial<Pick<EventEmitter, "on">>;
		if (typeof store.on === "function") {
			store.on.call(ctx.store, "server", () => this.refreshAll());
		}
	}

	private refreshAll(): void {
		for (const [serverId, conn] of this.connections) {
			if (!this.ctx.store.getServer(serverId)) continue;
			conn.refreshSettings().catch((err: unknown) => {
				this.log.warn("reconnect after settings change failed", { serverId, error: errorMessage(err) });
			});
		}
	}

	get(serverId: string): SshServerConnection {
		let conn = this.connections.get(serverId);
		if (conn) return conn;
		const server = this.ctx.store.getServer(serverId);
		if (!server) throw serverNotFound(serverId);
		conn = new SshServerConnection({
			serverId,
			store: this.ctx.store,
			secrets: this.ctx.secrets,
			log: this.log.child(server.name),
			hostVersion: this.ctx.version,
			onAgentLink: (client) => this.configureAgent(serverId, client),
			options: this.options,
		});
		conn.on("change", () => this.emitStatus(serverId));
		conn.on("agent", (client: LinkAgentClient | null) => {
			if (client) this.emit("agent-connected", serverId, client);
			else this.emit("agent-disconnected", serverId);
		});
		this.connections.set(serverId, conn);
		return conn;
	}

	private async configureAgent(serverId: string, client: LinkAgentClient): Promise<void> {
		const deployer = this.ctx.deployer;
		if (!deployer) return;
		const config = await deployer.buildAgentConfig(serverId);
		await client.call("agent.configure", config, { timeoutMs: 30_000 });
	}

	async connect(serverId: string): Promise<void> {
		const conn = this.get(serverId);
		conn.setAutoReconnect(true);
		await conn.ensureSsh();
		if (this.ctx.store.getServer(serverId)?.deployed) await conn.agent();
	}

	async disconnect(serverId: string): Promise<void> {
		const conn = this.connections.get(serverId);
		if (!conn) return;
		await conn.disconnect();
		this.emitStatus(serverId);
	}

	async remove(serverId: string): Promise<void> {
		const conn = this.connections.get(serverId);
		if (conn) {
			await conn.disconnect();
			conn.removeAllListeners();
			this.connections.delete(serverId);
		}
		this.overrides.delete(serverId);
		this.lastEmitted.delete(serverId);
	}

	private deployState(serverId: string, conn: SshServerConnection | undefined): DeployState {
		const server = this.ctx.store.getServer(serverId);
		if (!server) return "unknown";
		const deployer = this.ctx.deployer;
		if (deployer?.getJob(serverId)?.state === "running") return "deploying";
		if (!server.deployed) return "not_deployed";
		const expected = deployer?.agentVersion;
		const running = conn?.hello?.agentVersion ?? server.deployed.agentVersion;
		if (expected && running && running !== expected) return "outdated";
		return "deployed";
	}

	status(serverId: string): ServerRuntimeStatus {
		const conn = this.connections.get(serverId);
		const hello = conn?.hello;
		const override = this.overrides.get(serverId) ?? {};
		const status: ServerRuntimeStatus = {
			conversationsRunning: 0,
			conversationsWaiting: 0,
			pendingSync: 0,
			...override,
			serverId,
			connection: conn?.state ?? "disconnected",
			latencyMs: conn?.latencyMs,
			connectedAt: conn?.connectedAt,
			agent: hello
				? {
						version: hello.agentVersion,
						pid: hello.pid,
						uptimeSec: Math.max(0, Math.floor((Date.now() - hello.startedAt) / 1000)),
					}
				: undefined,
			deployState: override.deployState ?? this.deployState(serverId, conn),
			error: conn?.lastError ?? conn?.agentError ?? override.error,
		};
		return stripUndefined(status);
	}

	allStatuses(): ServerRuntimeStatus[] {
		return this.ctx.store.listServers().map((server) => this.status(server.id));
	}

	updateStatus(serverId: string, patch: Partial<ServerRuntimeStatus>): void {
		const current = { ...(this.overrides.get(serverId) ?? {}) } as Record<string, unknown>;
		for (const [key, value] of Object.entries(patch)) {
			if ((OWNED_FIELDS as readonly string[]).includes(key)) continue;
			if (value === undefined) delete current[key];
			else current[key] = value;
		}
		this.overrides.set(serverId, current as Partial<ServerRuntimeStatus>);
		this.emitStatus(serverId);
	}

	private emitStatus(serverId: string): void {
		if (!this.ctx.store.getServer(serverId)) return;
		const status = this.status(serverId);
		// uptime changes every second; it alone is not a reason to notify
		const key = JSON.stringify({ ...status, agent: status.agent ? { ...status.agent, uptimeSec: 0 } : undefined });
		if (this.lastEmitted.get(serverId) === key) return;
		this.lastEmitted.set(serverId, key);
		this.emit("status", status);
	}

	async testConnection(input: {
		host: string;
		port: number;
		username: string;
		auth: ServerAuthInput;
		jumpServerIds?: string[];
		serverId?: string;
	}): Promise<TestConnectionResult> {
		const existing = input.serverId ? this.ctx.store.getServer(input.serverId) : undefined;
		if (input.serverId && !existing) throw serverNotFound(input.serverId);
		if (!input.host?.trim() || !input.username?.trim()) throw badRequest("主机地址和用户名不能为空");
		const port = input.port || 22;
		let secret: string | undefined;
		if (typeof input.auth.secret === "string") secret = input.auth.secret || undefined;
		else if (input.auth.secret === undefined && existing && input.auth.method !== "agent") {
			secret = await this.ctx.secrets.get(secretKeys.serverSecret(existing.id));
		}
		const sameEndpoint = existing && existing.host === input.host.trim() && existing.port === port;
		let hostKey: HostKeyInfo | undefined;
		let hostKeyStatus: HostKeyStatus = "unknown";
		const target: HopTarget = {
			label: `${input.username}@${input.host}:${port}`,
			serverId: existing?.id,
			host: input.host.trim(),
			port,
			username: input.username.trim(),
			auth: { method: input.auth.method, ...(input.auth.keyPath ? { keyPath: input.auth.keyPath } : {}) },
			secret,
			trustedKey: sameEndpoint ? existing.hostKey : undefined,
			onHostKey: (key, status) => {
				hostKey = key;
				hostKeyStatus = status;
			},
		};
		try {
			const jumpIds = input.jumpServerIds ?? existing?.jumpServerIds ?? [];
			const jumps = await resolveJumpHops(jumpIds, this.ctx.store, this.ctx.secrets, existing?.id);
			const clients = await connectChain([...jumps, target], { timings: this.options.timings ?? DEFAULT_SSH_TIMINGS, log: this.log });
			try {
				const latencyMs = await measureExecLatency(clients[clients.length - 1]);
				return { ok: true, hostKey, hostKeyStatus, latencyMs };
			} finally {
				for (const client of clients.reverse()) client.end();
			}
		} catch (err) {
			return {
				ok: false,
				error: errorMessage(err),
				...(hostKey ? { hostKey } : {}),
				hostKeyStatus,
			};
		}
	}

	async trustHostKey(serverId: string, key: HostKeyInfo): Promise<void> {
		const server = this.ctx.store.getServer(serverId);
		if (!server) throw serverNotFound(serverId);
		if (!FINGERPRINT_RE.test(key.fingerprint ?? "")) throw badRequest("主机指纹格式无效");
		server.hostKey = { algorithm: key.algorithm, fingerprint: key.fingerprint, trustedAt: Date.now() };
		server.updatedAt = Date.now();
		await this.ctx.store.saveServer(server);
		this.log.info("host key trusted", { server: server.name, fingerprint: key.fingerprint });
		const conn = this.connections.get(serverId);
		if (conn && !conn.sshConnected) conn.clearError();
		this.emitStatus(serverId);
	}

	async autoConnectAll(): Promise<void> {
		const servers = this.ctx.store.listServers().filter((server) => server.deployed && !server.jumpOnly);
		await Promise.all(
			servers.map(async (server) => {
				try {
					await this.connect(server.id);
				} catch (err) {
					this.log.warn("auto-connect failed", { server: server.name, error: errorMessage(err) });
				}
			}),
		);
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.connections.values()].map((conn) => conn.disconnect().catch(() => {})));
	}
}

function measureExecLatency(client: Client): Promise<number> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		client.exec("true", (err, channel) => {
			if (err) {
				reject(new ApiError(502, "SSH_CHANNEL_FAILED", `无法执行命令：${err.message}`));
				return;
			}
			channel.on("data", () => {});
			channel.stderr.on("data", () => {});
			channel.on("close", () => resolve(Date.now() - started));
			channel.end();
		});
	});
}

export function createConnectionManager(ctx: ConnectionManagerContext, options?: ServerConnectionOptions): SshConnectionManager {
	return new SshConnectionManager(ctx, options);
}
