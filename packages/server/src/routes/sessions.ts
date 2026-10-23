import { posix as posixPath } from "node:path";
import type { ArchiveSessionResponse, SessionFileResponse, SessionsTopicEvent } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import { archiveSession, unarchiveSession } from "../core/archive.js";
import { ApiError } from "../core/types.js";
import type { AppContext } from "../core/types.js";
import { badRequest, bodyObject, queryRequired, reqString, requireAgent, requireServer } from "./util.js";
import type { Json } from "./util.js";

function sessionFileParam(query: Json): string {
	const file = queryRequired(query, "file");
	if (!file.startsWith("/")) throw badRequest("会话文件必须是绝对路径");
	return file;
}

/** `{ serverId, file }` of an archive request: a known server and a normalized absolute .jsonl path. */
function archiveTarget(ctx: AppContext, body: unknown): { serverId: string; file: string } {
	const json = bodyObject(body);
	const server = requireServer(ctx, reqString(json, "serverId", { max: 200 }));
	const file = reqString(json, "file", { max: 4096 });
	if (!file.startsWith("/") || !file.endsWith(".jsonl") || file.includes("\0") || posixPath.normalize(file) !== file) {
		throw badRequest("会话文件必须是 .jsonl 文件的绝对路径");
	}
	return { serverId: server.id, file };
}

export function sessionRoutes(app: FastifyInstance, ctx: AppContext): void {
	const publish = (event: SessionsTopicEvent) => ctx.hub.publish("sessions", event);

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
		if (await unarchiveSession(ctx.store, server.id, file)) publish({ serverId: server.id, file, archivedAt: null, deleted: true });
		return { trashedTo: result.trashedTo };
	});

	// Archiving only hides a session in Pi-Web (host-side mark): no agent call, works offline.
	app.post("/sessions/archive", async (request): Promise<ArchiveSessionResponse> => {
		const { serverId, file } = archiveTarget(ctx, request.body);
		const busy = ctx.conversations
			.list()
			.some((c) => c.serverId === serverId && c.info.sessionFile === file && (c.info.status === "running" || c.info.status === "waiting_ui"));
		if (busy) throw new ApiError(409, "BUSY", "会话正在运行，无法归档");
		const archivedAt = await archiveSession(ctx.store, serverId, file);
		publish({ serverId, file, archivedAt });
		return { ok: true, archivedAt };
	});

	app.post("/sessions/unarchive", async (request): Promise<ArchiveSessionResponse> => {
		const { serverId, file } = archiveTarget(ctx, request.body);
		if (await unarchiveSession(ctx.store, serverId, file)) publish({ serverId, file, archivedAt: null });
		return { ok: true };
	});
}
