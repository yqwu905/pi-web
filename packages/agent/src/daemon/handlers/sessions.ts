import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
	encodeCwdForSessions,
	type SessionEntry,
	type SessionHeader,
	type SessionsDeleteParams,
	type SessionsDeleteResult,
	type SessionsListParams,
	type SessionsListResult,
	type SessionsReadParams,
	type SessionsReadResult,
	type SessionSummary,
} from "@pi-web/shared";
import { AgentError, errnoCode } from "../errors.js";
import { readJsonFile, resolveUserPath } from "../fsutil.js";
import { JsonlLineDecoder } from "../jsonl.js";

const MAX_SESSION_FILE = 64 * 1024 * 1024;
const FIRST_MESSAGE_MAX = 200;

export interface SessionsDeps {
	/** Agent dir pi processes use (PI_CODING_AGENT_DIR). */
	getAgentDir: () => string;
	/** Extra env given to pi processes (PI_CODING_AGENT_SESSION_DIR overrides the setting). */
	getExtraEnv?: () => Record<string, string> | undefined;
	/** convId of the live process serving a session file. */
	findRunning: (file: string) => string | undefined;
	trashDir: string;
}

interface CacheEntry {
	size: number;
	mtimeMs: number;
	summary: Omit<SessionSummary, "runningConvId"> | null;
}

function parseLine(line: string): Record<string, unknown> | null {
	if (!line.trim()) return null;
	try {
		const value = JSON.parse(line) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text")
		.map((c) => String((c as { text?: unknown }).text ?? ""))
		.join(" ");
}

/** Streams a session file and builds its summary (header, message count, first user text, name). */
export async function summarizeSessionFile(file: string, mtimeMs: number): Promise<Omit<SessionSummary, "runningConvId"> | null> {
	const decoder = new JsonlLineDecoder();
	let header: SessionHeader | null = null;
	let invalid = false;
	let messageCount = 0;
	let firstMessage = "";
	let name: string | undefined;
	let lastActivity: number | undefined;
	const handle = (line: string): boolean => {
		const entry = parseLine(line);
		if (!entry) return true;
		if (!header) {
			if (entry.type !== "session") {
				invalid = true;
				return false;
			}
			header = entry as unknown as SessionHeader;
			return true;
		}
		if (entry.type === "session_info") {
			const n = typeof entry.name === "string" ? entry.name.trim() : "";
			name = n || undefined;
			return true;
		}
		if (entry.type !== "message") return true;
		messageCount++;
		const message = entry.message as { role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
		if (!message || (message.role !== "user" && message.role !== "assistant") || !("content" in message)) return true;
		const ts = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(entry.timestamp));
		if (Number.isFinite(ts)) lastActivity = Math.max(lastActivity ?? 0, ts);
		if (!firstMessage && message.role === "user") {
			const text = textOf(message.content).trim();
			if (text) firstMessage = text.length > FIRST_MESSAGE_MAX ? `${text.slice(0, FIRST_MESSAGE_MAX)}…` : text;
		}
		return true;
	};
	await new Promise<void>((resolvePromise, reject) => {
		const stream = createReadStream(file);
		stream.on("data", (chunk) => {
			for (const line of decoder.push(chunk as Buffer)) {
				if (!handle(line)) {
					stream.destroy();
					resolvePromise();
					return;
				}
			}
		});
		stream.on("error", reject);
		stream.on("end", () => {
			for (const line of decoder.end()) handle(line);
			resolvePromise();
		});
	});
	const h = header as SessionHeader | null;
	if (invalid || !h || typeof h.id !== "string") return null;
	const createdMs = Date.parse(h.timestamp) || mtimeMs;
	const modifiedMs = lastActivity && lastActivity > 0 ? lastActivity : Date.parse(h.timestamp) || mtimeMs;
	const summary: Omit<SessionSummary, "runningConvId"> = {
		file,
		id: h.id,
		cwd: typeof h.cwd === "string" ? h.cwd : "",
		createdMs,
		modifiedMs,
		messageCount,
		firstMessage,
	};
	if (name) summary.name = name;
	if (typeof h.parentSession === "string") summary.parentSession = h.parentSession;
	return summary;
}

export class SessionsHandler {
	private readonly cache = new Map<string, CacheEntry>();

	constructor(private readonly deps: SessionsDeps) {}

	/** Directory holding the sessions of `cwd`, and whether entries must be filtered by header cwd. */
	async location(cwd: string): Promise<{ dir: string; filterCwd: boolean }> {
		const agentDir = this.deps.getAgentDir();
		const override = this.deps.getExtraEnv?.()?.PI_CODING_AGENT_SESSION_DIR;
		const settings = await readJsonFile<{ sessionDir?: unknown }>(join(agentDir, "settings.json"));
		const configured = override || (typeof settings?.sessionDir === "string" ? settings.sessionDir.trim() : "");
		if (configured) {
			const dir = configured === "~" || configured.startsWith("~/") || isAbsolute(configured) ? resolveUserPath(configured) : resolve(cwd, configured);
			return { dir, filterCwd: true };
		}
		return { dir: join(agentDir, "sessions", encodeCwdForSessions(cwd)), filterCwd: false };
	}

	async list(params: SessionsListParams): Promise<SessionsListResult> {
		if (typeof params?.cwd !== "string" || !isAbsolute(params.cwd)) throw new AgentError("BAD_PARAMS", "工作区路径必须是绝对路径");
		const cwd = resolve(params.cwd);
		const { dir, filterCwd } = await this.location(cwd);
		let names: string[];
		try {
			names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
		} catch (err) {
			if (errnoCode(err) === "ENOENT") return { sessions: [] };
			throw err;
		}
		const sessions: SessionSummary[] = [];
		const seen = new Set<string>();
		await mapLimit(names, 8, async (name) => {
			const file = join(dir, name);
			seen.add(file);
			const summary = await this.summary(file);
			if (!summary) return;
			if (filterCwd && resolve(summary.cwd || "/") !== cwd) return;
			const runningConvId = this.deps.findRunning(file);
			sessions.push(runningConvId ? { ...summary, runningConvId } : { ...summary });
		});
		for (const file of this.cache.keys()) {
			if (file.startsWith(`${dir}/`) && !seen.has(file)) this.cache.delete(file);
		}
		sessions.sort((a, b) => b.modifiedMs - a.modifiedMs || (a.file < b.file ? 1 : -1));
		return { sessions };
	}

	async read(params: SessionsReadParams): Promise<SessionsReadResult> {
		const file = resolveUserPath(params?.file);
		const s = await stat(file).catch(() => null);
		if (!s?.isFile()) throw new AgentError("ENOENT", `会话文件不存在：${file}`);
		if (s.size > MAX_SESSION_FILE) throw new AgentError("TOO_LARGE", `会话文件过大（超过 64 MB）：${file}`);
		const decoder = new JsonlLineDecoder();
		const lines = [...decoder.push(await readFile(file)), ...decoder.end()];
		let header: SessionHeader | null = null;
		const entries: SessionEntry[] = [];
		for (const line of lines) {
			const entry = parseLine(line);
			if (!entry) continue;
			if (entry.type === "session") {
				if (!header && entries.length === 0) header = entry as unknown as SessionHeader;
				continue;
			}
			if (typeof entry.id !== "string") continue;
			entries.push(entry as unknown as SessionEntry);
		}
		const leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
		const byId = new Map(entries.map((e) => [e.id, e]));
		const branchIds: string[] = [];
		const visited = new Set<string>();
		let cursor: string | null = leafId;
		while (cursor && !visited.has(cursor)) {
			const entry = byId.get(cursor);
			if (!entry) break;
			visited.add(cursor);
			branchIds.push(cursor);
			cursor = entry.parentId;
		}
		branchIds.reverse();
		return { header, entries, leafId, branchIds };
	}

	async delete(params: SessionsDeleteParams): Promise<SessionsDeleteResult> {
		const file = resolveUserPath(params?.file);
		if (!file.endsWith(".jsonl")) throw new AgentError("BAD_PATH", "只能删除 .jsonl 会话文件");
		if (this.deps.findRunning(file)) throw new AgentError("BUSY", "该会话正在运行，请先停止会话进程");
		const s = await stat(file).catch(() => null);
		if (!s?.isFile()) throw new AgentError("ENOENT", `会话文件不存在：${file}`);
		await mkdir(this.deps.trashDir, { recursive: true, mode: 0o700 });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const trashedTo = join(this.deps.trashDir, `${stamp}-${basename(file)}`);
		try {
			await rename(file, trashedTo);
		} catch (err) {
			if (errnoCode(err) !== "EXDEV") throw err;
			await copyFile(file, trashedTo);
			await unlink(file);
		}
		this.cache.delete(file);
		return { trashedTo };
	}

	private async summary(file: string): Promise<Omit<SessionSummary, "runningConvId"> | null> {
		const s = await stat(file).catch(() => null);
		if (!s?.isFile()) return null;
		const cached = this.cache.get(file);
		if (cached && cached.size === s.size && cached.mtimeMs === s.mtimeMs) return cached.summary;
		let summary: Omit<SessionSummary, "runningConvId"> | null = null;
		try {
			summary = await summarizeSessionFile(file, s.mtimeMs);
		} catch {
			summary = null;
		}
		this.cache.set(file, { size: s.size, mtimeMs: s.mtimeMs, summary });
		return summary;
	}
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let index = 0;
	const worker = async () => {
		while (index < items.length) {
			const item = items[index++];
			await fn(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
