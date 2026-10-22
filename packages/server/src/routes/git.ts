import type { GitDiffResponse, GitLogResponse, GitStatusResponse } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/types.js";
import { badRequest, queryInt, queryString, requireAgent, requireWorkspace } from "./util.js";
import type { Json } from "./util.js";

type WsParams = { Params: { wsId: string } };
const DIFF_AREAS = ["staged", "unstaged", "untracked"] as const;

export function gitRoutes(app: FastifyInstance, ctx: AppContext): void {
	app.get<WsParams>("/workspaces/:wsId/git/status", async (request): Promise<GitStatusResponse> => {
		const workspace = requireWorkspace(ctx, request.params.wsId);
		const client = await requireAgent(ctx, workspace.serverId);
		return client.call("git.status", { cwd: workspace.path });
	});

	app.get<WsParams>("/workspaces/:wsId/git/diff", async (request): Promise<GitDiffResponse> => {
		const workspace = requireWorkspace(ctx, request.params.wsId);
		const query = request.query as Json;
		const area = queryString(query, "area") ?? "unstaged";
		if (!(DIFF_AREAS as readonly string[]).includes(area)) throw badRequest("参数 area 必须是 staged / unstaged / untracked 之一");
		const path = queryString(query, "path");
		const contextLines = queryInt(query, "context", 0, 10_000);
		const client = await requireAgent(ctx, workspace.serverId);
		return client.call("git.diff", {
			cwd: workspace.path,
			area: area as (typeof DIFF_AREAS)[number],
			...(path !== undefined ? { path } : {}),
			...(contextLines !== undefined ? { contextLines } : {}),
		});
	});

	app.get<WsParams>("/workspaces/:wsId/git/log", async (request): Promise<GitLogResponse> => {
		const workspace = requireWorkspace(ctx, request.params.wsId);
		const limit = queryInt(request.query as Json, "limit", 1, 1000);
		const client = await requireAgent(ctx, workspace.serverId);
		return client.call("git.log", limit === undefined ? { cwd: workspace.path } : { cwd: workspace.path, limit });
	});
}
