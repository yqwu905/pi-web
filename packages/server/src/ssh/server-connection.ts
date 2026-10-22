import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream as createLocalReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path, { posix } from "node:path";
import type { Readable } from "node:stream";
import {
	AGENT_PROTOCOL_VERSION,
	shellQuote,
	type AgentHelloResult,
	type ConnectionState,
	type HostKeyInfo,
	type ServerAuth,
	type ServerConfig,
} from "@pi-web/shared";
import { LINK_PREAMBLE, LinkPeer } from "@pi-web/shared/link";
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { ApiError, connectCancelled, connectionRemoved, errorCode, errorMessage, serverNotFound } from "../core/errors.js";
import { expandHome } from "../core/paths.js";
import { secretKeys } from "../core/secrets.js";
import type { ExecOptions, ExecResult, Logger, Secrets, ServerConnection, Store, UploadOptions } from "../core/types.js";
import { LinkAgentClient } from "./agent-client.js";
import { compareHostKey, hostKeyInfo, type HostKeyStatus } from "./hostkey.js";
import { sftpPath, shPath } from "./remote-path.js";

// ---------------------------------------------------------------------------
// Hop chain (direct connection or through jump hosts)
// ---------------------------------------------------------------------------

export interface HopTarget {
	/** Human readable name used in error messages. */
	label: string;
	serverId?: string;
	host: string;
	port: number;
	username: string;
	auth: ServerAuth;
	/** Password or key passphrase. */
	secret?: string;
	trustedKey?: { fingerprint: string; algorithm?: string };
	/** Observes the presented host key and its trust status. */
	onHostKey?: (key: HostKeyInfo, status: HostKeyStatus) => void;
}

export interface SshTimings {
	readyTimeoutMs: number;
	keepaliveIntervalMs: number;
	keepaliveCountMax: number;
}

export const DEFAULT_SSH_TIMINGS: SshTimings = {
	readyTimeoutMs: 20_000,
	keepaliveIntervalMs: 15_000,
	keepaliveCountMax: 3,
};

const NO_RETRY_CODES = new Set([
	"HOSTKEY_UNKNOWN",
	"HOSTKEY_MISMATCH",
	"SSH_AUTH_FAILED",
	"SSH_KEY_INVALID",
	"SSH_KEY_MISSING",
	"SSH_SECRET_MISSING",
	"SSH_AGENT_UNAVAILABLE",
	"SERVER_NOT_FOUND",
	"JUMP_NOT_FOUND",
	"JUMP_INVALID",
]);

/** True for failures that a retry cannot fix (trust, credentials, configuration). */
export function isPermanentSshError(err: unknown): boolean {
	const code = errorCode(err);
	return code !== undefined && NO_RETRY_CODES.has(code);
}

const DEFAULT_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];

async function authConfig(target: HopTarget): Promise<Partial<ConnectConfig>> {
	switch (target.auth.method) {
		case "password":
			if (!target.secret) {
				throw new ApiError(400, "SSH_SECRET_MISSING", `${target.label}：未保存登录密码`);
			}
			return { password: target.secret, tryKeyboard: true };
		case "agent": {
			const sock = process.env.SSH_AUTH_SOCK;
			if (!sock) {
				throw new ApiError(400, "SSH_AGENT_UNAVAILABLE", "未检测到 SSH_AUTH_SOCK，无法使用 ssh-agent 认证");
			}
			return { agent: sock };
		}
		case "key": {
			let keyPath = target.auth.keyPath ? expandHome(target.auth.keyPath) : undefined;
			if (!keyPath) {
				keyPath = DEFAULT_KEYS.map((name) => path.join(homedir(), ".ssh", name)).find((file) => existsSync(file));
			}
			if (!keyPath) throw new ApiError(400, "SSH_KEY_MISSING", `${target.label}：未指定私钥文件，且 ~/.ssh 下没有默认私钥`);
			let privateKey: Buffer;
			try {
				privateKey = await readFile(keyPath);
			} catch (err) {
				throw new ApiError(400, "SSH_KEY_MISSING", `无法读取私钥文件 ${keyPath}：${errorMessage(err)}`);
			}
			return { privateKey, ...(target.secret ? { passphrase: target.secret } : {}) };
		}
		default:
			throw new ApiError(400, "SSH_AUTH_INVALID", `不支持的认证方式：${String((target.auth as ServerAuth).method)}`);
	}
}

function mapConnectError(err: unknown, target: HopTarget, hostKey?: HostKeyInfo, status?: HostKeyStatus): ApiError {
	if (err instanceof ApiError) return err;
	const details = { serverId: target.serverId, host: target.host, port: target.port, ...(hostKey ?? {}) };
	if (hostKey && status === "unknown") {
		return new ApiError(409, "HOSTKEY_UNKNOWN", `${target.label} 的主机指纹尚未确认（${hostKey.fingerprint}）`, details);
	}
	if (hostKey && status === "mismatch") {
		return new ApiError(
			409,
			"HOSTKEY_MISMATCH",
			`${target.label} 的主机指纹与已信任的不一致（${hostKey.fingerprint}），可能存在中间人攻击，已拒绝连接`,
			details,
		);
	}
	const e = err as { level?: string; code?: string; message?: string };
	const message = e?.message ?? String(err);
	if (e?.level === "client-authentication") {
		return new ApiError(502, "SSH_AUTH_FAILED", `${target.label}：SSH 认证失败（用户 ${target.username}）`, details);
	}
	if (e?.level === "client-timeout") {
		return new ApiError(504, "SSH_TIMEOUT", `连接 ${target.host}:${target.port} 超时`, details);
	}
	if (e?.level === "client-dns" || ["ENOTFOUND", "EAI_AGAIN"].includes(e?.code ?? "")) {
		return new ApiError(502, "SSH_CONNECT_FAILED", `无法解析主机名 ${target.host}`, details);
	}
	if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "EPIPE"].includes(e?.code ?? "")) {
		return new ApiError(502, "SSH_CONNECT_FAILED", `无法连接 ${target.host}:${target.port}（${e.code}）`, details);
	}
	if (/privateKey|passphrase|private key/i.test(message)) {
		return new ApiError(400, "SSH_KEY_INVALID", `${target.label}：无法解析私钥（${message}），请检查私钥文件和 passphrase`, details);
	}
	return new ApiError(502, "SSH_ERROR", `${target.label}：SSH 错误：${message}`, details);
}

/** Connects one hop; `sock` is the forwarded stream from the previous hop. */
export async function connectHop(
	target: HopTarget,
	options: { sock?: ClientChannel; timings?: SshTimings; log?: Logger } = {},
): Promise<Client> {
	const timings = options.timings ?? DEFAULT_SSH_TIMINGS;
	const auth = await authConfig(target);
	return new Promise<Client>((resolve, reject) => {
		const client = new Client();
		let presented: HostKeyInfo | undefined;
		let status: HostKeyStatus | undefined;
		let ready = false;
		let settled = false;
		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			try {
				client.end();
			} catch {
				// ignore
			}
			reject(mapConnectError(err, target, presented, status));
		};
		client.on("error", (err: Error) => {
			if (!ready) fail(err);
			else options.log?.debug("ssh client error", { host: target.host, error: err.message });
		});
		client.on("close", () => {
			if (!ready) fail(new ApiError(502, "SSH_CLOSED", `${target.label}：连接在认证完成前被关闭`));
		});
		client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
			finish(prompts.map(() => target.secret ?? ""));
		});
		client.on("ready", () => {
			ready = true;
			settled = true;
			resolve(client);
		});
		const config: ConnectConfig = {
			host: target.host,
			port: target.port,
			username: target.username,
			readyTimeout: timings.readyTimeoutMs,
			keepaliveInterval: timings.keepaliveIntervalMs,
			keepaliveCountMax: timings.keepaliveCountMax,
			hostVerifier: (key: Buffer) => {
				presented = hostKeyInfo(key);
				status = compareHostKey(target.trustedKey, presented);
				target.onHostKey?.(presented, status);
				return status === "trusted";
			},
			...auth,
		};
		if (options.sock) config.sock = options.sock;
		try {
			client.connect(config);
		} catch (err) {
			fail(err);
		}
	});
}

function forwardOut(client: Client, host: string, port: number): Promise<ClientChannel> {
	return new Promise((resolve, reject) => {
		client.forwardOut("127.0.0.1", 0, host, port, (err, channel) => (err ? reject(err) : resolve(channel)));
	});
}

/** Connects hops in order (first hop direct, each next one through the previous). Returns all clients, target last. */
export async function connectChain(
	hops: HopTarget[],
	options: { timings?: SshTimings; log?: Logger } = {},
): Promise<Client[]> {
	const clients: Client[] = [];
	try {
		for (let i = 0; i < hops.length; i++) {
			let sock: ClientChannel | undefined;
			if (i > 0) {
				try {
					sock = await forwardOut(clients[i - 1], hops[i].host, hops[i].port);
				} catch (err) {
					throw new ApiError(
						502,
						"JUMP_FORWARD_FAILED",
						`跳板机 ${hops[i - 1].label} 无法转发到 ${hops[i].host}:${hops[i].port}：${errorMessage(err)}`,
					);
				}
			}
			clients.push(await connectHop(hops[i], { sock, timings: options.timings, log: options.log }));
		}
		return clients;
	} catch (err) {
		for (const client of clients.reverse()) client.end();
		throw err;
	}
}

/**
 * Identity of everything an SSH session depends on: endpoint, user, auth, trusted key and
 * (hashed) stored secret of every hop.
 */
export function hopsKey(hops: readonly HopTarget[]): string {
	return JSON.stringify(
		hops.map((h) => [
			h.host,
			h.port,
			h.username,
			h.auth.method,
			h.auth.keyPath ?? null,
			h.trustedKey?.fingerprint ?? null,
			h.secret === undefined ? null : createHash("sha256").update(h.secret).digest("base64"),
		]),
	);
}

/** Builds the hop list for a saved server: its jump servers (saved configs), then the server itself. */
export async function resolveHops(
	server: ServerConfig,
	store: Pick<Store, "getServer">,
	secrets: Pick<Secrets, "get">,
): Promise<HopTarget[]> {
	const jumps = await resolveJumpHops(server.jumpServerIds ?? [], store, secrets, server.id);
	return [...jumps, await savedHop(server, secrets, server.name)];
}

/** Hops for an ordered list of saved jump servers (each with its own auth and trusted key). */
export async function resolveJumpHops(
	jumpIds: string[],
	store: Pick<Store, "getServer">,
	secrets: Pick<Secrets, "get">,
	selfId?: string,
): Promise<HopTarget[]> {
	const hops: HopTarget[] = [];
	const seen = new Set<string>(selfId ? [selfId] : []);
	for (const jumpId of jumpIds) {
		if (seen.has(jumpId)) throw new ApiError(400, "JUMP_INVALID", "跳板机配置存在循环或重复");
		seen.add(jumpId);
		const jump = store.getServer(jumpId);
		if (!jump) throw new ApiError(400, "JUMP_NOT_FOUND", `跳板机不存在：${jumpId}`);
		hops.push(await savedHop(jump, secrets, `跳板机 ${jump.name}`));
	}
	return hops;
}

async function savedHop(server: ServerConfig, secrets: Pick<Secrets, "get">, label: string): Promise<HopTarget> {
	const secret = server.auth.method === "agent" ? undefined : await secrets.get(secretKeys.serverSecret(server.id));
	return {
		label,
		serverId: server.id,
		host: server.host,
		port: server.port,
		username: server.username,
		auth: server.auth,
		secret,
		trustedKey: server.hostKey,
	};
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class Semaphore {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private limit: number) {}

	/** Lets every waiter through (used when the connection the slots belong to is gone). */
	abandon(): void {
		this.limit = Number.POSITIVE_INFINITY;
		while (this.waiters.length > 0) this.waiters.shift()?.();
	}

	async acquire(): Promise<() => void> {
		if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.waiters.shift()?.();
		};
	}
}

class CappedBuffer {
	private readonly chunks: Buffer[] = [];
	private size = 0;
	truncated = false;

	constructor(private readonly max: number) {}

	push(chunk: Buffer): void {
		if (this.size >= this.max) {
			this.truncated = true;
			return;
		}
		const room = this.max - this.size;
		const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
		if (piece.length < chunk.length) this.truncated = true;
		this.chunks.push(piece);
		this.size += piece.length;
	}

	toBuffer(): Buffer {
		return Buffer.concat(this.chunks);
	}
}

function tailText(text: string, max: number): string {
	return text.length > max ? text.slice(text.length - max) : text;
}

function abortError(): ApiError {
	return new ApiError(499, "CANCELLED", "操作已取消");
}

export interface ExecBufferResult {
	stdout: Buffer;
	stderr: Buffer;
	code: number | null;
	signal?: string;
}

// ---------------------------------------------------------------------------
// ServerConnection
// ---------------------------------------------------------------------------

export interface ServerConnectionOptions {
	timings?: SshTimings;
	/** Wait for the bridge preamble at most this long (default 20s). */
	linkTimeoutMs?: number;
	/** Link latency probe interval (default 15s). */
	pingIntervalMs?: number;
	/** Reconnect backoff bounds (default 2s → 60s). */
	minBackoffMs?: number;
	maxBackoffMs?: number;
	/** Concurrent short-lived exec channels (OpenSSH MaxSessions defaults to 10). */
	maxConcurrentExec?: number;
	/** Testing: pretend the SFTP subsystem is unavailable. */
	disableSftp?: boolean;
}

export interface ServerConnectionDeps {
	serverId: string;
	store: Pick<Store, "getServer">;
	secrets: Pick<Secrets, "get">;
	log: Logger;
	hostVersion: string;
	/** Runs after hello and before the link is published (the manager sends agent.configure here). */
	onAgentLink?: (client: LinkAgentClient) => Promise<void>;
	options?: ServerConnectionOptions;
}

/**
 * One server's SSH session (jump chain included) plus its agent link.
 * Emits "state", "agent" (contract) and "change" (any status-relevant field changed).
 */
export class SshServerConnection extends EventEmitter implements ServerConnection {
	readonly serverId: string;
	state: ConnectionState = "disconnected";
	lastError?: string;
	/** Error of the last agent link attempt (SSH itself may be fine). */
	agentError?: string;
	latencyMs?: number;
	connectedAt?: number;
	agentClient: LinkAgentClient | null = null;

	private readonly log: Logger;
	private readonly options: Required<Omit<ServerConnectionOptions, "timings">> & { timings: SshTimings };
	private slots: Semaphore;
	private clients: Client[] = [];
	private generation = 0;
	private sshPromise?: Promise<void>;
	private agentPromise?: Promise<LinkAgentClient>;
	private sftpPromise?: Promise<SFTPWrapper | null>;
	private autoReconnect = false;
	private agentWanted = false;
	private closing = false;
	/**
	 * Bumped by disconnect()/dispose() (SSH) and disconnectAgent() (link): an attempt that was in
	 * flight when the user cancelled must not bring the session or the link back afterwards.
	 */
	private sshEpoch = 0;
	private agentEpoch = 0;
	private disposed = false;
	private reconnectTimer?: NodeJS.Timeout;
	private reconnectAttempt = 0;
	private linkTimer?: NodeJS.Timeout;
	private linkAttempt = 0;
	private pingTimer?: NodeJS.Timeout;
	/** Settings (all hops) the current SSH session was opened with. */
	private connectedKey?: string;
	private refreshChain: Promise<void> = Promise.resolve();

	constructor(private readonly deps: ServerConnectionDeps) {
		super();
		this.serverId = deps.serverId;
		this.log = deps.log;
		const o = deps.options ?? {};
		this.options = {
			timings: o.timings ?? DEFAULT_SSH_TIMINGS,
			linkTimeoutMs: o.linkTimeoutMs ?? 20_000,
			pingIntervalMs: o.pingIntervalMs ?? 15_000,
			minBackoffMs: o.minBackoffMs ?? 2_000,
			maxBackoffMs: o.maxBackoffMs ?? 60_000,
			maxConcurrentExec: o.maxConcurrentExec ?? 4,
			disableSftp: o.disableSftp ?? false,
		};
		this.slots = new Semaphore(this.options.maxConcurrentExec);
	}

	get sshConnected(): boolean {
		return this.state === "connected" && this.clients.length > 0;
	}

	get hello(): AgentHelloResult | undefined {
		return this.agentClient?.hello;
	}

	/** Enables reconnects (SSH and link) after unexpected disconnects. */
	setAutoReconnect(enabled: boolean): void {
		this.autoReconnect = enabled;
		if (!enabled) this.clearTimers();
	}

	/** Forgets the last error (e.g. after the user trusted a new host key). */
	clearError(): void {
		if (this.state === "error") this.setState("disconnected");
		this.lastError = undefined;
		this.agentError = undefined;
		this.emit("change");
	}

	ensureSsh(): Promise<void> {
		if (this.disposed) return Promise.reject(connectionRemoved());
		if (this.sshConnected) return Promise.resolve();
		if (!this.sshPromise) {
			const promise: Promise<void> = this.connectSsh().finally(() => {
				if (this.sshPromise === promise) this.sshPromise = undefined;
			});
			this.sshPromise = promise;
		}
		return this.sshPromise;
	}

	private async connectSsh(): Promise<void> {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		const epoch = this.sshEpoch;
		this.setState("connecting");
		try {
			const server = this.deps.store.getServer(this.serverId);
			if (!server) throw serverNotFound(this.serverId);
			const hops = await resolveHops(server, this.deps.store, this.deps.secrets);
			if (epoch !== this.sshEpoch) throw connectCancelled();
			const clients = await connectChain(hops, { timings: this.options.timings, log: this.log });
			if (epoch !== this.sshEpoch) {
				// Disconnected (or removed) while the chain was connecting: do not resurrect the session.
				for (const client of [...clients].reverse()) {
					try {
						client.end();
					} catch {
						// ignore
					}
				}
				throw connectCancelled();
			}
			const generation = ++this.generation;
			this.clients = clients;
			this.connectedKey = hopsKey(hops);
			for (const client of clients) {
				client.on("close", () => this.onSshClosed(generation));
			}
			this.connectedAt = Date.now();
			this.lastError = undefined;
			this.reconnectAttempt = 0;
			this.log.info("ssh connected", { host: server.host, port: server.port, hops: hops.length });
			this.setState("connected");
		} catch (err) {
			if (errorCode(err) === "CANCELLED") {
				this.log.info("ssh connect cancelled");
				// Unless a newer attempt is already under way, the session is down.
				if (!this.sshPromise && !this.sshConnected && this.state !== "disconnected") this.setState("disconnected");
				throw err;
			}
			this.lastError = errorMessage(err);
			this.log.warn("ssh connect failed", { error: this.lastError, code: errorCode(err) });
			this.setState("error");
			if (!isPermanentSshError(err)) this.scheduleReconnect();
			throw err;
		}
	}

	/** Identity of what a new SSH session would use now; undefined when the settings are unusable. */
	private async currentKey(): Promise<string | undefined> {
		const server = this.deps.store.getServer(this.serverId);
		if (!server) return undefined;
		try {
			return hopsKey(await resolveHops(server, this.deps.store, this.deps.secrets));
		} catch {
			return undefined;
		}
	}

	/**
	 * Re-opens the SSH session when its settings (including stored secrets) changed since it was
	 * opened; called by the manager whenever a server is saved. The agent link follows when it
	 * was wanted. This is the only reconnect a settings change needs.
	 */
	refreshSettings(): Promise<void> {
		// Serialized: quick successive saves must not interleave two reconnects.
		const next = this.refreshChain.then(() => this.refreshSettingsNow());
		this.refreshChain = next.catch(() => {});
		return next;
	}

	private async refreshSettingsNow(): Promise<void> {
		if (!this.sshConnected) return;
		const connectedKey = this.connectedKey;
		const key = await this.currentKey();
		if (key === connectedKey || !this.sshConnected || this.connectedKey !== connectedKey) return;
		this.log.info("connection settings changed; reconnecting");
		const autoReconnect = this.autoReconnect;
		const agentWanted = this.agentWanted;
		await this.disconnect();
		this.autoReconnect = autoReconnect;
		this.agentWanted = agentWanted;
		if (autoReconnect) await this.reconnect();
	}

	private onSshClosed(generation: number): void {
		if (generation !== this.generation) return;
		this.generation++;
		const clients = this.clients;
		this.clients = [];
		for (const client of clients) {
			try {
				client.end();
			} catch {
				// ignore
			}
		}
		this.sftpPromise = undefined;
		this.connectedAt = undefined;
		this.stopPing();
		this.slots.abandon();
		this.slots = new Semaphore(this.options.maxConcurrentExec);
		if (this.closing) {
			this.setState("disconnected");
			return;
		}
		this.log.warn("ssh connection closed");
		this.lastError = "SSH 连接已断开";
		this.setState("disconnected");
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (!this.autoReconnect || this.closing || this.reconnectTimer) return;
		const delay = Math.min(this.options.maxBackoffMs, this.options.minBackoffMs * 2 ** this.reconnectAttempt);
		this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.reconnect();
		}, delay);
		this.reconnectTimer.unref?.();
	}

	private async reconnect(): Promise<void> {
		if (!this.autoReconnect) return;
		try {
			await this.ensureSsh();
			if (this.agentWanted && this.deps.store.getServer(this.serverId)?.deployed) await this.agent();
		} catch {
			// state/lastError already updated; further retries are scheduled by the failing step
		}
	}

	private targetClient(): Client {
		const client = this.clients[this.clients.length - 1];
		if (!client || !this.sshConnected) throw new ApiError(503, "NOT_CONNECTED", "服务器未连接");
		return client;
	}

	private setState(state: ConnectionState): void {
		if (this.state === state) {
			this.emit("change");
			return;
		}
		this.state = state;
		this.emit("state", state);
		this.emit("change");
	}

	private clearTimers(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.linkTimer) clearTimeout(this.linkTimer);
		this.reconnectTimer = undefined;
		this.linkTimer = undefined;
	}

	// ---- exec ----

	private openChannelOnce(command: string, options?: { pty?: { cols: number; rows: number; term: string } }): Promise<ClientChannel> {
		const client = this.targetClient();
		return new Promise((resolve, reject) => {
			const callback = (err: Error | undefined, channel: ClientChannel) => {
				if (err) reject(err);
				else resolve(channel);
			};
			if (options?.pty) client.exec(command, { pty: options.pty }, callback);
			else client.exec(command, callback);
		});
	}

	/** Opens an exec channel, retrying briefly when the server refuses (e.g. MaxSessions reached). */
	private async openChannel(command: string, options?: { pty?: { cols: number; rows: number; term: string } }): Promise<ClientChannel> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.openChannelOnce(command, options);
			} catch (err) {
				const message = errorMessage(err);
				if (attempt < 5 && /Channel open failure/i.test(message) && this.sshConnected) {
					await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
					continue;
				}
				throw err instanceof ApiError ? err : new ApiError(502, "SSH_CHANNEL_FAILED", `无法打开 SSH 通道：${message}`);
			}
		}
	}

	/** Like exec() but returns raw buffers. */
	async execBuffer(command: string, options: ExecOptions = {}): Promise<ExecBufferResult> {
		await this.ensureSsh();
		const timeoutMs = options.timeoutMs ?? 120_000;
		const maxOutput = options.maxOutputBytes ?? 16 * 1024 * 1024;
		const release = await this.slots.acquire();
		let channel: ClientChannel;
		try {
			channel = await this.openChannel(command);
		} catch (err) {
			release();
			throw err;
		}
		// The slot is held until the server closes the channel (also after a timeout).
		channel.once("close", release);
		return new Promise<ExecBufferResult>((resolve, reject) => {
			const stdout = new CappedBuffer(maxOutput);
			const stderr = new CappedBuffer(maxOutput);
			let code: number | null = null;
			let signal: string | undefined;
			let settled = false;
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							settled = true;
							try {
								channel.signal("KILL");
							} catch {
								// ignore
							}
							channel.close();
							// sshd may only close the channel once the command exits; do not wait for it.
							reject(new ApiError(504, "TIMEOUT", `远程命令执行超时（${Math.round(timeoutMs / 1000)}s）`));
						}, timeoutMs)
					: undefined;
			channel.on("data", (chunk: Buffer) => stdout.push(chunk));
			channel.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			channel.on("exit", (exitCode: number | null, signalName?: string) => {
				code = typeof exitCode === "number" ? exitCode : null;
				if (signalName) signal = signalName;
			});
			channel.on("error", () => {});
			channel.on("close", (closeCode?: number | null, closeSignal?: string) => {
				if (timer) clearTimeout(timer);
				if (settled) return;
				settled = true;
				// A fast command's exit-status can arrive in the same read as the exec reply, i.e.
				// before the "exit" listener above exists; ssh2 repeats it as the "close" arguments.
				if (code === null && typeof closeCode === "number") code = closeCode;
				if (!signal && closeSignal) signal = closeSignal;
				resolve({ stdout: stdout.toBuffer(), stderr: stderr.toBuffer(), code, ...(signal ? { signal } : {}) });
			});
			if (options.stdin !== undefined) channel.end(options.stdin);
			else channel.end();
		});
	}

	async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const result = await this.execBuffer(command, options);
		return {
			stdout: result.stdout.toString("utf8"),
			stderr: result.stderr.toString("utf8"),
			code: result.code,
			...(result.signal ? { signal: result.signal } : {}),
		};
	}

	/** exec() that throws REMOTE_COMMAND_FAILED on a non-zero exit status. */
	async execChecked(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const result = await this.exec(command, options);
		if (result.code !== 0) {
			throw new ApiError(
				502,
				"REMOTE_COMMAND_FAILED",
				`远程命令失败（退出码 ${result.code ?? result.signal}）：${tailText(result.stderr.trim() || result.stdout.trim(), 2000)}`,
				{ code: result.code, stderr: tailText(result.stderr, 4000) },
			);
		}
		return result;
	}

	// ---- SFTP & file transfer ----

	private getSftp(): Promise<SFTPWrapper | null> {
		if (this.options.disableSftp) return Promise.resolve(null);
		if (!this.sftpPromise) {
			const client = this.targetClient();
			const promise = new Promise<SFTPWrapper | null>((resolve) => {
				client.sftp((err, sftp) => {
					if (err) {
						this.log.debug("sftp unavailable", { error: err.message });
						resolve(null);
						return;
					}
					sftp.on("error", () => {});
					sftp.on("close", () => {
						if (this.sftpPromise === promise) this.sftpPromise = undefined;
					});
					resolve(sftp);
				});
			});
			this.sftpPromise = promise;
		}
		return this.sftpPromise;
	}

	/** Whether the SFTP subsystem can be opened on this server. */
	async sftpAvailable(): Promise<boolean> {
		await this.ensureSsh();
		return (await this.getSftp()) !== null;
	}

	async upload(localPath: string, remotePath: string, options: UploadOptions = {}): Promise<void> {
		await this.ensureSsh();
		const { size } = await stat(localPath);
		if (options.signal?.aborted) throw abortError();
		await this.execChecked(`mkdir -p ${shPath(posix.dirname(remotePath))}`);
		const sftp = await this.getSftp();
		if (sftp) {
			try {
				await this.sftpPut(sftp, localPath, remotePath, size, options);
				return;
			} catch (err) {
				if (options.signal?.aborted) throw abortError();
				this.log.warn("sftp upload failed; falling back to exec", { remotePath, error: errorMessage(err) });
			}
		}
		await this.execUpload(localPath, remotePath, size, options);
	}

	private sftpPut(sftp: SFTPWrapper, localPath: string, remotePath: string, size: number, options: UploadOptions): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (err?: unknown) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", onAbort);
				if (err) reject(err);
				else {
					options.onProgress?.(size, size);
					resolve();
				}
			};
			const onAbort = () => {
				// Ending the session is the only way to interrupt fastPut; do not wait for it.
				this.sftpPromise = undefined;
				try {
					sftp.end();
				} catch {
					// ignore
				}
				finish(abortError());
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			options.onProgress?.(0, size);
			sftp.fastPut(
				localPath,
				sftpPath(remotePath),
				{
					...(options.mode !== undefined ? { mode: options.mode } : {}),
					step: (transferred: number, _chunk: number, total: number) => {
						if (!settled) options.onProgress?.(transferred, total);
					},
				},
				(err) => {
					if (err || options.mode === undefined) {
						finish(err);
						return;
					}
					sftp.chmod(sftpPath(remotePath), options.mode, (chmodErr) => finish(chmodErr));
				},
			);
		});
	}

	private async execUpload(localPath: string, remotePath: string, size: number, options: UploadOptions): Promise<void> {
		const part = shPath(`${remotePath}.part`);
		const chmod = options.mode !== undefined ? `chmod ${options.mode.toString(8)} ${part} && ` : "";
		// The size check keeps a truncated stream (cancelled upload) from replacing the target.
		const command =
			`mkdir -p ${shPath(posix.dirname(remotePath))} && cat > ${part} && ` +
			`if [ "$(wc -c < ${part} | tr -d ' ')" = ${size} ]; then ${chmod}mv -f ${part} ${shPath(remotePath)}; ` +
			`else rm -f ${part}; echo "size mismatch" >&2; exit 3; fi`;
		const release = await this.slots.acquire();
		let channel: ClientChannel;
		try {
			channel = await this.openChannel(command);
		} catch (err) {
			release();
			throw err;
		}
		channel.once("close", release);
		await new Promise<void>((resolve, reject) => {
			const input = createLocalReadStream(localPath);
			let sent = 0;
			let code: number | null = null;
			let stderr = "";
			let settled = false;
			const finish = (err?: unknown) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", onAbort);
				if (err) reject(err);
				else resolve();
			};
			const onAbort = () => {
				input.destroy();
				channel.close();
				finish(abortError());
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			options.onProgress?.(0, size);
			input.on("data", (chunk) => {
				sent += chunk.length;
				if (!settled) options.onProgress?.(sent, size);
			});
			input.on("error", (err) => {
				channel.close();
				finish(err);
			});
			channel.stderr.on("data", (chunk: Buffer) => {
				stderr = tailText(stderr + chunk.toString("utf8"), 4000);
			});
			channel.on("exit", (exitCode: number | null) => {
				code = exitCode;
			});
			channel.on("error", () => {});
			// ssh2 emits "close" only after the readable side ended, so stdout must flow.
			channel.resume();
			channel.on("close", (closeCode?: number | null) => {
				// ssh2 repeats the exit status as the "close" arguments (see execBuffer).
				if (code === null && typeof closeCode === "number") code = closeCode;
				if (code !== 0) finish(new ApiError(502, "UPLOAD_FAILED", `上传失败：${stderr.trim() || `退出码 ${code}`}`));
				else finish();
			});
			input.pipe(channel);
		});
	}

	async writeFile(remotePath: string, content: string | Buffer, options: { mode?: number } = {}): Promise<void> {
		const target = shPath(remotePath);
		// "<quoted path>.part".$$ — the shell appends its pid to keep concurrent writers apart.
		const tmp = `${shPath(`${remotePath}.part`)}.$$`;
		const chmod = options.mode !== undefined ? ` && chmod ${options.mode.toString(8)} ${tmp}` : "";
		await this.execChecked(
			`umask 077; mkdir -p ${shPath(posix.dirname(remotePath))} && cat > ${tmp}${chmod} && mv -f ${tmp} ${target}`,
			{ stdin: content },
		);
	}

	async readFile(remotePath: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
		const command =
			options.maxBytes !== undefined ? `head -c ${Math.max(0, Math.floor(options.maxBytes))} -- ${shPath(remotePath)}` : `cat -- ${shPath(remotePath)}`;
		const result = await this.execBuffer(command, {
			maxOutputBytes: options.maxBytes !== undefined ? options.maxBytes : 256 * 1024 * 1024,
			timeoutMs: 300_000,
		});
		if (result.code !== 0) {
			throw new ApiError(404, "REMOTE_READ_FAILED", `读取远程文件失败：${remotePath}：${result.stderr.toString("utf8").trim()}`);
		}
		return result.stdout;
	}

	async createReadStream(remotePath: string): Promise<{ stream: Readable; size: number }> {
		await this.ensureSsh();
		const sftp = await this.getSftp();
		if (sftp) {
			try {
				const size = await new Promise<number>((resolve, reject) =>
					sftp.stat(sftpPath(remotePath), (err, attrs) => (err ? reject(err) : resolve(attrs.size))),
				);
				return { stream: sftp.createReadStream(sftpPath(remotePath)), size };
			} catch (err) {
				this.log.debug("sftp stat failed; falling back to exec", { remotePath, error: errorMessage(err) });
			}
		}
		const sizeResult = await this.exec(`wc -c < ${shPath(remotePath)}`);
		const size = Number(sizeResult.stdout.trim());
		if (sizeResult.code !== 0 || !Number.isFinite(size)) {
			throw new ApiError(404, "REMOTE_READ_FAILED", `读取远程文件失败：${remotePath}：${sizeResult.stderr.trim()}`);
		}
		const release = await this.slots.acquire();
		try {
			const channel = await this.openChannel(`cat -- ${shPath(remotePath)}`);
			channel.on("close", release);
			channel.end();
			return { stream: channel, size };
		} catch (err) {
			release();
			throw err;
		}
	}

	async openPty(options: { command: string; cols: number; rows: number; term?: string }): Promise<ClientChannel> {
		await this.ensureSsh();
		return this.openChannel(options.command, {
			pty: { cols: options.cols, rows: options.rows, term: options.term ?? "xterm-256color" },
		});
	}

	// ---- agent link ----

	agent(): Promise<LinkAgentClient> {
		if (this.disposed) return Promise.reject(connectionRemoved());
		if (this.agentClient && !this.agentClient.isClosed) return Promise.resolve(this.agentClient);
		this.agentWanted = true;
		if (this.linkTimer) {
			clearTimeout(this.linkTimer);
			this.linkTimer = undefined;
		}
		if (!this.agentPromise) {
			const promise: Promise<LinkAgentClient> = this.connectAgent().finally(() => {
				if (this.agentPromise === promise) this.agentPromise = undefined;
			});
			this.agentPromise = promise;
		}
		return this.agentPromise;
	}

	private async connectAgent(): Promise<LinkAgentClient> {
		const epoch = this.agentEpoch;
		const server = this.deps.store.getServer(this.serverId);
		if (!server) throw serverNotFound(this.serverId);
		if (!server.deployed) throw new ApiError(409, "NOT_DEPLOYED", "服务器尚未部署 Pi-Web");
		await this.ensureSsh();
		// disconnectAgent() (stop/uninstall) while SSH was coming up: do not start a bridge (and daemon).
		if (epoch !== this.agentEpoch) throw connectCancelled();
		try {
			const client = await this.openLink(server.deployed.remoteRoot, true, () => epoch !== this.agentEpoch);
			if (epoch !== this.agentEpoch) {
				client.close();
				throw connectCancelled();
			}
			this.agentError = undefined;
			this.linkAttempt = 0;
			this.agentClient = client;
			client.once("close", (err?: Error) => this.onAgentClosed(client, err));
			this.startPing(client);
			this.log.info("agent link established", { agentVersion: client.hello.agentVersion, pid: client.hello.pid });
			this.emit("agent", client);
			this.emit("change");
			return client;
		} catch (err) {
			if (errorCode(err) === "CANCELLED") {
				this.log.info("agent link cancelled");
				throw err;
			}
			this.agentError = errorMessage(err);
			this.log.warn("agent link failed", { error: this.agentError });
			this.emit("change");
			this.scheduleLinkReconnect();
			throw err;
		}
	}

	/**
	 * Opens an additional link that is not published: no agent.configure, no "agent"
	 * event, no reconnects. Used to talk to a daemon that is about to be replaced.
	 */
	async openRawLink(): Promise<LinkAgentClient> {
		const server = this.deps.store.getServer(this.serverId);
		if (!server) throw serverNotFound(this.serverId);
		if (!server.deployed) throw new ApiError(409, "NOT_DEPLOYED", "服务器尚未部署 Pi-Web");
		await this.ensureSsh();
		return this.openLink(server.deployed.remoteRoot, false);
	}

	private async openLink(remoteRoot: string, publish = true, cancelled: () => boolean = () => false): Promise<LinkAgentClient> {
		const node = `${remoteRoot}/runtime/current/bin/node`;
		const bridge = `${remoteRoot}/daemon/bridge.mjs`;
		const command = `${shellQuote(node)} ${shellQuote(bridge)} --root ${shellQuote(remoteRoot)}`;
		const channel = await this.openChannel(command);
		let stderr = "";
		let exitCode: number | null | undefined;
		channel.stderr.on("data", (chunk: Buffer) => {
			stderr = tailText(stderr + chunk.toString("utf8"), 8192);
		});
		channel.on("exit", (code: number | null) => {
			exitCode = code;
		});
		const peer = new LinkPeer(channel, { side: "host", preamble: LINK_PREAMBLE });
		const fail = (reason: string, code = "AGENT_LINK_FAILED"): ApiError => {
			peer.destroy();
			const detail = [stderr.trim(), peer.preambleJunk.trim()].filter(Boolean).join("\n");
			return new ApiError(502, code, `无法连接 Remote Agent：${reason}${detail ? `\n${tailText(detail, 2000)}` : ""}`, {
				stderr: tailText(stderr, 4000),
				preambleJunk: tailText(peer.preambleJunk, 4000),
				exitCode,
			});
		};
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				peer.ready,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("timeout")), this.options.linkTimeoutMs);
				}),
			]);
		} catch (err) {
			// Give a failing bridge a moment to flush its stderr before reporting.
			await new Promise((resolve) => setTimeout(resolve, 100));
			const reason =
				errorMessage(err) === "timeout"
					? `等待 bridge 响应超时（${Math.round(this.options.linkTimeoutMs / 1000)}s）`
					: `bridge 已退出${exitCode !== undefined ? `（退出码 ${exitCode}）` : ""}`;
			throw fail(reason);
		} finally {
			if (timer) clearTimeout(timer);
		}
		let hello: AgentHelloResult;
		try {
			hello = await peer.request<AgentHelloResult>(
				"hello",
				{ hostVersion: this.deps.hostVersion, protocol: AGENT_PROTOCOL_VERSION },
				{ timeoutMs: 20_000 },
			);
		} catch (err) {
			throw fail(`hello 失败：${errorMessage(err)}`, "AGENT_HELLO_FAILED");
		}
		const client = new LinkAgentClient(this.serverId, peer, hello);
		channel.stderr.on("data", (chunk: Buffer) => {
			this.log.debug("bridge stderr", { text: tailText(chunk.toString("utf8"), 1000) });
		});
		if (cancelled()) {
			client.close();
			throw connectCancelled();
		}
		try {
			if (publish) await this.deps.onAgentLink?.(client);
		} catch (err) {
			client.close();
			throw err instanceof ApiError ? err : new ApiError(502, "AGENT_CONFIGURE_FAILED", `配置 Remote Agent 失败：${errorMessage(err)}`);
		}
		if (client.isClosed) throw fail("连接在初始化期间断开");
		return client;
	}

	private onAgentClosed(client: LinkAgentClient, err?: Error): void {
		if (this.agentClient !== client) return;
		this.agentClient = null;
		this.latencyMs = undefined;
		this.stopPing();
		this.log.info("agent link closed", { error: err?.message });
		this.emit("agent", null);
		this.emit("change");
		this.scheduleLinkReconnect();
	}

	private scheduleLinkReconnect(): void {
		if (!this.autoReconnect || !this.agentWanted || this.closing || this.linkTimer) return;
		if (!this.sshConnected) return; // the SSH reconnect will bring the link back
		const delay = Math.min(this.options.maxBackoffMs, this.options.minBackoffMs * 2 ** this.linkAttempt);
		this.linkAttempt++;
		this.linkTimer = setTimeout(() => {
			this.linkTimer = undefined;
			if (!this.agentWanted || !this.autoReconnect) return;
			this.agent().catch(() => {});
		}, delay);
		this.linkTimer.unref?.();
	}

	private startPing(client: LinkAgentClient): void {
		this.stopPing();
		let failures = 0;
		const ping = async () => {
			if (client.isClosed) return;
			const started = Date.now();
			try {
				await client.peer.request("link.ping", undefined, { timeoutMs: 10_000 });
				failures = 0;
				this.latencyMs = Date.now() - started;
				this.emit("change");
			} catch {
				// The reply may sit behind a large message on the single ordered stream: bytes that
				// kept arriving during the ping window prove the link is alive.
				if (client.peer.lastReceivedAt >= started) {
					failures = 0;
					return;
				}
				failures++;
				if (failures >= 3 && !client.isClosed) client.peer.destroy(new Error("link ping timeout"));
			}
		};
		void ping();
		this.pingTimer = setInterval(() => void ping(), this.options.pingIntervalMs);
		this.pingTimer.unref?.();
	}

	private stopPing(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = undefined;
	}

	disconnectAgent(): void {
		this.agentEpoch++;
		// An attempt in flight is cancelled; the next agent() call starts a fresh one.
		this.agentPromise = undefined;
		this.agentWanted = false;
		if (this.linkTimer) clearTimeout(this.linkTimer);
		this.linkTimer = undefined;
		this.agentClient?.close();
	}

	/** The connection was removed from the manager: disconnect and refuse any later use. */
	dispose(): Promise<void> {
		this.disposed = true;
		return this.disconnect();
	}

	async disconnect(): Promise<void> {
		this.sshEpoch++;
		this.sshPromise = undefined;
		this.autoReconnect = false;
		this.clearTimers();
		this.disconnectAgent();
		const clients = this.clients;
		if (clients.length === 0) {
			if (this.state !== "disconnected") this.setState("disconnected");
			return;
		}
		this.closing = true;
		try {
			const target = clients[clients.length - 1];
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 3000);
				target.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
				for (const client of [...clients].reverse()) client.end();
			});
			// Close event did not arrive in time: clean up ourselves.
			if (this.clients === clients) this.onSshClosed(this.generation);
		} finally {
			this.closing = false;
		}
		this.lastError = undefined;
		if (this.state !== "disconnected") this.setState("disconnected");
	}
}
