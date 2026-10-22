import { randomUUID } from "node:crypto";
import { SYNC_ITEM_KEYS } from "@pi-web/shared";
import type {
	AgentLogsResponse,
	CreateServerRequest,
	DeployRequest,
	FsListResponse,
	ProxyConfig,
	ServerAuth,
	ServerAuthInput,
	ServerView,
	SshConfigHost,
	SyncItemKey,
	TestConnectionResult,
	UninstallRequest,
	UpdateServerRequest,
} from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import { secretKeys } from "../core/secrets.js";
import { createServerConfig, mergeServerConfig, secretChange } from "../core/store.js";
import { ApiError } from "../core/types.js";
import type { AppContext } from "../core/types.js";
import { readSshConfig } from "../ssh/ssh-config.js";
import {
	badRequest,
	bodyObject,
	errorMessage,
	isRemoteAbsolute,
	optBool,
	optEnum,
	optInt,
	optObject,
	optString,
	optStringArray,
	queryBool,
	queryInt,
	queryString,
	reqString,
	requireAgent,
	requireServer,
	serverView,
} from "./util.js";
import type { Json } from "./util.js";

export interface ServerRouteOptions {
	/** Hosts from the user's ~/.ssh/config (provided by the ssh module). */
	sshConfigHosts?: () => Promise<SshConfigHost[]>;
}

type IdParams = { Params: { id: string } };

const DOMAIN_PATTERN = /^(\*|(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)$/;
const NO_WHITESPACE = /^\S+$/;

// ---------------------------------------------------------------- parsing

function parseAuth(value: unknown): ServerAuthInput {
	const auth = bodyObject(value);
	const method = optEnum(auth, "method", ["key", "password", "agent"] as const);
	if (!method) throw badRequest("缺少认证方式 auth.method");
	const keyPath = optString(auth, "keyPath", { max: 4096 })?.trim();
	if (method === "key" && !keyPath) throw badRequest("私钥认证需要填写私钥路径");
	const input: ServerAuthInput = { method };
	if (method === "key") input.keyPath = keyPath;
	if (auth.secret === null) input.secret = null;
	else if (auth.secret !== undefined) {
		if (typeof auth.secret !== "string") throw badRequest("字段 auth.secret 必须是字符串");
		input.secret = auth.secret;
	}
	return input;
}

function parseProxyPatch(value: unknown): Partial<ProxyConfig> {
	const body = bodyObject(value);
	const patch: Partial<ProxyConfig> = {};
	const mode = optEnum(body, "mode", ["off", "tunnel"] as const);
	if (mode) patch.mode = mode;
	const port = optInt(body, "port", 1024, 65535);
	if (port !== undefined) patch.port = port;
	const scope = optEnum(body, "scope", ["llm", "tools"] as const);
	if (scope) patch.scope = scope;
	const toolsPolicy = optEnum(body, "toolsPolicy", ["allowlist", "all"] as const);
	if (toolsPolicy) patch.toolsPolicy = toolsPolicy;
	const extraDomains = optStringArray(body, "extraDomains", { maxItems: 500 });
	if (extraDomains) {
		const bad = extraDomains.find((d) => !DOMAIN_PATTERN.test(d));
		if (bad) throw badRequest(`域名格式无效：${bad}`);
		patch.extraDomains = [...new Set(extraDomains.map((d) => d.toLowerCase()))];
	}
	const noProxy = optStringArray(body, "noProxy", { maxItems: 500 });
	if (noProxy) {
		const bad = noProxy.find((d) => !NO_WHITESPACE.test(d) || d.includes(","));
		if (bad) throw badRequest(`NO_PROXY 条目无效：${bad}`);
		patch.noProxy = [...new Set(noProxy)];
	}
	return patch;
}

function parseSyncPatch(value: unknown): NonNullable<CreateServerRequest["sync"]> {
	const body = bodyObject(value);
	const patch: NonNullable<CreateServerRequest["sync"]> = {};
	const items = optObject(body, "items");
	if (items) {
		const parsed: Partial<Record<SyncItemKey, boolean>> = {};
		for (const [key, enabled] of Object.entries(items)) {
			if (!(SYNC_ITEM_KEYS as readonly string[]).includes(key)) throw badRequest(`未知的同步项：${key}`);
			if (typeof enabled !== "boolean") throw badRequest(`同步项 ${key} 必须是布尔值`);
			parsed[key as SyncItemKey] = enabled;
		}
		patch.items = parsed;
	}
	const auto = optBool(body, "auto");
	if (auto !== undefined) patch.auto = auto;
	const override = optObject(body, "settingsOverride");
	if (override) patch.settingsOverride = override;
	return patch;
}

/** Validates a CreateServerRequest (creating) or UpdateServerRequest body. */
export function parseServerRequest(body: Json, creating: boolean): UpdateServerRequest {
	const request: UpdateServerRequest = {};
	const name = creating ? reqString(body, "name", { max: 200 }) : optString(body, "name", { max: 200 });
	if (name !== undefined) request.name = name.trim();
	if ("group" in body) request.group = optString(body, "group", { max: 200, allowEmpty: true })?.trim() ?? "";
	const host = creating ? reqString(body, "host", { max: 255 }) : optString(body, "host", { max: 255 });
	if (host !== undefined) {
		if (!NO_WHITESPACE.test(host.trim())) throw badRequest("主机地址无效");
		request.host = host.trim();
	}
	const port = optInt(body, "port", 1, 65535);
	if (port !== undefined) request.port = port;
	const username = creating ? reqString(body, "username", { max: 255 }) : optString(body, "username", { max: 255 });
	if (username !== undefined) {
		if (!NO_WHITESPACE.test(username.trim())) throw badRequest("用户名无效");
		request.username = username.trim();
	}
	if (creating || body.auth !== undefined) request.auth = parseAuth(body.auth);
	const jumps = optStringArray(body, "jumpServerIds", { maxItems: 8 });
	if (jumps) request.jumpServerIds = jumps;
	const remoteRoot = optString(body, "remoteRoot", { max: 1024 })?.trim();
	if (remoteRoot !== undefined) {
		if (!isRemoteAbsolute(remoteRoot) || remoteRoot === "/" || remoteRoot === "~") {
			throw badRequest("远端安装目录必须是绝对路径或以 ~/ 开头");
		}
		request.remoteRoot = remoteRoot.replace(/\/+$/, "");
	}
	const agentDirMode = optEnum(body, "agentDirMode", ["isolated", "shared"] as const);
	if (agentDirMode) request.agentDirMode = agentDirMode;
	if (body.proxy !== undefined && body.proxy !== null) request.proxy = parseProxyPatch(body.proxy);
	if (body.sync !== undefined && body.sync !== null) request.sync = parseSyncPatch(body.sync);
	const idle = optInt(body, "idleTimeoutMin", 0, 7 * 24 * 60);
	if (idle !== undefined) request.idleTimeoutMin = idle;
	const trust = optEnum(body, "defaultTrust", ["approve", "no-approve"] as const);
	if (trust) request.defaultTrust = trust;
	const jumpOnly = optBool(body, "jumpOnly");
	if (jumpOnly !== undefined) request.jumpOnly = jumpOnly;
	return request;
}

function validateJumps(ctx: AppContext, serverId: string, jumps: string[]): void {
	if (new Set(jumps).size !== jumps.length) throw badRequest("跳板机列表有重复");
	for (const id of jumps) {
		if (id === serverId) throw badRequest("服务器不能作为自己的跳板机");
		if (!ctx.store.getServer(id)) throw badRequest(`跳板机不存在：${id}`);
	}
}

/** Applies the stored-secret part of an auth change (`server:<id>:secret`). */
async function applySecret(ctx: AppContext, serverId: string, input: ServerAuthInput | undefined, previous?: ServerAuth): Promise<void> {
	const change = secretChange(input, previous);
	if (change.action === "set") await ctx.secrets.set(secretKeys.serverSecret(serverId), change.value);
	else if (change.action === "clear") await ctx.secrets.delete(secretKeys.serverSecret(serverId));
}

function parseDeployRequest(value: unknown): DeployRequest {
	const body = bodyObject(value);
	const request: DeployRequest = {};
	const agentDirMode = optEnum(body, "agentDirMode", ["isolated", "shared"] as const);
	if (agentDirMode) request.agentDirMode = agentDirMode;
	const piVersion = optString(body, "piVersion", { max: 64 })?.trim();
	if (piVersion) {
		if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(piVersion)) throw badRequest("pi 版本格式无效");
		request.piVersion = piVersion.replace(/^v/, "");
	}
	const proxyMode = optEnum(body, "proxyMode", ["off", "tunnel"] as const);
	if (proxyMode) request.proxyMode = proxyMode;
	const proxyScope = optEnum(body, "proxyScope", ["llm", "tools"] as const);
	if (proxyScope) request.proxyScope = proxyScope;
	const force = optBool(body, "force");
	if (force !== undefined) request.force = force;
	const sync = optBool(body, "sync");
	if (sync !== undefined) request.sync = sync;
	return request;
}

/** Pushes a fresh AgentConfig to a connected agent after settings that affect it changed. */
async function reconfigureAgent(ctx: AppContext, serverId: string): Promise<void> {
	const client = ctx.connections.get(serverId).agentClient;
	if (!client || client.peer?.closed) return;
	try {
		await client.call("agent.configure", await ctx.deployer.buildAgentConfig(serverId));
	} catch (err) {
		ctx.log.warn("agent reconfigure failed", { serverId, error: errorMessage(err) });
	}
}

// ---------------------------------------------------------------- routes

export function serverRoutes(app: FastifyInstance, ctx: AppContext, options: ServerRouteOptions = {}): void {
	app.get("/ssh-config", async (): Promise<{ hosts: SshConfigHost[] }> => {
		const hosts = options.sshConfigHosts ? await options.sshConfigHosts() : readSshConfig();
		return { hosts };
	});

	app.get("/servers", async (): Promise<{ servers: ServerView[] }> => ({
		servers: ctx.store.listServers().map((s) => serverView(ctx, s)),
	}));

	app.post("/servers", async (request): Promise<ServerView> => {
		const input = parseServerRequest(bodyObject(request.body), true) as CreateServerRequest;
		const id = randomUUID();
		if (input.jumpServerIds) validateJumps(ctx, id, input.jumpServerIds);
		const config = createServerConfig(input, {
			id,
			settings: ctx.store.getSettings(),
			existingServers: ctx.store.listServers(),
		});
		await applySecret(ctx, id, input.auth);
		await ctx.store.saveServer(config);
		return serverView(ctx, config);
	});

	app.post("/servers/test", async (request): Promise<TestConnectionResult> => {
		const body = bodyObject(request.body);
		const host = reqString(body, "host", { max: 255 }).trim();
		const username = reqString(body, "username", { max: 255 }).trim();
		const port = optInt(body, "port", 1, 65535) ?? 22;
		const auth = parseAuth(body.auth);
		const jumpServerIds = optStringArray(body, "jumpServerIds", { maxItems: 8 });
		if (jumpServerIds) validateJumps(ctx, "", jumpServerIds);
		return ctx.connections.testConnection({ host, port, username, auth, ...(jumpServerIds ? { jumpServerIds } : {}) });
	});

	app.get<IdParams>("/servers/:id", async (request): Promise<ServerView> => serverView(ctx, requireServer(ctx, request.params.id)));

	app.put<IdParams>("/servers/:id", async (request): Promise<ServerView> => {
		const current = requireServer(ctx, request.params.id);
		const patch = parseServerRequest(bodyObject(request.body), false);
		if (patch.jumpServerIds) validateJumps(ctx, current.id, patch.jumpServerIds);
		const next = mergeServerConfig(current, patch);
		await applySecret(ctx, current.id, patch.auth, current.auth);
		await ctx.store.saveServer(next);
		const agentRelevant =
			patch.proxy !== undefined ||
			patch.idleTimeoutMin !== undefined ||
			patch.agentDirMode !== undefined ||
			patch.remoteRoot !== undefined;
		if (agentRelevant) await reconfigureAgent(ctx, current.id);
		return serverView(ctx, next);
	});

	app.delete<IdParams>("/servers/:id", async (request) => {
		const server = requireServer(ctx, request.params.id);
		const dependents = ctx.store.listServers().filter((s) => s.jumpServerIds.includes(server.id));
		if (dependents.length > 0) {
			throw new ApiError(
				409,
				"SERVER_IN_USE",
				`该服务器被用作其他服务器的跳板机：${dependents.map((s) => s.name).join("、")}`,
			);
		}
		await ctx.connections.remove(server.id);
		for (const ws of ctx.store.listWorkspaces(server.id)) await ctx.store.deleteWorkspace(ws.id);
		await ctx.secrets.delete(secretKeys.serverSecret(server.id));
		await ctx.secrets.delete(secretKeys.proxyToken(server.id));
		await ctx.store.deleteServer(server.id);
		return { ok: true as const };
	});

	app.post<IdParams>("/servers/:id/test", async (request): Promise<TestConnectionResult> => {
		const server = requireServer(ctx, request.params.id);
		return ctx.connections.testConnection({
			host: server.host,
			port: server.port,
			username: server.username,
			auth: { method: server.auth.method, ...(server.auth.keyPath ? { keyPath: server.auth.keyPath } : {}) },
			jumpServerIds: server.jumpServerIds,
			serverId: server.id,
		});
	});

	app.post<IdParams>("/servers/:id/trust-host-key", async (request): Promise<ServerView> => {
		const server = requireServer(ctx, request.params.id);
		const body = bodyObject(request.body);
		const fingerprint = reqString(body, "fingerprint", { max: 200 }).trim();
		const algorithm = reqString(body, "algorithm", { max: 100 }).trim();
		if (!/^SHA256:[A-Za-z0-9+/]+=*$/.test(fingerprint)) throw badRequest("主机指纹格式无效");
		await ctx.connections.trustHostKey(server.id, { algorithm, fingerprint });
		return serverView(ctx, requireServer(ctx, server.id));
	});

	app.post<IdParams>("/servers/:id/connect", async (request): Promise<ServerView> => {
		const server = requireServer(ctx, request.params.id);
		await ctx.connections.connect(server.id);
		return serverView(ctx, requireServer(ctx, server.id));
	});

	app.post<IdParams>("/servers/:id/disconnect", async (request): Promise<ServerView> => {
		const server = requireServer(ctx, request.params.id);
		await ctx.connections.disconnect(server.id);
		return serverView(ctx, requireServer(ctx, server.id));
	});

	app.post<IdParams>("/servers/:id/probe", async (request) => {
		const server = requireServer(ctx, request.params.id);
		return ctx.deployer.probe(server.id);
	});

	app.post<IdParams>("/servers/:id/deploy", async (request) => {
		const server = requireServer(ctx, request.params.id);
		return ctx.deployer.deploy(server.id, parseDeployRequest(request.body));
	});

	app.get<IdParams>("/servers/:id/deploy", async (request) => {
		const server = requireServer(ctx, request.params.id);
		return { job: ctx.deployer.getJob(server.id) ?? null };
	});

	app.post<IdParams>("/servers/:id/deploy/cancel", async (request) => {
		const server = requireServer(ctx, request.params.id);
		ctx.deployer.cancel(server.id);
		return { ok: true as const };
	});

	app.post<IdParams>("/servers/:id/restart-agent", async (request) => {
		const server = requireServer(ctx, request.params.id);
		await ctx.deployer.restartAgent(server.id);
		return { ok: true as const };
	});

	app.post<IdParams>("/servers/:id/uninstall", async (request) => {
		const server = requireServer(ctx, request.params.id);
		const body = bodyObject(request.body);
		const uninstall: UninstallRequest = { keepSessions: optBool(body, "keepSessions") ?? true };
		await ctx.deployer.uninstall(server.id, uninstall);
		return { ok: true as const };
	});

	app.get<IdParams>("/servers/:id/agent-status", async (request) => {
		const client = await requireAgent(ctx, request.params.id);
		return client.call("agent.status", undefined);
	});

	app.get<IdParams>("/servers/:id/logs", async (request): Promise<AgentLogsResponse> => {
		const tail = queryInt(request.query as Json, "tail", 1, 10_000) ?? 200;
		const client = await requireAgent(ctx, request.params.id);
		const result = await client.call("agent.logs", { tail });
		return { lines: result.lines };
	});

	app.get<IdParams>("/servers/:id/proxy", async (request) => {
		const server = requireServer(ctx, request.params.id);
		return ctx.proxy.stats(server.id);
	});

	app.post<IdParams>("/servers/:id/proxy/allow", async (request): Promise<ServerView> => {
		const server = requireServer(ctx, request.params.id);
		const domain = reqString(bodyObject(request.body), "domain", { max: 255 }).trim().toLowerCase();
		if (!DOMAIN_PATTERN.test(domain)) throw badRequest(`域名格式无效：${domain}`);
		const updated = await ctx.proxy.allowDomain(server.id, domain);
		return serverView(ctx, updated);
	});

	app.get<IdParams>("/servers/:id/fs/list", async (request): Promise<FsListResponse> => {
		const query = request.query as Json;
		const path = queryString(query, "path") ?? "~";
		if (!isRemoteAbsolute(path)) throw badRequest("路径必须是绝对路径或以 ~ 开头");
		const client = await requireAgent(ctx, request.params.id);
		return client.call("fs.list", { path, showHidden: queryBool(query, "showHidden") ?? false });
	});

	app.post<IdParams>("/servers/:id/fs/mkdir", async (request) => {
		const path = reqString(bodyObject(request.body), "path", { max: 4096 }).trim();
		if (!isRemoteAbsolute(path)) throw badRequest("路径必须是绝对路径或以 ~ 开头");
		const client = await requireAgent(ctx, request.params.id);
		await client.call("fs.mkdir", { path, recursive: true });
		let resolved = path;
		try {
			resolved = (await client.call("fs.realpath", { path })).path;
		} catch {
			// keep the requested path
		}
		return { ok: true as const, path: resolved };
	});
}
