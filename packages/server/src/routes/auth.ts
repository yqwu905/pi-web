/**
 * Optional access token for the web UI.
 *
 * The token is never put in a cookie: browsers send cookies for 127.0.0.1/localhost to every
 * port of that host, so any other local listener would receive it. The SPA keeps the token in
 * origin-scoped (port-isolated) storage and sends it as `Authorization: Bearer …`; WebSocket
 * handshakes carry it as a `Sec-WebSocket-Protocol` entry (`pi-web.token.<token>`), and plain
 * browser downloads use a short-lived single-use ticket bound to one path (`?ticket=`).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../core/types.js";
import type { AppContext } from "../core/types.js";
import { bodyObject } from "./util.js";

/** Name of the cookie older versions used; it is cleared whenever a browser still sends it. */
export const TOKEN_COOKIE = "pi_web_token";
export const ACCESS_TOKEN_SECRET_KEY = "accessToken";
/** WebSocket sub-protocol the server selects; the token travels as a second, never-selected entry. */
export const WS_PROTOCOL = "pi-web";
export const WS_TOKEN_PROTOCOL_PREFIX = "pi-web.token.";
const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 1000;

export interface AccessControl {
	/** settings.accessTokenEnabled (read live). */
	enabled(): boolean;
	/** Returns the access token, generating and storing one when missing. */
	ensureToken(): Promise<string>;
	/** Replaces the token with a new random one (every client must sign in again). */
	rotateToken(): Promise<string>;
	/** True when the candidate equals the stored token. */
	verify(candidate: string | undefined): Promise<boolean>;
	/** True when auth is disabled or the request carries a valid token (or a valid ticket for its path). */
	isAuthenticated(request: FastifyRequest): Promise<boolean>;
	/** A single-use ticket that authenticates one GET of `path` within a minute. */
	issueTicket(path: string): { ticket: string; expiresAt: number };
	/** Forget the cached token (after it changed in the secret store). */
	invalidate(): void;
}

function sameSecret(candidate: string, token: string): boolean {
	const a = Buffer.from(candidate, "utf8");
	const b = Buffer.from(token, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

export function createAccessControl(ctx: Pick<AppContext, "store" | "secrets">): AccessControl {
	let cached: string | undefined;
	const tickets = new Map<string, { path: string; expiresAt: number }>();

	const load = async (): Promise<string | undefined> => {
		cached ??= await ctx.secrets.get(ACCESS_TOKEN_SECRET_KEY);
		return cached;
	};

	const pruneTickets = (now: number) => {
		for (const [key, value] of tickets) if (value.expiresAt <= now) tickets.delete(key);
		while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value as string);
	};

	const consumeTicket = (ticket: string, path: string): boolean => {
		const entry = tickets.get(ticket);
		if (!entry) return false;
		tickets.delete(ticket);
		return entry.expiresAt > Date.now() && entry.path === path;
	};

	const control: AccessControl = {
		enabled: () => ctx.store.getSettings().accessTokenEnabled === true,

		async ensureToken() {
			const existing = await load();
			if (existing) return existing;
			return control.rotateToken();
		},

		async rotateToken() {
			const token = randomBytes(24).toString("base64url");
			await ctx.secrets.set(ACCESS_TOKEN_SECRET_KEY, token);
			cached = token;
			tickets.clear();
			return token;
		},

		async verify(candidate) {
			if (!candidate) return false;
			const token = await load();
			if (!token) return false;
			return sameSecret(candidate, token);
		},

		async isAuthenticated(request) {
			if (!control.enabled()) return true;
			if (await control.verify(requestToken(request))) return true;
			const ticket = requestTicket(request);
			return ticket !== undefined && (request.method === "GET" || request.method === "HEAD") && consumeTicket(ticket, pathOf(request.url));
		},

		issueTicket(path) {
			const now = Date.now();
			pruneTickets(now);
			const ticket = randomBytes(24).toString("base64url");
			const expiresAt = now + TICKET_TTL_MS;
			tickets.set(ticket, { path, expiresAt });
			return { ticket, expiresAt };
		},

		invalidate() {
			cached = undefined;
			tickets.clear();
		},
	};
	return control;
}

function pathOf(url: string): string {
	const q = url.indexOf("?");
	return q >= 0 ? url.slice(0, q) : url;
}

/** Entries of a comma-separated header (Sec-WebSocket-Protocol). */
function headerList(value: string | string[] | undefined): string[] {
	const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Token from `Authorization: Bearer …` or, on a WebSocket handshake, the `pi-web.token.…` sub-protocol. */
export function requestToken(request: FastifyRequest): string | undefined {
	const authorization = request.headers.authorization;
	if (typeof authorization === "string") {
		const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
		if (match) return match[1].trim();
	}
	for (const protocol of headerList(request.headers["sec-websocket-protocol"])) {
		if (protocol.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) return protocol.slice(WS_TOKEN_PROTOCOL_PREFIX.length);
	}
	return undefined;
}

function requestTicket(request: FastifyRequest): string | undefined {
	const q = request.url.indexOf("?");
	if (q < 0) return undefined;
	return new URLSearchParams(request.url.slice(q + 1)).get("ticket") ?? undefined;
}

/** The sub-protocol to answer a WebSocket handshake with: never the token entry. */
export function selectWsProtocol(protocols: Set<string>): string | false {
	return protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false;
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		const name = part.slice(0, index).trim();
		const raw = part.slice(index + 1).trim();
		try {
			out[name] = decodeURIComponent(raw);
		} catch {
			out[name] = raw;
		}
	}
	return out;
}

/** Older versions stored the raw token in a cookie that leaks to other local ports: drop it. */
export function clearLegacyCookie(request: FastifyRequest, reply: FastifyReply): void {
	if (parseCookies(request.headers.cookie)[TOKEN_COOKIE] === undefined) return;
	reply.header("set-cookie", `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function authRoutes(app: FastifyInstance, auth: AccessControl): void {
	app.post("/auth/login", { config: { public: true } }, async (request) => {
		const body = bodyObject(request.body);
		const token = typeof body.token === "string" ? body.token.trim() : "";
		if (!auth.enabled()) return { ok: true as const };
		if (!(await auth.verify(token))) throw new ApiError(401, "INVALID_TOKEN", "访问令牌无效");
		return { ok: true as const };
	});

	/** A ticket for one plain browser GET (downloads), which cannot carry the Authorization header. */
	app.post("/auth/ticket", async (request) => {
		const body = bodyObject(request.body);
		const path = typeof body.path === "string" ? body.path : "";
		if (!path.startsWith("/api/") || path.length > 4096) throw new ApiError(400, "INVALID_PATH", "无效的路径");
		return auth.issueTicket(path);
	});

	/** Replaces the access token; the caller receives the new one, every other client must sign in again. */
	app.post("/auth/rotate", async () => {
		if (!auth.enabled()) throw new ApiError(409, "TOKEN_DISABLED", "访问令牌未启用");
		return { token: await auth.rotateToken() };
	});
}
