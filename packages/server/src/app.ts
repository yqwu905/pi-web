/**
 * HTTP/WS front door of the host: Fastify with the REST API under /api, the event
 * WebSocket /ws, the terminal WebSocket /ws/term and (when built) the SPA.
 */
import { existsSync } from "node:fs";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { HostSettings, SshConfigHost } from "@pi-web/shared";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "./core/types.js";
import { createAccessControl } from "./routes/auth.js";
import type { AccessControl } from "./routes/auth.js";
import { errorBody, toErrorResponse } from "./routes/errors.js";
import { registerApiRoutes } from "./routes/index.js";
import { registerTerminalRoute } from "./term/index.js";
import type { TerminalOptions } from "./term/index.js";
import { isWsHub } from "./ws.js";
import type { WsHub } from "./ws.js";

declare module "fastify" {
	interface FastifyRequest {
		/** True when access-token auth is disabled or the request carried a valid token. */
		authenticated: boolean;
	}
}

export interface AppOptions {
	/** Development mode: also accept Origins of the Vite dev server (ports 5173/4173 on an allowed host). */
	dev?: boolean;
	/** EventHub serving /ws; defaults to ctx.hub when it can serve sockets. */
	hub?: WsHub;
	/** ~/.ssh/config reader for GET /api/ssh-config. */
	sshConfigHosts?: () => Promise<SshConfigHost[]>;
	/** Extra Origins (e.g. "http://localhost:3000") accepted for non-GET requests and WebSockets. */
	allowedOrigins?: string[];
	auth?: AccessControl;
	terminal?: TerminalOptions;
	/** The address actually listened on when it differs from settings.listenHost (CLI --host). */
	listenHost?: string;
	/** Max JSON body size (default 64 MiB: prompts may carry base64 images). */
	bodyLimit?: number;
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", ""]);
const DEV_PORTS = new Set(["5173", "4173"]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Host name part of a Host header ("[::1]:7878" → "::1"), lowercased. */
export function hostnameOf(hostHeader: string): string {
	const host = hostHeader.trim().toLowerCase();
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end > 0 ? host.slice(1, end) : host;
	}
	const colon = host.indexOf(":");
	return colon >= 0 ? host.slice(0, colon) : host;
}

function stripBrackets(host: string): string {
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Host names accepted in the Host header (DNS-rebinding protection): loopback names, the
 * configured listen host and any extra listen hosts (e.g. a --host override).
 */
export function allowedHostnames(settings: Pick<HostSettings, "listenHost">, extraListenHosts: string[] = []): Set<string> {
	const allowed = new Set(LOOPBACK_HOSTS);
	for (const raw of [settings.listenHost ?? "", ...extraListenHosts]) {
		const listen = stripBrackets(raw.trim().toLowerCase());
		if (WILDCARD_HOSTS.has(listen)) {
			// Listening on every interface: accept this machine's own names and addresses.
			allowed.add(osHostname().toLowerCase());
			for (const list of Object.values(networkInterfaces())) {
				for (const info of list ?? []) allowed.add(info.address.toLowerCase().replace(/%.*$/, ""));
			}
		} else {
			allowed.add(listen);
		}
	}
	return allowed;
}

export function isAllowedHost(
	hostHeader: string | undefined,
	settings: Pick<HostSettings, "listenHost">,
	extraListenHosts: string[] = [],
): boolean {
	if (!hostHeader) return false;
	return allowedHostnames(settings, extraListenHosts).has(hostnameOf(hostHeader));
}

/** True when the Origin URL and the Host header name the same host and port (default ports included). */
function sameEndpoint(origin: URL, hostHeader: string): boolean {
	const host = hostHeader.trim().toLowerCase();
	const hostname = hostnameOf(host);
	const bracketEnd = host.startsWith("[") ? host.indexOf("]") + 1 : 0;
	const colon = host.indexOf(":", bracketEnd);
	const defaultPort = origin.protocol === "https:" ? "443" : "80";
	const hostPort = colon >= 0 ? host.slice(colon + 1) : defaultPort;
	const originPort = origin.port || defaultPort;
	return stripBrackets(origin.hostname.toLowerCase()) === hostname && originPort === hostPort;
}

/** The Origin must name the same host:port as the Host header (dev mode: or the Vite dev server). */
export function isAllowedOrigin(
	origin: string,
	hostHeader: string,
	options: { dev?: boolean; extra?: string[]; settings: Pick<HostSettings, "listenHost">; listenHosts?: string[] },
): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (sameEndpoint(url, hostHeader)) return true;
	if (options.extra?.some((o) => o.replace(/\/+$/, "").toLowerCase() === url.origin.toLowerCase())) return true;
	if (options.dev && DEV_PORTS.has(url.port)) {
		return allowedHostnames(options.settings, options.listenHosts).has(stripBrackets(url.hostname.toLowerCase()));
	}
	return false;
}

function pathOf(url: string): string {
	const q = url.indexOf("?");
	return q >= 0 ? url.slice(0, q) : url;
}

function isApiOrWs(path: string): boolean {
	return path === "/api" || path.startsWith("/api/") || path === "/ws" || path.startsWith("/ws/");
}

/** Paths reachable without a token when access-token auth is on. */
const PUBLIC_API = new Set(["/api/meta", "/api/auth/login"]);

export async function buildApp(ctx: AppContext, options: AppOptions = {}): Promise<FastifyInstance> {
	const auth = options.auth ?? createAccessControl(ctx);
	const app = Fastify({ logger: false, bodyLimit: options.bodyLimit ?? 64 * 1024 * 1024, trustProxy: false });
	const log = ctx.log.child("http");
	const listenHosts = options.listenHost ? [options.listenHost] : [];

	app.decorateRequest("authenticated", false);

	// JSON bodies: tolerate an empty body (POST without payload) and drop "__proto__" keys.
	app.removeContentTypeParser("application/json");
	app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
		const text = typeof body === "string" ? body : body.toString("utf8");
		if (text.trim() === "") {
			done(null, undefined);
			return;
		}
		try {
			done(null, JSON.parse(text, (key, value) => (key === "__proto__" ? undefined : value)));
		} catch (err) {
			const error = err as Error & { statusCode?: number; code?: string };
			error.statusCode = 400;
			error.code = "INVALID_JSON";
			done(error, undefined);
		}
	});

	// Registered before the security hook: its own onRequest hook marks upgrade requests so that a
	// rejected handshake (reply sent from our hook) still gets its socket destroyed afterwards.
	await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 * 1024 } });

	app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
		reply.header("x-content-type-options", "nosniff");
		reply.header("x-frame-options", "DENY");
		reply.header("referrer-policy", "no-referrer");

		const settings = ctx.store.getSettings();
		const hostHeader = request.headers.host;
		if (!isAllowedHost(hostHeader, settings, listenHosts)) {
			return reply.code(403).send(errorBody("FORBIDDEN_HOST", "不允许的 Host 请求头"));
		}

		const isWebSocket = String(request.headers.upgrade ?? "").toLowerCase() === "websocket";
		const origin = request.headers.origin;
		const originOptions = { dev: options.dev, extra: options.allowedOrigins, settings, listenHosts };
		if (isWebSocket) {
			// Browsers always send Origin on WebSocket handshakes; non-browser clients may omit it.
			if (origin && !isAllowedOrigin(origin, hostHeader!, originOptions)) {
				return reply.code(403).send(errorBody("BAD_ORIGIN", "Origin 与 Host 不一致"));
			}
		} else if (!SAFE_METHODS.has(request.method)) {
			if (!origin) return reply.code(403).send(errorBody("MISSING_ORIGIN", "缺少 Origin 请求头"));
			if (!isAllowedOrigin(origin, hostHeader!, originOptions)) {
				return reply.code(403).send(errorBody("BAD_ORIGIN", "Origin 与 Host 不一致"));
			}
		}

		const path = pathOf(request.url);
		if (!auth.enabled()) {
			request.authenticated = true;
			return;
		}
		// "/?token=…" bootstrap: set the cookie (when valid) and drop the token from the address bar.
		if (request.method === "GET" && !isApiOrWs(path) && request.url.includes("token=")) {
			const url = new URL(request.url, "http://localhost");
			const token = url.searchParams.get("token");
			if (token !== null) {
				if (await auth.verify(token)) auth.setCookie(reply, token);
				url.searchParams.delete("token");
				return reply.redirect(url.pathname + url.search, 302);
			}
		}
		request.authenticated = await auth.isAuthenticated(request);
		if (request.authenticated || !isApiOrWs(path) || PUBLIC_API.has(path)) return;
		return reply.code(401).send(errorBody("UNAUTHORIZED", "需要访问令牌"));
	});

	app.setErrorHandler((err, request, reply) => {
		const { status, body } = toErrorResponse(err);
		if (status >= 500) {
			log.error("request failed", { method: request.method, url: pathOf(request.url), code: body.error.code, error: body.error.message });
		}
		return reply.code(status).send(body);
	});

	const hub = options.hub ?? (isWsHub(ctx.hub) ? ctx.hub : undefined);
	if (hub) {
		app.get("/ws", { websocket: true }, (socket) => hub.handleSocket(socket));
	} else {
		log.warn("event hub cannot serve sockets; /ws disabled");
	}
	registerTerminalRoute(app, ctx, options.terminal);

	await app.register(
		async (api) => {
			registerApiRoutes(api, ctx, { auth, sshConfigHosts: options.sshConfigHosts });
		},
		{ prefix: "/api" },
	);

	const webDir = ctx.paths.webDistDir;
	const spa = !!webDir && existsSync(join(webDir, "index.html"));
	if (spa) {
		await app.register(fastifyStatic, {
			root: webDir!,
			prefix: "/",
			cacheControl: false,
			setHeaders(reply, filePath) {
				if (filePath.endsWith(".html")) reply.header("cache-control", "no-cache");
				else if (/[\\/]assets[\\/]/.test(filePath)) reply.header("cache-control", "public, max-age=31536000, immutable");
				else reply.header("cache-control", "public, max-age=3600");
			},
		});
	}

	app.setNotFoundHandler((request, reply) => {
		const path = pathOf(request.url);
		if (isApiOrWs(path)) return reply.code(404).send(errorBody("NOT_FOUND", "接口不存在"));
		if (spa && SAFE_METHODS.has(request.method)) {
			return reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").sendFile("index.html");
		}
		return reply.code(404).send(errorBody("NOT_FOUND", "页面不存在"));
	});

	return app;
}
