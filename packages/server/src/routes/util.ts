/** Helpers shared by the REST route modules: input validation, lookups and path resolution. */
import { posix as posixPath } from "node:path";
import { isPlainObject } from "@pi-web/shared";
import type { ServerConfig, ServerView, ThinkingLevel, WorkspaceConfig, WorkspaceView } from "@pi-web/shared";
import { ApiError } from "../core/types.js";
import type { AgentClient, AppContext } from "../core/types.js";

export type Json = Record<string, unknown>;
export type Query = Record<string, unknown>;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function badRequest(message: string, details?: unknown): ApiError {
	return new ApiError(400, "BAD_REQUEST", message, details);
}

/** The request body as a JSON object (missing body → {}). */
export function bodyObject(value: unknown): Json {
	if (value === undefined || value === null || value === "") return {};
	if (!isPlainObject(value)) throw badRequest("请求体必须是 JSON 对象");
	return value;
}

export function reqString(obj: Json, key: string, options: { max?: number } = {}): string {
	const value = obj[key];
	if (typeof value !== "string" || value.trim() === "") throw badRequest(`缺少字段 ${key}`);
	if (options.max !== undefined && value.length > options.max) throw badRequest(`字段 ${key} 过长`);
	return value;
}

export function optString(obj: Json, key: string, options: { max?: number; allowEmpty?: boolean } = {}): string | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw badRequest(`字段 ${key} 必须是字符串`);
	if (!options.allowEmpty && value.trim() === "") return undefined;
	if (options.max !== undefined && value.length > options.max) throw badRequest(`字段 ${key} 过长`);
	return value;
}

export function optInt(obj: Json, key: string, min: number, max: number): number | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw badRequest(`字段 ${key} 必须是 ${min} 到 ${max} 之间的整数`);
	}
	return value;
}

export function optBool(obj: Json, key: string): boolean | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") throw badRequest(`字段 ${key} 必须是布尔值`);
	return value;
}

export function optEnum<T extends string>(obj: Json, key: string, values: readonly T[]): T | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw badRequest(`字段 ${key} 的取值必须是 ${values.join(" / ")} 之一`);
	}
	return value as T;
}

export function optStringArray(obj: Json, key: string, options: { maxItems?: number } = {}): string[] | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw badRequest(`字段 ${key} 必须是字符串数组`);
	if (options.maxItems !== undefined && value.length > options.maxItems) throw badRequest(`字段 ${key} 的条目过多`);
	return value.map((v: string) => v.trim()).filter((v) => v !== "");
}

export function optObject(obj: Json, key: string): Json | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (!isPlainObject(value)) throw badRequest(`字段 ${key} 必须是对象`);
	return value;
}

/** Environment variable map: valid names, string values. */
export function optEnv(obj: Json, key: string): Record<string, string> | undefined {
	const value = optObject(obj, key);
	if (!value) return undefined;
	const env: Record<string, string> = {};
	for (const [name, v] of Object.entries(value)) {
		if (!ENV_NAME.test(name)) throw badRequest(`环境变量名无效：${name}`);
		if (typeof v !== "string") throw badRequest(`环境变量 ${name} 的值必须是字符串`);
		env[name] = v;
	}
	return env;
}

// ---------- query strings ----------

function queryValue(query: Query | undefined, key: string): string | undefined {
	const raw = query?.[key];
	const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
	if (value === undefined || value === null) return undefined;
	return String(value);
}

export function queryString(query: Query | undefined, key: string): string | undefined {
	const value = queryValue(query, key);
	return value === undefined || value === "" ? undefined : value;
}

export function queryRequired(query: Query | undefined, key: string): string {
	const value = queryString(query, key);
	if (value === undefined) throw badRequest(`缺少参数 ${key}`);
	return value;
}

export function queryInt(query: Query | undefined, key: string, min: number, max: number): number | undefined {
	const value = queryString(query, key);
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`参数 ${key} 必须是 ${min} 到 ${max} 之间的整数`);
	return n;
}

export function queryBool(query: Query | undefined, key: string): boolean | undefined {
	const value = queryString(query, key);
	if (value === undefined) return undefined;
	if (value === "1" || value === "true") return true;
	if (value === "0" || value === "false") return false;
	throw badRequest(`参数 ${key} 必须是 true 或 false`);
}

// ---------- lookups ----------

export function requireServer(ctx: AppContext, id: string): ServerConfig {
	const server = ctx.store.getServer(id);
	if (!server) throw new ApiError(404, "SERVER_NOT_FOUND", "服务器不存在");
	return server;
}

export function requireWorkspace(ctx: AppContext, id: string): WorkspaceConfig {
	const workspace = ctx.store.getWorkspace(id);
	if (!workspace) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "工作区不存在");
	return workspace;
}

/** The server's agent link; the server must be connected (the link is re-established when only it dropped). */
export async function requireAgent(ctx: AppContext, serverId: string): Promise<AgentClient> {
	requireServer(ctx, serverId);
	const connection = ctx.connections.get(serverId);
	const existing = connection.agentClient;
	if (existing && !existing.peer?.closed) return existing;
	if (connection.state !== "connected") throw new ApiError(409, "NOT_CONNECTED", "服务器未连接，请先连接");
	return connection.agent();
}

export function serverView(ctx: AppContext, config: ServerConfig): ServerView {
	return { config, status: ctx.connections.status(config.id) };
}

/** `sessionCount`: the last known number of pi sessions in the workspace (omitted when unknown). */
export function workspaceView(ctx: AppContext, config: WorkspaceConfig, sessionCount?: number): WorkspaceView {
	let running = 0;
	for (const conv of ctx.conversations.list()) {
		if (conv.workspaceId === config.id && conv.info.status !== "exited") running++;
	}
	return sessionCount === undefined ? { config, runningCount: running } : { config, sessionCount, runningCount: running };
}

// ---------- remote paths ----------

/** True for "/abs", "~" and "~/x". */
export function isRemoteAbsolute(p: string): boolean {
	return p.startsWith("/") || p === "~" || p.startsWith("~/");
}

/**
 * Resolves a path given by the browser against a workspace: empty → the workspace root,
 * relative → joined to it, absolute or "~"-prefixed → kept ("~" is expanded with `home` when given).
 */
export function resolveWorkspacePath(workspacePath: string, p: string | undefined, home?: string): string {
	if (p === undefined || p === "" || p === ".") return workspacePath;
	if (p === "~" || p.startsWith("~/")) return home ? posixPath.join(home, p.slice(1)) : p;
	if (p.startsWith("/")) return posixPath.normalize(p);
	return posixPath.join(workspacePath, p);
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
