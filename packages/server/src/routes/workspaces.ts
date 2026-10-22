import { randomUUID } from "node:crypto";
import { posix as posixPath } from "node:path";
import type { SessionListResponse, WorkspaceConfig, WorkspaceView } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../core/types.js";
import type { AppContext } from "../core/types.js";
import {
	THINKING_LEVELS,
	badRequest,
	bodyObject,
	isRemoteAbsolute,
	optBool,
	optEnum,
	optEnv,
	optObject,
	optString,
	reqString,
	requireAgent,
	requireServer,
	requireWorkspace,
	workspaceView,
} from "./util.js";
import type { Json } from "./util.js";

type WsParams = { Params: { wsId: string } };
type ServerParams = { Params: { id: string } };

/** How long a workspace list waits for the agent's session counts before answering without them. */
const SESSION_COUNT_TIMEOUT_MS = 5_000;

function parseDefaults(body: Json): WorkspaceConfig["defaults"] | undefined {
	const value = optObject(body, "defaults");
	if (!value) return undefined;
	const defaults: WorkspaceConfig["defaults"] = {};
	const provider = optString(value, "provider", { max: 200 })?.trim();
	const modelId = optString(value, "modelId", { max: 400 })?.trim();
	if ((provider && !modelId) || (!provider && modelId)) throw badRequest("默认模型需要同时指定 provider 和 modelId");
	if (provider && modelId) {
		defaults.provider = provider;
		defaults.modelId = modelId;
	}
	const thinkingLevel = optEnum(value, "thinkingLevel", THINKING_LEVELS);
	if (thinkingLevel) defaults.thinkingLevel = thinkingLevel;
	return defaults;
}

export function workspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
	/** Last known session count per workspace id, from the agent's session lists. */
	const sessionCounts = new Map<string, number>();
	const view = (w: WorkspaceConfig) => workspaceView(ctx, w, sessionCounts.get(w.id));

	/** Refreshes the counts of a server's workspaces over an existing agent link (cached on the agent). */
	const refreshSessionCounts = async (serverId: string, workspaces: WorkspaceConfig[]): Promise<void> => {
		const client = ctx.connections.get(serverId).agentClient;
		if (!client || client.peer?.closed || workspaces.length === 0) return;
		await Promise.all(
			workspaces.map(async (w) => {
				try {
					const result = await client.call("sessions.list", { cwd: w.path }, { timeoutMs: SESSION_COUNT_TIMEOUT_MS });
					sessionCounts.set(w.id, result.sessions.length);
				} catch {
					// keep the last known count
				}
			}),
		);
	};

	app.get("/workspaces", async (): Promise<{ workspaces: WorkspaceView[] }> => ({
		workspaces: ctx.store.listWorkspaces().map(view),
	}));

	app.get<ServerParams>("/servers/:id/workspaces", async (request): Promise<{ workspaces: WorkspaceView[] }> => {
		const server = requireServer(ctx, request.params.id);
		const workspaces = ctx.store.listWorkspaces(server.id);
		await refreshSessionCounts(server.id, workspaces);
		return { workspaces: workspaces.map(view) };
	});

	app.post<ServerParams>("/servers/:id/workspaces", async (request): Promise<WorkspaceView> => {
		const server = requireServer(ctx, request.params.id);
		const body = bodyObject(request.body);
		const requested = reqString(body, "path", { max: 4096 }).trim();
		if (!isRemoteAbsolute(requested)) throw badRequest("工作区路径必须是绝对路径或以 ~ 开头");
		const alias = optString(body, "alias", { max: 200 })?.trim();
		const trust = optEnum(body, "trust", ["approve", "no-approve"] as const);
		const defaults = parseDefaults(body) ?? {};
		const env = optEnv(body, "env") ?? {};
		const create = optBool(body, "create") ?? false;

		const client = await requireAgent(ctx, server.id);
		let stat = await client.call("fs.stat", { path: requested });
		if (!stat.exists) {
			if (!create) throw new ApiError(400, "PATH_NOT_FOUND", `目录不存在：${requested}`);
			await client.call("fs.mkdir", { path: requested, recursive: true });
		}
		// pi records the physical cwd, so store the canonical path to match its session directories.
		const path = (await client.call("fs.realpath", { path: requested })).path;
		stat = await client.call("fs.stat", { path });
		if (!stat.exists || stat.type !== "dir") throw new ApiError(400, "NOT_A_DIRECTORY", `不是目录：${requested}`);
		if (ctx.store.listWorkspaces(server.id).some((w) => w.path === path)) {
			throw new ApiError(409, "WORKSPACE_EXISTS", "该工作区已存在");
		}
		const config: WorkspaceConfig = {
			id: randomUUID(),
			serverId: server.id,
			path,
			alias: alias || posixPath.basename(path) || path,
			trust: trust ?? server.defaultTrust,
			defaults,
			env,
			createdAt: Date.now(),
		};
		await ctx.store.saveWorkspace(config);
		return view(config);
	});

	app.put<WsParams>("/workspaces/:wsId", async (request): Promise<WorkspaceView> => {
		const current = requireWorkspace(ctx, request.params.wsId);
		const body = bodyObject(request.body);
		for (const key of Object.keys(body)) {
			if (!["alias", "trust", "defaults", "env"].includes(key)) throw badRequest(`不能修改字段：${key}`);
		}
		const next: WorkspaceConfig = { ...current };
		const alias = optString(body, "alias", { max: 200 })?.trim();
		if (alias) next.alias = alias;
		const trust = optEnum(body, "trust", ["approve", "no-approve"] as const);
		if (trust) next.trust = trust;
		const defaults = parseDefaults(body);
		if (defaults) next.defaults = defaults;
		const env = optEnv(body, "env");
		if (env) next.env = env;
		await ctx.store.saveWorkspace(next);
		return view(next);
	});

	app.delete<WsParams>("/workspaces/:wsId", async (request) => {
		const workspace = requireWorkspace(ctx, request.params.wsId);
		await ctx.store.deleteWorkspace(workspace.id);
		sessionCounts.delete(workspace.id);
		return { ok: true as const };
	});

	app.get<WsParams>("/workspaces/:wsId/sessions", async (request): Promise<SessionListResponse> => {
		const workspace = requireWorkspace(ctx, request.params.wsId);
		const client = await requireAgent(ctx, workspace.serverId);
		const result = await client.call("sessions.list", { cwd: workspace.path });
		sessionCounts.set(workspace.id, result.sessions.length);
		return { sessions: result.sessions };
	});
}
