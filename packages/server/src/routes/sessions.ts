import type { SessionFileResponse } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/types.js";
import { badRequest, queryRequired, requireAgent, requireServer } from "./util.js";
import type { Json } from "./util.js";

function sessionFileParam(query: Json): string {
	const file = queryRequired(query, "file");
	if (!file.startsWith("/")) throw badRequest("会话文件必须是绝对路径");
	return file;
}

export function sessionRoutes(app: FastifyInstance, ctx: AppContext): void {
	app.get("/sessions/read", async (request): Promise<SessionFileResponse> => {
		const query = request.query as Json;
		const server = requireServer(ctx, queryRequired(query, "serverId"));
		const file = sessionFileParam(query);
		const client = await requireAgent(ctx, server.id);
		return client.call("sessions.read", { file }, { timeoutMs: 120_000 });
	});

	app.delete("/sessions", async (request): Promise<{ trashedTo: string }> => {
		const query = request.query as Json;
		const server = requireServer(ctx, queryRequired(query, "serverId"));
		const file = sessionFileParam(query);
		const client = await requireAgent(ctx, server.id);
		const result = await client.call("sessions.delete", { file });
		return { trashedTo: result.trashedTo };
	});
}
