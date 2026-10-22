import type { HostSettings, UpdateSettingsRequest } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/types.js";
import type { AccessControl } from "./auth.js";
import { badRequest, bodyObject, optBool, optEnum, optInt, optString, optStringArray } from "./util.js";
import type { Json } from "./util.js";

const SETTINGS_KEYS: ReadonlySet<string> = new Set<keyof HostSettings>([
	"nodeSource",
	"nodeCustomBaseUrl",
	"nodeVersion",
	"targetArchs",
	"piVersionPolicy",
	"piPinnedVersion",
	"npmRegistry",
	"prunePrebuilds",
	"upstreamProxy",
	"proxyPortRange",
	"defaultNoProxy",
	"listenHost",
	"listenPort",
	"accessTokenEnabled",
	"hostAgentDir",
]);

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function optUrl(body: Json, key: string): string | undefined {
	const value = optString(body, key, { max: 2048 });
	if (value === undefined) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw badRequest(`字段 ${key} 不是有效的 URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw badRequest(`字段 ${key} 必须是 http(s) 地址`);
	return value;
}

/** Validates an UpdateSettingsRequest. Optional string fields set to null or "" are cleared. */
export function parseSettingsPatch(input: unknown): UpdateSettingsRequest {
	const body = bodyObject(input);
	for (const key of Object.keys(body)) {
		if (!SETTINGS_KEYS.has(key)) throw badRequest(`未知的设置项：${key}`);
	}
	const patch: UpdateSettingsRequest = {};
	const has = (key: keyof HostSettings) => Object.prototype.hasOwnProperty.call(body, key);

	const nodeSource = optEnum(body, "nodeSource", ["official", "npmmirror", "custom"] as const);
	if (nodeSource) patch.nodeSource = nodeSource;
	if (has("nodeCustomBaseUrl")) patch.nodeCustomBaseUrl = optUrl(body, "nodeCustomBaseUrl");
	const nodeVersion = optString(body, "nodeVersion");
	if (nodeVersion !== undefined) {
		const v = nodeVersion.trim().replace(/^v/, "");
		if (v !== "latest-22" && !VERSION.test(v)) throw badRequest("Node 版本格式无效（例如 latest-22 或 22.20.0）");
		patch.nodeVersion = v;
	}
	if (has("targetArchs")) {
		const archs = optStringArray(body, "targetArchs") ?? [];
		if (archs.some((a) => a !== "x64" && a !== "arm64")) throw badRequest("targetArchs 只能包含 x64 / arm64");
		patch.targetArchs = [...new Set(archs)] as Array<"x64" | "arm64">;
	}
	const policy = optEnum(body, "piVersionPolicy", ["host", "pinned"] as const);
	if (policy) patch.piVersionPolicy = policy;
	if (has("piPinnedVersion")) {
		const pinned = optString(body, "piPinnedVersion")?.trim().replace(/^v/, "");
		if (pinned !== undefined && !VERSION.test(pinned)) throw badRequest("pi 版本格式无效（例如 1.4.2）");
		patch.piPinnedVersion = pinned;
	}
	if (has("npmRegistry")) patch.npmRegistry = optUrl(body, "npmRegistry");
	const prune = optBool(body, "prunePrebuilds");
	if (prune !== undefined) patch.prunePrebuilds = prune;
	if (has("upstreamProxy")) patch.upstreamProxy = optUrl(body, "upstreamProxy");
	if (has("proxyPortRange")) {
		const range = body.proxyPortRange;
		if (
			!Array.isArray(range) ||
			range.length !== 2 ||
			!range.every((n) => Number.isInteger(n) && n >= 1024 && n <= 65535) ||
			range[0] > range[1]
		) {
			throw badRequest("代理端口范围必须是 [起始, 结束]，取值 1024–65535");
		}
		patch.proxyPortRange = [range[0], range[1]];
	}
	if (has("defaultNoProxy")) patch.defaultNoProxy = optStringArray(body, "defaultNoProxy", { maxItems: 500 }) ?? [];
	const listenHost = optString(body, "listenHost", { max: 255 });
	if (listenHost !== undefined) {
		if (/\s/.test(listenHost)) throw badRequest("监听地址无效");
		patch.listenHost = listenHost.trim();
	}
	const listenPort = optInt(body, "listenPort", 1, 65535);
	if (listenPort !== undefined) patch.listenPort = listenPort;
	const tokenEnabled = optBool(body, "accessTokenEnabled");
	if (tokenEnabled !== undefined) patch.accessTokenEnabled = tokenEnabled;
	if (has("hostAgentDir")) patch.hostAgentDir = optString(body, "hostAgentDir", { max: 4096 })?.trim();
	return patch;
}

export function settingsRoutes(app: FastifyInstance, ctx: AppContext, auth: AccessControl): void {
	app.get("/settings", async (): Promise<HostSettings> => ctx.store.getSettings());

	app.put("/settings", async (request, reply): Promise<HostSettings> => {
		const patch = parseSettingsPatch(request.body);
		const before = ctx.store.getSettings();
		if (patch.nodeSource === "custom" || (patch.nodeSource === undefined && before.nodeSource === "custom")) {
			const base = "nodeCustomBaseUrl" in patch ? patch.nodeCustomBaseUrl : before.nodeCustomBaseUrl;
			if (!base) throw badRequest("使用自定义下载源时必须填写下载地址");
		}
		const updated = await ctx.store.updateSettings(patch);
		if (updated.accessTokenEnabled && !before.accessTokenEnabled) {
			// Keep the browser that enabled the token signed in.
			auth.setCookie(reply, await auth.ensureToken());
		}
		if ("hostAgentDir" in patch && patch.hostAgentDir !== before.hostAgentDir) ctx.hostPi.invalidate();
		return updated;
	});
}
