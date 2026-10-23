import type {
	CompanionActionResponse,
	ConversationSnapshot,
	ConversationUiResponseResult,
	ConversationView,
	ConvReplayResult,
	ExtensionUIResponse,
	OpenConversationRequest,
	RpcCommand,
} from "@pi-web/shared";
import { isPlainObject } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/types.js";
import { contentDisposition } from "./files.js";
import {
	THINKING_LEVELS,
	badRequest,
	bodyObject,
	optBool,
	optEnum,
	optInt,
	optObject,
	optString,
	queryInt,
	reqString,
} from "./util.js";
import type { Json } from "./util.js";

type WsParams = { Params: { wsId: string } };
type ConvParams = { Params: { convId: string } };

function parseOpenRequest(value: unknown): OpenConversationRequest {
	const body = bodyObject(value);
	const request: OpenConversationRequest = {};
	const sessionFile = optString(body, "sessionFile", { max: 4096 });
	if (sessionFile !== undefined) {
		if (!sessionFile.startsWith("/")) throw badRequest("会话文件必须是绝对路径");
		request.sessionFile = sessionFile;
	}
	const model = optObject(body, "model");
	if (model) request.model = { provider: reqString(model, "provider", { max: 200 }), modelId: reqString(model, "modelId", { max: 400 }) };
	const thinkingLevel = optEnum(body, "thinkingLevel", THINKING_LEVELS);
	if (thinkingLevel) request.thinkingLevel = thinkingLevel;
	const name = optString(body, "name", { max: 500 });
	if (name !== undefined) request.name = name;
	return request;
}

function parseUiResponse(value: unknown): ExtensionUIResponse {
	const body = bodyObject(value);
	const response = optObject(body, "response");
	if (!response) throw badRequest("缺少字段 response");
	const id = reqString(response, "id", { max: 500 });
	if (response.cancelled === true) return { type: "extension_ui_response", id, cancelled: true };
	if (typeof response.confirmed === "boolean") return { type: "extension_ui_response", id, confirmed: response.confirmed };
	if (typeof response.value === "string") return { type: "extension_ui_response", id, value: response.value };
	throw badRequest("response 必须包含 value、confirmed 或 cancelled");
}

export function conversationRoutes(app: FastifyInstance, ctx: AppContext): void {
	const conversations = () => ctx.conversations;

	app.get("/conversations", async (): Promise<{ conversations: ConversationView[] }> => ({
		conversations: conversations().list(),
	}));

	app.post<WsParams>("/workspaces/:wsId/conversations", async (request): Promise<ConversationView> =>
		conversations().open(request.params.wsId, parseOpenRequest(request.body)),
	);

	app.get<ConvParams>("/conversations/:convId/snapshot", async (request): Promise<ConversationSnapshot> =>
		conversations().snapshot(request.params.convId),
	);

	app.post<ConvParams>("/conversations/:convId/rpc", async (request) => {
		const body = bodyObject(request.body);
		const command = body.command;
		if (!isPlainObject(command) || typeof command.type !== "string" || command.type === "") {
			throw badRequest("command 必须是带 type 字段的 pi RPC 命令");
		}
		const timeoutMs = optInt(body, "timeoutMs", 1000, 60 * 60_000);
		return conversations().rpc(request.params.convId, command as unknown as RpcCommand, timeoutMs);
	});

	app.post<ConvParams>("/conversations/:convId/ui-response", async (request): Promise<ConversationUiResponseResult> => {
		const { delivered } = await conversations().uiResponse(request.params.convId, parseUiResponse(request.body));
		return { ok: true, delivered };
	});

	app.post<ConvParams>("/conversations/:convId/navigate", async (request): Promise<CompanionActionResponse> => {
		const body = bodyObject(request.body);
		const args: Json = { targetId: reqString(body, "targetId", { max: 200 }) };
		const summarize = optBool(body, "summarize");
		if (summarize !== undefined) args.summarize = summarize;
		const customInstructions = optString(body, "customInstructions", { max: 100_000 });
		if (customInstructions !== undefined) args.customInstructions = customInstructions;
		const label = optString(body, "label", { max: 500 });
		if (label !== undefined) args.label = label;
		return conversations().companion(request.params.convId, "navigate", args);
	});

	app.post<ConvParams>("/conversations/:convId/label", async (request): Promise<CompanionActionResponse> => {
		const body = bodyObject(request.body);
		const args: Json = { entryId: reqString(body, "entryId", { max: 200 }) };
		const label = optString(body, "label", { max: 500, allowEmpty: true });
		if (label !== undefined && label !== "") args.label = label;
		return conversations().companion(request.params.convId, "label", args);
	});

	app.post<ConvParams>("/conversations/:convId/reload", async (request): Promise<CompanionActionResponse> =>
		conversations().companion(request.params.convId, "reload", {}),
	);

	app.post<ConvParams>("/conversations/:convId/stop", async (request) => {
		const force = optBool(bodyObject(request.body), "force") ?? false;
		await conversations().stop(request.params.convId, force);
		return { ok: true as const };
	});

	app.get<ConvParams>("/conversations/:convId/replay", async (request): Promise<ConvReplayResult> => {
		const afterSeq = queryInt(request.query as Json, "afterSeq", 0, Number.MAX_SAFE_INTEGER) ?? 0;
		return conversations().replay(request.params.convId, afterSeq);
	});

	app.get<ConvParams>("/conversations/:convId/export", async (request, reply) => {
		const { stream, size, fileName } = await conversations().exportHtml(request.params.convId);
		reply
			.header("content-type", "text/html; charset=utf-8")
			.header("content-disposition", contentDisposition(fileName))
			.header("cache-control", "no-store");
		if (Number.isFinite(size) && size >= 0) reply.header("content-length", String(size));
		return reply.send(stream);
	});
}
