import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path, { posix } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type {
	AgentConfig,
	CacheEntry,
	CacheResponse,
	DeployedInfo,
	DeployProgress,
	DeployRequest,
	DeployStep,
	DeployStepId,
	ProbeResult,
	ServerConfig,
	UninstallRequest,
} from "@pi-web/shared";
import { ApiError, badRequest, conflict, errorCode, errorMessage, serverNotFound } from "../core/errors.js";
import { secretKeys } from "../core/secrets.js";
import { KeyedQueue } from "../core/store.js";
import type {
	AgentClient,
	ConnectionManager,
	Deployer,
	HostPaths,
	HostPi,
	Logger,
	Secrets,
	ServerConnection,
	Store,
	Syncer,
} from "../core/types.js";
import { shPath } from "../ssh/remote-path.js";
import { BundleCache, type AgentBundle, type NodeArch, type NodeBundle, type PiBundle } from "./bundles.js";
import {
	PI_PACKAGE,
	installScript,
	parseKeyValues,
	parseProbeOutput,
	piCliRelative,
	probeScript,
	proxyCheckCommand,
	toProbeResult,
	uninstallScript,
	waitPidScript,
	type RemoteProbe,
} from "./scripts.js";

/** The parts of AppContext the deployer needs; `syncer` and `hostPi` are optional and read lazily. */
export interface DeployerContext {
	readonly version: string;
	readonly paths: HostPaths;
	readonly log: Logger;
	readonly store: Store;
	readonly secrets: Secrets;
	readonly connections: ConnectionManager;
	readonly hostPi?: Pick<HostPi, "version">;
	readonly syncer?: Pick<Syncer, "run">;
}

/** Optional extras implemented by SshServerConnection. */
type DeployConnection = ServerConnection & {
	sftpAvailable?: () => Promise<boolean>;
	openRawLink?: () => Promise<AgentClient>;
};

export const STEP_LABELS: Record<DeployStepId, string> = {
	probe: "探测服务器",
	prepare: "准备离线包",
	upload_node: "上传 Node.js 运行时",
	upload_pi: "上传 pi",
	upload_agent: "上传 Remote Agent",
	install: "安装",
	start_agent: "启动 Remote Agent",
	sync: "同步配置",
	selfcheck: "自检",
};

const STEP_ORDER: DeployStepId[] = [
	"probe",
	"prepare",
	"upload_node",
	"upload_pi",
	"upload_agent",
	"install",
	"start_agent",
	"sync",
	"selfcheck",
];

const MAX_LOG_LINES = 200;
const PROGRESS_THROTTLE_MS = 250;

interface Job {
	progress: DeployProgress;
	controller: AbortController;
	lastEmit: number;
	emitTimer?: NodeJS.Timeout;
}

function cancelledError(): ApiError {
	return new ApiError(499, "CANCELLED", "部署已取消");
}

function timeStamp(date = new Date()): string {
	return date.toTimeString().slice(0, 8);
}

function compactTimestamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function lastLine(text: string): string {
	return text.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
}

/** Finds the installed @earendil-works/pi-coding-agent package.json by walking up node_modules. */
function bundledPiVersion(): string | null {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		const file = path.join(dir, "node_modules", PI_PACKAGE, "package.json");
		if (existsSync(file)) {
			try {
				return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? null;
			} catch {
				return null;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** `pi --version` from PATH, else the version of the bundled dependency. */
export async function detectHostPiVersion(): Promise<string | null> {
	const fromPath = await new Promise<string | null>((resolve) => {
		execFile("pi", ["--version"], { timeout: 15_000, env: { ...process.env, PI_OFFLINE: "1" } }, (err, stdout) => {
			if (err) resolve(null);
			else resolve(/\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(stdout)?.[0] ?? null);
		});
	});
	return fromPath ?? bundledPiVersion();
}

export class PiWebDeployer extends EventEmitter implements Deployer {
	readonly bundles: BundleCache;
	private readonly jobs = new Map<string, Job>();
	private readonly tokenQueue = new KeyedQueue();
	private readonly log: Logger;
	private versionCache?: { mtimeMs: number; version: string };

	constructor(private readonly ctx: DeployerContext) {
		super();
		this.log = ctx.log.child("deploy");
		this.bundles = new BundleCache({
			paths: ctx.paths,
			getSettings: () => ctx.store.getSettings(),
			log: this.log,
		});
	}

	/** Version of the bundled agent (agentDistDir/VERSION); "" when the agent has not been built. */
	get agentVersion(): string {
		const file = path.join(this.ctx.paths.agentDistDir, "VERSION");
		try {
			const { mtimeMs } = statSync(file);
			if (this.versionCache?.mtimeMs === mtimeMs) return this.versionCache.version;
			const version = readFileSync(file, "utf8").trim();
			this.versionCache = { mtimeMs, version };
			return version;
		} catch {
			return "";
		}
	}

	private server(serverId: string): ServerConfig {
		const server = this.ctx.store.getServer(serverId);
		if (!server) throw serverNotFound(serverId);
		return server;
	}

	private conn(serverId: string): DeployConnection {
		return this.ctx.connections.get(serverId) as DeployConnection;
	}

	// ---------------------------------------------------------------------
	// probe
	// ---------------------------------------------------------------------

	async probe(serverId: string): Promise<ProbeResult> {
		return toProbeResult(await this.runProbe(serverId));
	}

	private async runProbe(serverId: string): Promise<RemoteProbe> {
		const server = this.server(serverId);
		const conn = this.conn(serverId);
		await conn.ensureSsh();
		const result = await conn.exec("sh -s", { stdin: probeScript(server.remoteRoot), timeoutMs: 60_000 });
		const sftp = conn.sftpAvailable ? await conn.sftpAvailable().catch(() => false) : true;
		try {
			return parseProbeOutput(result.stdout, sftp);
		} catch {
			throw new ApiError(502, "PROBE_FAILED", `探测服务器失败：${(result.stderr || result.stdout).trim().slice(-1000)}`);
		}
	}

	// ---------------------------------------------------------------------
	// deploy job
	// ---------------------------------------------------------------------

	deploy(serverId: string, request: DeployRequest = {}): DeployProgress {
		this.server(serverId);
		const existing = this.jobs.get(serverId);
		if (existing?.progress.state === "running") throw conflict("DEPLOY_RUNNING", "该服务器正在部署中");
		const job: Job = {
			progress: {
				serverId,
				jobId: randomUUID(),
				state: "running",
				steps: STEP_ORDER.map((id) => ({ id, label: STEP_LABELS[id], status: "pending" })),
				log: [],
				startedAt: Date.now(),
			},
			controller: new AbortController(),
			lastEmit: 0,
		};
		this.jobs.set(serverId, job);
		this.ctx.connections.updateStatus(serverId, { deployState: "deploying" });
		this.emitProgress(job, true);
		void this.runJob(job, request);
		return structuredClone(job.progress);
	}

	getJob(serverId: string): DeployProgress | undefined {
		const job = this.jobs.get(serverId);
		return job ? structuredClone(job.progress) : undefined;
	}

	cancel(serverId: string): void {
		const job = this.jobs.get(serverId);
		if (!job || job.progress.state !== "running") return;
		this.appendLog(job, "正在取消…");
		job.controller.abort();
	}

	private emitProgress(job: Job, force = false): void {
		const now = Date.now();
		if (!force && now - job.lastEmit < PROGRESS_THROTTLE_MS) {
			job.emitTimer ??= setTimeout(() => {
				job.emitTimer = undefined;
				this.emitProgress(job, true);
			}, PROGRESS_THROTTLE_MS);
			return;
		}
		if (job.emitTimer) {
			clearTimeout(job.emitTimer);
			job.emitTimer = undefined;
		}
		job.lastEmit = now;
		this.emit("progress", structuredClone(job.progress));
	}

	private appendLog(job: Job, line: string): void {
		job.progress.log.push(`[${timeStamp()}] ${line}`);
		if (job.progress.log.length > MAX_LOG_LINES) job.progress.log.splice(0, job.progress.log.length - MAX_LOG_LINES);
		this.log.info(line, { serverId: job.progress.serverId });
		this.emitProgress(job);
	}

	private stepOf(job: Job, id: DeployStepId): DeployStep {
		return job.progress.steps.find((step) => step.id === id)!;
	}

	private skip(job: Job, id: DeployStepId, detail: string): void {
		const step = this.stepOf(job, id);
		step.status = "skipped";
		step.detail = detail;
		this.appendLog(job, `${step.label}：跳过（${detail}）`);
		this.emitProgress(job, true);
	}

	private async step<T>(job: Job, id: DeployStepId, fn: (step: DeployStep) => Promise<T>): Promise<T> {
		if (job.controller.signal.aborted) throw cancelledError();
		const step = this.stepOf(job, id);
		step.status = "running";
		this.appendLog(job, `${step.label}…`);
		this.emitProgress(job, true);
		try {
			const result = await fn(step);
			if (job.controller.signal.aborted) throw cancelledError();
			if (step.status === "running") step.status = "done";
			this.emitProgress(job, true);
			return result;
		} catch (err) {
			const cancelled = job.controller.signal.aborted;
			step.status = "error";
			step.detail = cancelled ? "已取消" : errorMessage(err);
			this.emitProgress(job, true);
			throw cancelled ? cancelledError() : err;
		}
	}

	private uploadProgress(job: Job, step: DeployStep): (done: number, total: number) => void {
		return (done, total) => {
			step.bytesDone = done;
			step.bytesTotal = total;
			this.emitProgress(job);
		};
	}

	private async runJob(job: Job, request: DeployRequest): Promise<void> {
		const serverId = job.progress.serverId;
		const signal = job.controller.signal;
		const force = request.force === true;
		try {
			await this.applyRequest(serverId, request);

			const probe = await this.step(job, "probe", async (step) => {
				const result = await this.runProbe(serverId);
				for (const warning of result.warnings) this.appendLog(job, `警告：${warning}`);
				if (result.issues.length > 0) {
					throw new ApiError(400, "PROBE_FAILED", `服务器不满足部署条件：${result.issues.join("；")}`);
				}
				step.detail = `${result.os} ${result.arch} · glibc ${result.glibc} · ${result.home}`;
				return result;
			});
			const conn = this.conn(serverId);
			const arch = probe.nodeArch as NodeArch;
			const R = probe.remoteRoot;
			const home = probe.home;

			const prepared = await this.step(job, "prepare", async (step) => {
				const settings = this.ctx.store.getSettings();
				const nodeVersion = await this.bundles.resolveNodeVersion(settings.nodeVersion, arch, signal);
				let piVersion = request.piVersion?.trim() || (await this.targetPiVersion());
				if (!/^[\w.+-]+$/.test(piVersion)) throw badRequest(`无效的 pi 版本：${piVersion}`);
				const nodeDir = `node-v${nodeVersion}-linux-${arch}`;
				const log = (line: string) => this.appendLog(job, line);
				const progress = this.uploadProgress(job, step);
				let node: NodeBundle | undefined;
				if (force || !probe.installed.node.includes(nodeDir)) {
					node = await this.bundles.ensureNode(nodeVersion, arch, { log, progress, signal });
				}
				let pi: PiBundle | undefined;
				if (force || !probe.installed.pi.includes(piVersion)) {
					pi = await this.bundles.ensurePi(piVersion, { log, signal });
					piVersion = pi.version;
				}
				const agent = await this.bundles.ensureAgent(this.ctx.paths.agentDistDir);
				delete step.bytesDone;
				delete step.bytesTotal;
				step.detail = `Node.js ${nodeVersion} · pi ${piVersion} · agent ${agent.version}`;
				return { nodeVersion, nodeDir, piVersion, node, pi, agent };
			});

			const uploadDir = `${R}/.upload`;
			const upload = async (id: DeployStepId, bundle: NodeBundle | PiBundle | AgentBundle | undefined, skipDetail: string) => {
				if (!bundle) {
					this.skip(job, id, skipDetail);
					return undefined;
				}
				return this.step(job, id, async (step) => {
					const remote = `${uploadDir}/${bundle.name}`;
					await conn.upload(bundle.path, remote, { onProgress: this.uploadProgress(job, step), signal });
					step.detail = `${(bundle.bytes / 1024 / 1024).toFixed(1)} MB`;
					return { archive: remote, sha256: bundle.sha256 };
				});
			};
			const nodeUpload = await upload("upload_node", prepared.node, `已安装 Node.js ${prepared.nodeVersion}`);
			const piUpload = await upload("upload_pi", prepared.pi, `已安装 pi ${prepared.piVersion}`);
			const agentUpload = await upload("upload_agent", prepared.agent, "");

			const server = this.server(serverId);
			const agentDir = server.agentDirMode === "shared" ? posix.join(home, ".pi/agent") : `${R}/agent`;
			const deployed: DeployedInfo = {
				nodeVersion: prepared.nodeVersion,
				piVersion: prepared.piVersion,
				agentVersion: prepared.agent.version,
				arch,
				...(probe.glibc ? { glibc: probe.glibc } : {}),
				home,
				remoteRoot: R,
				agentDir,
				at: Date.now(),
			};

			await this.step(job, "install", async (step) => {
				const script = installScript({
					remoteRoot: R,
					agentDir,
					nodeDir: prepared.nodeDir,
					piVersion: prepared.piVersion,
					node: nodeUpload,
					pi: piUpload,
					agent: agentUpload,
					force,
				});
				const result = await conn.exec("sh -s", { stdin: script, timeoutMs: 15 * 60_000 });
				const kv = parseKeyValues(result.stdout);
				if (kv.install !== "ok") {
					throw new ApiError(502, "INSTALL_FAILED", `远程安装失败：${kv.error || lastLine(result.stderr) || `退出码 ${result.code}`}`);
				}
				// The installation exists from here on; agent() needs `deployed` to find it.
				await this.saveDeployed(serverId, deployed);
				step.detail = R;
			});

			const client = await this.step(job, "start_agent", async (step) => {
				const previous = probe.existing?.agentVersion;
				if (force || (previous && previous !== prepared.agent.version)) {
					this.appendLog(job, previous ? `停止旧版 Remote Agent（${previous}）` : "停止正在运行的 Remote Agent");
					await this.stopAgent(serverId);
				}
				await this.ctx.connections.connect(serverId);
				let agent = await conn.agent();
				if (agent.hello.agentVersion !== prepared.agent.version) {
					this.appendLog(job, `运行中的 agent 版本为 ${agent.hello.agentVersion}，重启以加载 ${prepared.agent.version}`);
					await this.stopAgent(serverId);
					await this.ctx.connections.connect(serverId);
					agent = await conn.agent();
				}
				step.detail = `pi-web-agent ${agent.hello.agentVersion}（pid ${agent.hello.pid}）`;
				return agent;
			});

			if (request.sync === false) this.skip(job, "sync", "未启用");
			else await this.runSyncStep(job, serverId);

			await this.step(job, "selfcheck", async (step) => {
				const details: string[] = [];
				const version = await conn.exec(`${shPath(`${R}/bin/pi`)} --version`, { timeoutMs: 120_000 });
				const printed = lastLine(version.stdout);
				if (version.code !== 0 || !printed.includes(prepared.piVersion)) {
					throw new ApiError(
						502,
						"SELFCHECK_FAILED",
						`pi --version 检查失败：${lastLine(version.stderr) || printed || `退出码 ${version.code}`}`,
					);
				}
				details.push(`pi ${printed}`);
				const status = await client.call("agent.status", {});
				details.push(`agent 运行 ${status.uptimeSec}s`);
				const current = this.server(serverId);
				if (current.proxy.mode === "tunnel") {
					const check = await this.checkProxy(serverId, R, current.proxy.port);
					if (check.ok) details.push("代理连通");
					else {
						details.push(`代理检查未通过：${check.line}`);
						this.appendLog(job, `警告：通过代理 CONNECT api.anthropic.com:443 未返回 200（${check.line}）`);
					}
				}
				step.detail = details.join(" · ");
			});

			const finished: DeployedInfo = { ...deployed, at: Date.now() };
			await this.saveDeployed(serverId, finished);
			job.progress.result = finished;
			job.progress.state = "done";
			this.appendLog(job, "部署完成");
		} catch (err) {
			const cancelled = signal.aborted || errorCode(err) === "CANCELLED";
			job.progress.state = cancelled ? "cancelled" : "error";
			job.progress.error = cancelled ? "部署已取消" : errorMessage(err);
			this.appendLog(job, cancelled ? "部署已取消" : `部署失败：${errorMessage(err)}`);
			if (!cancelled) this.log.warn("deploy failed", { serverId, error: errorMessage(err) });
		} finally {
			job.progress.finishedAt = Date.now();
			this.ctx.connections.updateStatus(serverId, { deployState: undefined });
			this.emitProgress(job, true);
		}
	}

	private async applyRequest(serverId: string, request: DeployRequest): Promise<void> {
		const server = this.server(serverId);
		let changed = false;
		if (request.agentDirMode && request.agentDirMode !== server.agentDirMode) {
			server.agentDirMode = request.agentDirMode;
			changed = true;
		}
		if (request.proxyMode && request.proxyMode !== server.proxy.mode) {
			server.proxy.mode = request.proxyMode;
			changed = true;
		}
		if (request.proxyScope && request.proxyScope !== server.proxy.scope) {
			server.proxy.scope = request.proxyScope;
			changed = true;
		}
		if (changed) {
			server.updatedAt = Date.now();
			await this.ctx.store.saveServer(server);
		}
	}

	private async saveDeployed(serverId: string, deployed: DeployedInfo): Promise<void> {
		const server = this.server(serverId);
		server.deployed = deployed;
		server.updatedAt = Date.now();
		await this.ctx.store.saveServer(server);
	}

	private async runSyncStep(job: Job, serverId: string): Promise<void> {
		const syncer = this.ctx.syncer;
		if (!syncer || typeof syncer.run !== "function") {
			this.skip(job, "sync", "同步模块不可用");
			return;
		}
		const step = this.stepOf(job, "sync");
		try {
			await this.step(job, "sync", async () => {
				const record = await syncer.run(serverId, "deploy");
				if (record.status === "error") throw new ApiError(502, "SYNC_FAILED", record.error ?? "同步失败");
				step.detail = `新增 ${record.added} · 更新 ${record.updated} · 删除 ${record.deleted}${record.conflicts ? ` · 冲突 ${record.conflicts}` : ""}`;
			});
		} catch (err) {
			if (errorCode(err) === "CANCELLED") throw err;
			// A failed sync does not invalidate the installation; it can be retried from the sync center.
			this.appendLog(job, `警告：配置同步失败：${errorMessage(err)}`);
		}
	}

	private async checkProxy(serverId: string, remoteRoot: string, port: number): Promise<{ ok: boolean; line: string }> {
		const token = await this.proxyToken(serverId);
		const result = await this.conn(serverId).exec(proxyCheckCommand(`${remoteRoot}/runtime/current/bin/node`, port), {
			stdin: token,
			timeoutMs: 30_000,
		});
		const line = lastLine(result.stdout) || lastLine(result.stderr) || `退出码 ${result.code}`;
		return { ok: /^HTTP\/1\.[01] 200/.test(line), line };
	}

	// ---------------------------------------------------------------------
	// agent lifecycle
	// ---------------------------------------------------------------------

	/** Asks the running daemon (if any) to shut down and waits for its process to exit. */
	private async stopAgent(serverId: string): Promise<void> {
		const server = this.server(serverId);
		const conn = this.conn(serverId);
		const remoteRoot = server.deployed?.remoteRoot;
		let client: AgentClient | null = conn.agentClient;
		let raw = false;
		if (!client && remoteRoot) {
			const sock = await conn.exec(`[ -S ${shPath(`${remoteRoot}/run/agent.sock`)} ] && echo yes || true`);
			if (sock.stdout.trim() !== "yes") return;
			try {
				client = conn.openRawLink ? await conn.openRawLink() : await conn.agent();
				raw = !!conn.openRawLink;
			} catch (err) {
				this.log.warn("could not reach the running agent to stop it", { serverId, error: errorMessage(err) });
				return;
			}
		}
		if (!client) return;
		const pid = client.hello.pid;
		try {
			await client.call("agent.shutdown", {}, { timeoutMs: 15_000 });
		} catch (err) {
			this.log.warn("agent.shutdown failed", { serverId, error: errorMessage(err) });
		}
		if (raw) client.close();
		conn.disconnectAgent();
		const wait = await conn.exec("sh -s", { stdin: waitPidScript(pid, 20), timeoutMs: 40_000 });
		if (parseKeyValues(wait.stdout).exited !== "1") {
			this.log.warn("agent did not exit in time; killing it", { serverId, pid });
			await conn.exec(`kill ${pid} 2>/dev/null; sleep 2; kill -9 ${pid} 2>/dev/null; true`, { timeoutMs: 20_000 });
		}
	}

	async restartAgent(serverId: string): Promise<void> {
		const server = this.server(serverId);
		if (!server.deployed) throw new ApiError(409, "NOT_DEPLOYED", "服务器尚未部署 Pi-Web");
		await this.conn(serverId).ensureSsh();
		await this.stopAgent(serverId);
		await this.ctx.connections.connect(serverId);
	}

	async uninstall(serverId: string, request: UninstallRequest): Promise<void> {
		const server = this.server(serverId);
		if (this.jobs.get(serverId)?.progress.state === "running") throw conflict("DEPLOY_RUNNING", "该服务器正在部署中");
		const conn = this.conn(serverId);
		await conn.ensureSsh();
		if (server.deployed) await this.stopAgent(serverId);
		conn.disconnectAgent();
		const remoteRoot = server.deployed?.remoteRoot ?? server.remoteRoot;
		const result = await conn.exec("sh -s", {
			stdin: uninstallScript({ remoteRoot, keepSessions: request.keepSessions, timestamp: compactTimestamp() }),
			timeoutMs: 5 * 60_000,
		});
		const kv = parseKeyValues(result.stdout);
		if (kv.uninstall !== "ok") {
			throw new ApiError(502, "UNINSTALL_FAILED", `卸载失败：${lastLine(result.stderr) || `退出码 ${result.code}`}`);
		}
		if (kv.backup) this.log.info("sessions backed up before uninstall", { serverId, backup: kv.backup });
		const fresh = this.server(serverId);
		delete fresh.deployed;
		fresh.updatedAt = Date.now();
		await this.ctx.store.saveServer(fresh);
		this.ctx.connections.updateStatus(serverId, { deployState: undefined });
	}

	// ---------------------------------------------------------------------
	// agent configuration
	// ---------------------------------------------------------------------

	private proxyToken(serverId: string): Promise<string> {
		return this.tokenQueue.run(serverId, async () => {
			const key = secretKeys.proxyToken(serverId);
			const existing = await this.ctx.secrets.get(key);
			if (existing) return existing;
			const token = randomBytes(32).toString("hex");
			await this.ctx.secrets.set(key, token);
			return token;
		});
	}

	async buildAgentConfig(serverId: string): Promise<AgentConfig> {
		const server = this.server(serverId);
		const deployed = server.deployed;
		if (!deployed) throw new ApiError(409, "NOT_DEPLOYED", "服务器尚未部署 Pi-Web");
		const R = deployed.remoteRoot;
		const settings = this.ctx.store.getSettings();
		const piPackageDir = `${R}/pi/current/node_modules/${PI_PACKAGE}`;
		return {
			remoteRoot: R,
			agentDir: server.agentDirMode === "shared" ? posix.join(deployed.home, ".pi/agent") : `${R}/agent`,
			nodePath: `${R}/runtime/current/bin/node`,
			piCliPath: `${R}/pi/current/${piCliRelative()}`,
			piPackageDir,
			piVersion: deployed.piVersion,
			companionExtPath: `${R}/daemon/pi-web-ext.mjs`,
			proxy: {
				enabled: server.proxy.mode === "tunnel",
				port: server.proxy.port,
				token: await this.proxyToken(serverId),
				scope: server.proxy.scope,
				noProxy: [...new Set([...(settings.defaultNoProxy ?? []), ...(server.proxy.noProxy ?? [])].filter(Boolean))],
			},
			idleTimeoutMin: server.idleTimeoutMin,
			extraEnv: {},
		};
	}

	async targetPiVersion(): Promise<string> {
		const settings = this.ctx.store.getSettings();
		if (settings.piVersionPolicy === "pinned") {
			const pinned = settings.piPinnedVersion?.trim();
			if (!pinned) throw badRequest("全局设置选择了指定 pi 版本，但未填写版本号");
			return pinned;
		}
		const fromHost = this.ctx.hostPi ? await this.ctx.hostPi.version().catch(() => null) : null;
		const version = fromHost ?? (await detectHostPiVersion());
		if (!version) throw new ApiError(500, "PI_VERSION_UNKNOWN", "无法确定 Host 上的 pi 版本，请在全局设置中指定版本");
		return version;
	}

	// ---------------------------------------------------------------------
	// cache
	// ---------------------------------------------------------------------

	async listCache(): Promise<CacheResponse> {
		const entries = await this.bundles.list();
		const servers = this.ctx.store.listServers();
		for (const entry of entries) {
			entry.usedBy = servers
				.filter((server) => {
					const d = server.deployed;
					if (!d) return false;
					if (entry.kind === "node") return d.nodeVersion === entry.version && d.arch === entry.arch;
					if (entry.kind === "pi") return d.piVersion === entry.version;
					return d.agentVersion === entry.version;
				})
				.map((server) => server.id);
		}
		return { entries, totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
	}

	deleteCache(name: string): Promise<void> {
		return this.bundles.delete(name);
	}

	importNodeTarball(fileName: string, data: Readable): Promise<CacheEntry> {
		return this.bundles.importNode(fileName, data);
	}
}

export function createDeployer(ctx: DeployerContext): PiWebDeployer {
	return new PiWebDeployer(ctx);
}

