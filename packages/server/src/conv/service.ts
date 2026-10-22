/**
 * ConversationService: the host-side registry of live pi conversation processes.
 * It mirrors the agents' ConvInfo, forwards conversation events to the EventHub
 * (`conv:<id>`, `convs`) and proxies conversation commands to the right agent.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { posix as posixPath } from "node:path";
import type { Readable } from "node:stream";
import { shellQuote } from "@pi-web/shared";
import type {
	CompanionActionResponse,
	ConvCompanionParams,
	ConvEvent,
	ConvInfo,
	ConversationSnapshot,
	ConversationView,
	ConvReplayResult,
	ConvStartParams,
	ExtensionUIResponse,
	OpenConversationRequest,
	RpcCommand,
	RpcResponse,
} from "@pi-web/shared";
import { ApiError } from "../core/types.js";
import type { AgentClient, AppContext, ConversationService, Logger } from "../core/types.js";

/** Services the conversation registry uses; read lazily so it can be built before its peers. */
export type ConversationDeps = Pick<AppContext, "store" | "connections" | "hub" | "syncer" | "log">;

export interface ConversationServiceOptions {
	/** How long exited conversations stay listed (the agent keeps them 10 min for replay). Default 10 min. */
	exitedRetentionMs?: number;
	/** How long open() waits for attach() after bringing the agent link up. Default 20s. */
	attachWaitMs?: number;
}

/** pi commands whose agent-side default timeout is 10 minutes (IMPLEMENTATION.md §2.5). */
const LONG_COMMANDS = new Set([
	"compact",
	"export_html",
	"abort",
	"bash",
	"fork",
	"clone",
	"new_session",
	"switch_session",
]);
const SHORT_TIMEOUT_MS = 60_000;
const LONG_TIMEOUT_MS = 10 * 60_000;
/** Extra time on the link call so the agent's own timeout fires first and reports a precise error. */
const LINK_MARGIN_MS = 10_000;
/** conv.start waits up to 60s for pi's get_state on the agent. */
const START_TIMEOUT_MS = 90_000;
const SNAPSHOT_TIMEOUT_MS = 120_000;

interface ConvEntry {
	convId: string;
	serverId: string;
	workspaceId: string | null;
	info: ConvInfo;
	/** info.startedAt translated to the host clock. */
	startedAtHost: number;
	/** Host time of the last successful companion reload. */
	reloadedAt?: number;
	removeTimer?: NodeJS.Timeout;
}

interface Attachment {
	serverId: string;
	client: AgentClient;
	listener: (name: string, data: unknown) => void;
	/** False while attach() replays missed events; live events are buffered meanwhile to keep seq order. */
	ready: boolean;
	buffer: ConvEvent[];
	/** Agent clock minus host clock, in ms. */
	clockOffsetMs: number;
}

export function createConversationService(
	deps: ConversationDeps,
	options: ConversationServiceOptions = {},
): ConversationService {
	return new ConversationRegistry(deps, options);
}

class ConversationRegistry implements ConversationService {
	private readonly convs = new Map<string, ConvEntry>();
	/** Last seq forwarded to the hub, per conversation. */
	private readonly seqs = new Map<string, number>();
	private readonly attachments = new Map<string, Attachment>();
	private readonly attachedSignal = new EventEmitter();
	private readonly exitedRetentionMs: number;
	private readonly attachWaitMs: number;
	private logger?: Logger;

	constructor(
		private readonly deps: ConversationDeps,
		options: ConversationServiceOptions,
	) {
		this.exitedRetentionMs = options.exitedRetentionMs ?? 10 * 60_000;
		this.attachWaitMs = options.attachWaitMs ?? 20_000;
		this.attachedSignal.setMaxListeners(0);
	}

	private get log(): Logger {
		this.logger ??= this.deps.log.child("conv");
		return this.logger;
	}

	// ---------------------------------------------------------------- attach

	async attach(serverId: string, client: AgentClient): Promise<void> {
		this.detach(serverId);
		const attachment: Attachment = {
			serverId,
			client,
			listener: (name, data) => this.onAgentEvent(attachment, name, data),
			ready: false,
			buffer: [],
			clockOffsetMs: 0,
		};
		client.on("event", attachment.listener);
		this.attachments.set(serverId, attachment);
		const current = () => this.attachments.get(serverId) === attachment;
		try {
			attachment.clockOffsetMs = await measureClockOffset(client);
			const { conversations } = await client.call("conv.list", undefined);
			if (!current()) return;
			const listed = new Set<string>();
			for (const info of conversations) {
				listed.add(info.convId);
				await this.resume(attachment, info);
				if (!current()) return;
			}
			for (const entry of [...this.convs.values()]) {
				if (entry.serverId === serverId && !listed.has(entry.convId) && entry.info.status !== "exited") {
					this.markGone(entry);
				}
			}
		} finally {
			if (current()) {
				attachment.ready = true;
				const buffered = attachment.buffer;
				attachment.buffer = [];
				for (const event of buffered) this.forward(event);
				this.updateCounts(serverId);
				this.attachedSignal.emit("attached", serverId, client);
			}
		}
	}

	detach(serverId: string): void {
		const attachment = this.attachments.get(serverId);
		if (!attachment) return;
		attachment.client.off("event", attachment.listener);
		this.attachments.delete(serverId);
	}

	/** Brings one conversation listed by the agent up to date (replaying events missed while the link was down). */
	private async resume(attachment: Attachment, info: ConvInfo): Promise<void> {
		const known = this.convs.has(info.convId) ? this.seqs.get(info.convId) : undefined;
		if (known !== undefined && info.lastSeq > known) {
			try {
				const replay = await attachment.client.call("conv.replay", { convId: info.convId, afterSeq: known });
				if (replay.complete) {
					for (const event of replay.events) this.forward(event);
				} else {
					this.forward(resyncEvent(info, replay.lastSeq));
				}
			} catch (err) {
				this.log.warn("conversation replay failed", { convId: info.convId, error: errorMessage(err) });
				this.forward(resyncEvent(info, info.lastSeq));
			}
		} else {
			this.bumpSeq(info.convId, info.lastSeq);
		}
		this.upsertInfo(attachment.serverId, info, attachment.clockOffsetMs);
	}

	private onAgentEvent(attachment: Attachment, name: string, data: unknown): void {
		if (this.attachments.get(attachment.serverId) !== attachment || !data || typeof data !== "object") return;
		if (name === "conv.event") {
			const event = data as ConvEvent;
			if (typeof event.convId !== "string" || typeof event.seq !== "number") return;
			if (attachment.ready) this.forward(event);
			else attachment.buffer.push(event);
		} else if (name === "conv.info") {
			const info = data as ConvInfo;
			if (typeof info.convId !== "string") return;
			this.upsertInfo(attachment.serverId, info, attachment.clockOffsetMs);
		}
	}

	/** Publishes an event unless an event with the same or a later seq was already forwarded. */
	private forward(event: ConvEvent): void {
		const last = this.seqs.get(event.convId) ?? 0;
		if (event.seq <= last) return;
		this.seqs.set(event.convId, event.seq);
		this.deps.hub.publish(`conv:${event.convId}`, event);
	}

	private bumpSeq(convId: string, seq: number): void {
		if (seq > (this.seqs.get(convId) ?? 0)) this.seqs.set(convId, seq);
	}

	private upsertInfo(serverId: string, info: ConvInfo, clockOffsetMs: number, workspaceHint?: string): ConvEntry {
		const workspaceId = this.matchWorkspace(serverId, info.cwd) ?? workspaceHint ?? null;
		let entry = this.convs.get(info.convId);
		if (!entry) {
			entry = { convId: info.convId, serverId, workspaceId, info, startedAtHost: info.startedAt - clockOffsetMs };
			this.convs.set(info.convId, entry);
		} else {
			entry.serverId = serverId;
			entry.workspaceId = workspaceId;
			entry.info = info;
			entry.startedAtHost = info.startedAt - clockOffsetMs;
		}
		if (info.status === "exited") this.scheduleRemoval(entry);
		else this.cancelRemoval(entry);
		this.deps.hub.publish("convs", toView(entry));
		this.updateCounts(serverId);
		return entry;
	}

	/** The agent no longer knows this conversation (daemon restarted, or its exit record expired). */
	private markGone(entry: ConvEntry): void {
		const seq = (this.seqs.get(entry.convId) ?? entry.info.lastSeq) + 1;
		this.forward({
			convId: entry.convId,
			seq,
			ts: Date.now(),
			record: { type: "pi_web_exit", code: null, signal: null, stderrTail: "" },
		});
		const info: ConvInfo = { ...entry.info, status: "exited", pendingUi: [], lastSeq: seq, exitCode: null };
		const attachment = this.attachments.get(entry.serverId);
		this.upsertInfo(entry.serverId, info, attachment?.clockOffsetMs ?? entry.info.startedAt - entry.startedAtHost);
	}

	private scheduleRemoval(entry: ConvEntry): void {
		if (entry.removeTimer) return;
		entry.removeTimer = setTimeout(() => {
			if (this.convs.get(entry.convId) !== entry) return;
			this.convs.delete(entry.convId);
			this.seqs.delete(entry.convId);
		}, this.exitedRetentionMs);
		entry.removeTimer.unref?.();
	}

	private cancelRemoval(entry: ConvEntry): void {
		if (!entry.removeTimer) return;
		clearTimeout(entry.removeTimer);
		entry.removeTimer = undefined;
	}

	private updateCounts(serverId: string): void {
		let running = 0;
		let waiting = 0;
		for (const entry of this.convs.values()) {
			if (entry.serverId !== serverId) continue;
			if (entry.info.status === "running") running++;
			else if (entry.info.status === "waiting_ui") waiting++;
		}
		try {
			this.deps.connections.updateStatus(serverId, { conversationsRunning: running, conversationsWaiting: waiting });
		} catch (err) {
			this.log.debug("updateStatus failed", { serverId, error: errorMessage(err) });
		}
	}

	private matchWorkspace(serverId: string, cwd: string): string | null {
		const target = normalizeDir(cwd);
		for (const ws of this.deps.store.listWorkspaces(serverId)) {
			if (normalizeDir(ws.path) === target) return ws.id;
		}
		return null;
	}

	// ---------------------------------------------------------------- queries

	list(): ConversationView[] {
		return [...this.convs.values()]
			.sort((a, b) => b.info.lastActivityAt - a.info.lastActivityAt)
			.map(toView);
	}

	get(convId: string): ConversationView | undefined {
		const entry = this.convs.get(convId);
		return entry ? toView(entry) : undefined;
	}

	// ---------------------------------------------------------------- commands

	async open(workspaceId: string, request: OpenConversationRequest): Promise<ConversationView> {
		const ws = this.deps.store.getWorkspace(workspaceId);
		if (!ws) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "工作区不存在");
		if (!this.deps.store.getServer(ws.serverId)) throw new ApiError(404, "SERVER_NOT_FOUND", "服务器不存在");

		const client = await this.connectedClient(ws.serverId);
		await this.waitAttached(ws.serverId, client);

		const model =
			request.model ??
			(ws.defaults.provider && ws.defaults.modelId ? { provider: ws.defaults.provider, modelId: ws.defaults.modelId } : undefined);
		const params: ConvStartParams = {
			convId: randomUUID(),
			cwd: ws.path,
			trust: ws.trust,
			env: { ...ws.env },
		};
		if (request.sessionFile) params.sessionFile = request.sessionFile;
		if (model) params.model = model;
		const thinkingLevel = request.thinkingLevel ?? ws.defaults.thinkingLevel;
		if (thinkingLevel) params.thinkingLevel = thinkingLevel;
		if (request.name) params.name = request.name;

		const result = await client.call("conv.start", params, { timeoutMs: START_TIMEOUT_MS });
		const offset = this.attachments.get(ws.serverId)?.clockOffsetMs ?? 0;
		this.bumpSeq(result.conv.convId, result.conv.lastSeq);
		const entry = this.upsertInfo(ws.serverId, result.conv, offset, ws.id);
		return toView(entry);
	}

	async snapshot(convId: string): Promise<ConversationSnapshot> {
		const entry = this.requireEntry(convId);
		const client = this.requireClient(entry.serverId);
		const snapshot = await client.call("conv.snapshot", { convId }, { timeoutMs: SNAPSHOT_TIMEOUT_MS });
		const offset = this.attachments.get(entry.serverId)?.clockOffsetMs ?? 0;
		entry.info = snapshot.info;
		entry.startedAtHost = snapshot.info.startedAt - offset;
		return {
			convId,
			serverId: entry.serverId,
			workspaceId: entry.workspaceId,
			snapshot,
			configStale: this.isConfigStale(entry),
		};
	}

	async rpc(convId: string, command: RpcCommand, timeoutMs?: number): Promise<RpcResponse & { seq?: number }> {
		const entry = this.requireEntry(convId);
		const client = this.requireClient(entry.serverId);
		const effective = timeoutMs ?? (LONG_COMMANDS.has(command.type) ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS);
		const params = timeoutMs === undefined ? { convId, command } : { convId, command, timeoutMs };
		return client.call("conv.send", params, { timeoutMs: effective + LINK_MARGIN_MS });
	}

	async uiResponse(convId: string, response: ExtensionUIResponse): Promise<void> {
		const entry = this.requireEntry(convId);
		await this.requireClient(entry.serverId).call("conv.uiResponse", { convId, response });
	}

	async companion(
		convId: string,
		action: "navigate" | "label" | "reload",
		args: Record<string, unknown>,
	): Promise<CompanionActionResponse> {
		const entry = this.requireEntry(convId);
		const client = this.requireClient(entry.serverId);
		const params = { convId, action, args } as ConvCompanionParams;
		const timeoutMs = (action === "navigate" ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS) + LINK_MARGIN_MS;
		const result = await client.call("conv.companion", params, { timeoutMs });
		if (action === "reload" && result.ok) entry.reloadedAt = Date.now();
		return result;
	}

	async stop(convId: string, force?: boolean): Promise<void> {
		const entry = this.requireEntry(convId);
		await this.requireClient(entry.serverId).call("conv.stop", force ? { convId, force: true } : { convId });
	}

	async replay(convId: string, afterSeq: number): Promise<ConvReplayResult> {
		const entry = this.requireEntry(convId);
		return this.requireClient(entry.serverId).call("conv.replay", { convId, afterSeq });
	}

	async exportHtml(convId: string): Promise<{ stream: Readable; size: number; fileName: string }> {
		const entry = this.requireEntry(convId);
		const client = this.requireClient(entry.serverId);
		const exportsDir = posixPath.join(client.hello.remoteRoot, "state", "exports");
		try {
			await client.call("fs.mkdir", { path: exportsDir, recursive: true });
		} catch (err) {
			this.log.debug("exports dir mkdir failed", { error: errorMessage(err) });
		}
		const outputPath = posixPath.join(exportsDir, `${convId}-${Date.now()}.html`);
		const response = await this.rpc(convId, { type: "export_html", outputPath });
		if (!response.success) {
			throw new ApiError(500, "EXPORT_FAILED", `导出失败：${response.error ?? "未知错误"}`);
		}
		const remotePath = typeof response.data?.path === "string" ? (response.data.path as string) : outputPath;
		const connection = this.deps.connections.get(entry.serverId);
		const removeRemote = () => {
			connection.exec(`rm -f ${shellQuote(remotePath)}`, { timeoutMs: 30_000 }).catch((err: unknown) => {
				this.log.debug("failed to remove exported file", { error: errorMessage(err) });
			});
		};
		let opened: { stream: Readable; size: number };
		try {
			opened = await connection.createReadStream(remotePath);
		} catch (err) {
			removeRemote();
			throw err;
		}
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			removeRemote();
		};
		opened.stream.once("end", cleanup);
		opened.stream.once("close", cleanup);
		opened.stream.once("error", cleanup);
		const baseName = entry.info.sessionName || entry.info.sessionId || convId;
		return { stream: opened.stream, size: opened.size, fileName: `${sanitizeFileName(baseName, convId)}.html` };
	}

	// ---------------------------------------------------------------- helpers

	private isConfigStale(entry: ConvEntry): boolean {
		const changedAt = this.deps.syncer.lastChangeAt(entry.serverId);
		if (changedAt === undefined) return false;
		return changedAt > Math.max(entry.startedAtHost, entry.reloadedAt ?? 0);
	}

	private requireEntry(convId: string): ConvEntry {
		const entry = this.convs.get(convId);
		if (!entry) throw new ApiError(404, "CONV_NOT_FOUND", "对话不存在或已结束");
		return entry;
	}

	private liveClient(serverId: string): AgentClient | null {
		const attached = this.attachments.get(serverId)?.client;
		if (attached && !attached.peer?.closed) return attached;
		let client: AgentClient | null = null;
		try {
			client = this.deps.connections.get(serverId).agentClient;
		} catch {
			return null;
		}
		return client && !client.peer?.closed ? client : null;
	}

	private requireClient(serverId: string): AgentClient {
		const client = this.liveClient(serverId);
		if (!client) throw new ApiError(503, "NOT_CONNECTED", "服务器未连接");
		return client;
	}

	/** Returns the agent link, connecting the server first when needed. */
	private async connectedClient(serverId: string): Promise<AgentClient> {
		const live = this.liveClient(serverId);
		if (live) return live;
		await this.deps.connections.connect(serverId);
		const connection = this.deps.connections.get(serverId);
		return connection.agentClient ?? (await connection.agent());
	}

	/** Waits until attach() has finished for this link, so conv.start runs on a configured agent. */
	private waitAttached(serverId: string, client: AgentClient): Promise<void> {
		const attachment = this.attachments.get(serverId);
		if (attachment && attachment.client === client && attachment.ready) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const onAttached = (attachedServerId: string, attachedClient: AgentClient) => {
				if (attachedServerId !== serverId || attachedClient !== client) return;
				clearTimeout(timer);
				this.attachedSignal.off("attached", onAttached);
				resolve();
			};
			const timer = setTimeout(() => {
				this.attachedSignal.off("attached", onAttached);
				reject(new ApiError(503, "AGENT_NOT_READY", "服务器上的 Pi-Web agent 尚未就绪，请稍后重试"));
			}, this.attachWaitMs);
			this.attachedSignal.on("attached", onAttached);
		});
	}
}

function toView(entry: ConvEntry): ConversationView {
	return { convId: entry.convId, serverId: entry.serverId, workspaceId: entry.workspaceId, info: entry.info };
}

function resyncEvent(info: ConvInfo, seq: number): ConvEvent {
	return {
		convId: info.convId,
		seq,
		ts: Date.now(),
		record: {
			type: "pi_web_session_changed",
			sessionFile: info.sessionFile,
			sessionId: info.sessionId,
			sessionName: info.sessionName,
		},
	};
}

/** Estimates agent clock minus host clock using the Link's built-in ping (which returns the peer's Date.now()). */
async function measureClockOffset(client: AgentClient): Promise<number> {
	try {
		if (!client.peer || typeof client.peer.request !== "function") return 0;
		const t0 = Date.now();
		const res = await client.peer.request<{ now?: unknown }>("link.ping", undefined, { timeoutMs: 5000 });
		const t1 = Date.now();
		return typeof res?.now === "number" ? res.now - (t0 + t1) / 2 : 0;
	} catch {
		return 0;
	}
}

function normalizeDir(p: string): string {
	const trimmed = p.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}

export function sanitizeFileName(name: string, fallback: string): string {
	const cleaned = name
		.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
