import { posix as posixPath } from "node:path";
import type { FsListResponse, FsReadResponse } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../core/types.js";
import type { AppContext } from "../core/types.js";
import { queryBool, queryInt, queryRequired, queryString, requireAgent, requireServer, requireWorkspace, resolveWorkspacePath } from "./util.js";
import type { Json } from "./util.js";

type WsParams = { Params: { wsId: string } };

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(fileName: string): string {
	const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
	const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function fileRoutes(app: FastifyInstance, ctx: AppContext): void {
	app.get<WsParams>("/workspaces/:wsId/fs/list", async (request): Promise<FsListResponse> => {
		const workspace = requireWorkspace(ctx, request.params.wsId);
		const query = request.query as Json;
		const path = resolveWorkspacePath(workspace.path, queryString(query, "path"));
		const hideIgnored = queryBool(query, "hideIgnored") ?? false;
		const client = await requireAgent(ctx, workspace.serverId);
		return client.call("fs.list", {
			path,
			showHidden: queryBool(query, "showHidden") ?? false,
			respectGitignore: queryBool(query, "respectGitignore") ?? true,
			hideIgnored,
		});
	});

	app.get<WsParams>("/workspaces/:wsId/fs/read", async (request): Promise<FsReadResponse> => {
		const workspace = requireWorkspace(ctx, request.params.wsId);
		const query = request.query as Json;
		const path = resolveWorkspacePath(workspace.path, queryRequired(query, "path"));
		const maxBytes = queryInt(query, "maxBytes", 1, 64 * 1024 * 1024);
		const client = await requireAgent(ctx, workspace.serverId);
		return client.call("fs.read", maxBytes === undefined ? { path } : { path, maxBytes });
	});

	app.get<WsParams>("/workspaces/:wsId/fs/download", async (request, reply) => {
		const workspace = requireWorkspace(ctx, request.params.wsId);
		const server = requireServer(ctx, workspace.serverId);
		const requested = queryRequired(request.query as Json, "path");
		const connection = ctx.connections.get(server.id);
		if (connection.state !== "connected") throw new ApiError(409, "NOT_CONNECTED", "服务器未连接，请先连接");
		const home = connection.agentClient?.hello.home ?? server.deployed?.home;
		const path = resolveWorkspacePath(workspace.path, requested, home);
		if (path.startsWith("~")) throw new ApiError(400, "BAD_REQUEST", "无法解析 ~ 路径");
		const { stream, size } = await connection.createReadStream(path);
		reply
			.header("content-type", "application/octet-stream")
			.header("content-disposition", contentDisposition(posixPath.basename(path) || "download"))
			.header("cache-control", "no-store");
		if (Number.isFinite(size) && size >= 0) reply.header("content-length", String(size));
		return reply.send(stream);
	});
}
