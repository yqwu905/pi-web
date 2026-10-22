/** Optional access token for the web UI (cookie `pi_web_token` or `Authorization: Bearer`). */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../core/types.js";
import type { AppContext } from "../core/types.js";
import { bodyObject } from "./util.js";

export const TOKEN_COOKIE = "pi_web_token";
export const ACCESS_TOKEN_SECRET_KEY = "accessToken";
const COOKIE_MAX_AGE_SEC = 365 * 24 * 3600;

export interface AccessControl {
	/** settings.accessTokenEnabled (read live). */
	enabled(): boolean;
	/** Returns the access token, generating and storing one when missing. */
	ensureToken(): Promise<string>;
	/** True when the candidate equals the stored token. */
	verify(candidate: string | undefined): Promise<boolean>;
	/** True when auth is disabled or the request carries a valid token. */
	isAuthenticated(request: FastifyRequest): Promise<boolean>;
	setCookie(reply: FastifyReply, token: string): void;
	/** Forget the cached token (after it changed in the secret store). */
	invalidate(): void;
}

export function createAccessControl(ctx: Pick<AppContext, "store" | "secrets">): AccessControl {
	let cached: string | undefined;

	const load = async (): Promise<string | undefined> => {
		cached ??= await ctx.secrets.get(ACCESS_TOKEN_SECRET_KEY);
		return cached;
	};

	const control: AccessControl = {
		enabled: () => ctx.store.getSettings().accessTokenEnabled === true,

		async ensureToken() {
			const existing = await load();
			if (existing) return existing;
			const token = randomBytes(24).toString("base64url");
			await ctx.secrets.set(ACCESS_TOKEN_SECRET_KEY, token);
			cached = token;
			return token;
		},

		async verify(candidate) {
			if (!candidate) return false;
			const token = await load();
			if (!token) return false;
			const a = Buffer.from(candidate, "utf8");
			const b = Buffer.from(token, "utf8");
			return a.length === b.length && timingSafeEqual(a, b);
		},

		async isAuthenticated(request) {
			if (!control.enabled()) return true;
			return control.verify(requestToken(request));
		},

		setCookie(reply, token) {
			reply.header(
				"set-cookie",
				`${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SEC}`,
			);
		},

		invalidate() {
			cached = undefined;
		},
	};
	return control;
}

/** Token from `Authorization: Bearer …` or the `pi_web_token` cookie. */
export function requestToken(request: FastifyRequest): string | undefined {
	const authorization = request.headers.authorization;
	if (typeof authorization === "string") {
		const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
		if (match) return match[1].trim();
	}
	return parseCookies(request.headers.cookie)[TOKEN_COOKIE];
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

export function authRoutes(app: FastifyInstance, auth: AccessControl): void {
	app.post("/auth/login", async (request, reply) => {
		const body = bodyObject(request.body);
		const token = typeof body.token === "string" ? body.token.trim() : "";
		if (!auth.enabled()) return { ok: true as const };
		if (!(await auth.verify(token))) throw new ApiError(401, "INVALID_TOKEN", "访问令牌无效");
		auth.setCookie(reply, token);
		return { ok: true as const };
	});
}
