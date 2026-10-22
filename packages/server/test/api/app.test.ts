import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LinkRequestError } from "@pi-web/shared/link";
import { ApiError } from "../../src/core/types.js";
import { hostnameOf, isAllowedHost, isAllowedOrigin } from "../../src/app.js";
import { toErrorResponse } from "../../src/routes/errors.js";
import { HOST, ORIGIN, createTestApp } from "./helpers.js";
import type { TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
	await t?.app.close();
	t = undefined;
});

describe("host and origin checks", () => {
	it("parses Host headers", () => {
		expect(hostnameOf("[::1]:7878")).toBe("::1");
		expect(hostnameOf("LocalHost:80")).toBe("localhost");
		expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
	});

	it("accepts loopback names and the configured listen host only", () => {
		const settings = { listenHost: "127.0.0.1" };
		expect(isAllowedHost("127.0.0.1:7878", settings)).toBe(true);
		expect(isAllowedHost("localhost:7878", settings)).toBe(true);
		expect(isAllowedHost("[::1]:7878", settings)).toBe(true);
		expect(isAllowedHost("evil.example:7878", settings)).toBe(false);
		expect(isAllowedHost(undefined, settings)).toBe(false);
		expect(isAllowedHost("box.lan:7878", { listenHost: "box.lan" })).toBe(true);
		// A --host override is accepted next to the configured listen host.
		expect(isAllowedHost("192.168.1.5:7878", settings, ["192.168.1.5"])).toBe(true);
		expect(isAllowedHost("192.168.1.5:7878", settings)).toBe(false);
	});

	it("requires Origin to match Host, allowing the Vite port in dev mode", () => {
		const settings = { listenHost: "127.0.0.1" };
		expect(isAllowedOrigin("http://127.0.0.1:7878", "127.0.0.1:7878", { settings })).toBe(true);
		expect(isAllowedOrigin("http://localhost", "localhost:80", { settings })).toBe(true);
		expect(isAllowedOrigin("http://localhost:7879", "localhost:7878", { settings })).toBe(false);
		expect(isAllowedOrigin("http://evil.example", "127.0.0.1:7878", { settings })).toBe(false);
		expect(isAllowedOrigin("null", "127.0.0.1:7878", { settings })).toBe(false);
		expect(isAllowedOrigin("http://localhost:5173", "127.0.0.1:7878", { settings })).toBe(false);
		expect(isAllowedOrigin("http://localhost:5173", "127.0.0.1:7878", { settings, dev: true })).toBe(true);
		expect(isAllowedOrigin("http://evil.example:5173", "127.0.0.1:7878", { settings, dev: true })).toBe(false);
		expect(isAllowedOrigin("http://tool:3000", "127.0.0.1:7878", { settings, extra: ["http://tool:3000/"] })).toBe(true);
	});

	it("rejects foreign Host headers (DNS rebinding)", async () => {
		t = await createTestApp();
		const res = await t.request("GET", "/api/servers", undefined, { host: "attacker.example:7878" });
		expect(res.statusCode).toBe(403);
		expect(res.json()).toEqual({ error: { code: "FORBIDDEN_HOST", message: "不允许的 Host 请求头" } });
	});

	it("requires a matching Origin on state-changing requests", async () => {
		t = await createTestApp();
		const missing = await t.app.inject({ method: "POST", url: "/api/servers/x/connect", headers: { host: HOST } });
		expect(missing.statusCode).toBe(403);
		expect(missing.json().error.code).toBe("MISSING_ORIGIN");
		const cross = await t.request("POST", "/api/servers/x/connect", {}, { origin: "http://evil.example" });
		expect(cross.statusCode).toBe(403);
		expect(cross.json().error.code).toBe("BAD_ORIGIN");
		// Same origin passes the check (and then fails on the unknown server).
		const ok = await t.request("POST", "/api/servers/x/connect", {});
		expect(ok.statusCode).toBe(404);
		// GET needs no Origin.
		expect((await t.request("GET", "/api/servers")).statusCode).toBe(200);
	});

	it("accepts the Vite dev server origin in dev mode only", async () => {
		t = await createTestApp({ app: { dev: true } });
		const res = await t.request("PUT", "/api/settings", { prunePrebuilds: false }, { origin: "http://localhost:5173" });
		expect(res.statusCode).toBe(200);
	});

	it("sets defensive headers", async () => {
		t = await createTestApp();
		const res = await t.request("GET", "/api/meta");
		expect(res.headers["x-frame-options"]).toBe("DENY");
		expect(res.headers["x-content-type-options"]).toBe("nosniff");
		expect(res.headers["referrer-policy"]).toBe("no-referrer");
		const csp = String(res.headers["content-security-policy"]);
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("img-src 'self' data: blob:");
		expect(csp).toContain(`connect-src 'self' ws://${HOST} wss://${HOST}`);
		expect(csp).toContain("frame-ancestors 'none'");
		const odd = await t.request("GET", "/api/meta", undefined, { host: "127.0.0.1:7878;script-src *" });
		expect(String(odd.headers["content-security-policy"])).not.toContain("script-src *");
	});
});

describe("access token", () => {
	async function withToken(): Promise<TestApp> {
		const app = await createTestApp();
		app.store.settings.accessTokenEnabled = true;
		await app.secrets.set("accessToken", "tok-123");
		return app;
	}

	it("serves everything without a token when disabled", async () => {
		t = await createTestApp();
		const meta = await t.request("GET", "/api/meta");
		expect(meta.json()).toEqual({
			version: "9.9.9",
			hostname: expect.any(String),
			hostAgentDir: "/host/.pi/agent",
			hostPiVersion: "1.4.2",
			dataDir: "/data",
			authenticated: true,
		});
	});

	it("requires a bearer token for /api and clears the legacy cookie", async () => {
		t = await withToken();
		const denied = await t.request("GET", "/api/servers");
		expect(denied.statusCode).toBe(401);
		expect(denied.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "需要访问令牌" } });
		// The old cookie carried the raw token to every port of the host: ignored and deleted.
		const cookie = await t.request("GET", "/api/servers", undefined, { cookie: "a=b; pi_web_token=tok-123" });
		expect(cookie.statusCode).toBe(401);
		expect(String(cookie.headers["set-cookie"])).toContain("pi_web_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
		expect((await t.request("GET", "/api/servers", undefined, { authorization: "Bearer tok-123" })).statusCode).toBe(200);
		expect((await t.request("GET", "/api/servers", undefined, { authorization: "Bearer wrong" })).statusCode).toBe(401);
	});

	it("decides auth by the matched route, not by the raw URL", async () => {
		t = await withToken();
		for (const url of ["/%61pi/servers", "/%61pi/settings", "/api/%73ervers", "/a%70i/meta"]) {
			const res = await t.request("GET", url);
			expect(res.statusCode, url).toBe(400);
			expect(res.json().error.code).toBe("BAD_PATH");
		}
		const put = await t.request("PUT", "/%61pi/settings", { npmRegistry: "https://evil.example/" });
		expect(put.statusCode).toBe(400);
		expect(t.store.settings.npmRegistry).not.toBe("https://evil.example/");
		// Encoded reserved characters (e.g. in ids) are still fine.
		expect((await t.request("GET", "/api/servers/a%2Fb", undefined, { authorization: "Bearer tok-123" })).statusCode).toBe(404);
		expect((await t.request("GET", "/api/servers/a%2Fb")).statusCode).toBe(401);
	});

	it("keeps /api/meta public but reveals nothing without a token", async () => {
		t = await withToken();
		const meta = await t.request("GET", "/api/meta");
		expect(meta.statusCode).toBe(200);
		expect(meta.json()).toEqual({
			version: "9.9.9",
			hostname: "",
			hostAgentDir: "",
			hostPiVersion: null,
			dataDir: "",
			authenticated: false,
		});
	});

	it("logs in with POST /api/auth/login without setting a cookie", async () => {
		t = await withToken();
		const bad = await t.request("POST", "/api/auth/login", { token: "nope" });
		expect(bad.statusCode).toBe(401);
		expect(bad.json().error).toEqual({ code: "INVALID_TOKEN", message: "访问令牌无效" });
		const ok = await t.request("POST", "/api/auth/login", { token: "tok-123" });
		expect(ok.statusCode).toBe(200);
		expect(ok.json()).toEqual({ ok: true });
		expect(ok.headers["set-cookie"]).toBeUndefined();
	});

	it("authenticates one download with a single-use ticket bound to its path", async () => {
		t = await withToken();
		expect((await t.request("POST", "/api/auth/ticket", { path: "/api/servers" })).statusCode).toBe(401);
		const issued = await t.request("POST", "/api/auth/ticket", { path: "/api/servers" }, { authorization: "Bearer tok-123" });
		expect(issued.statusCode).toBe(200);
		const { ticket } = issued.json() as { ticket: string };
		expect((await t.request("GET", `/api/settings?ticket=${ticket}`)).statusCode).toBe(401);
		const other = (await t.request("POST", "/api/auth/ticket", { path: "/api/servers" }, { authorization: "Bearer tok-123" })).json().ticket;
		expect((await t.request("GET", `/api/servers?ticket=${other}`)).statusCode).toBe(200);
		expect((await t.request("GET", `/api/servers?ticket=${other}`)).statusCode).toBe(401);
	});

	it("rotates the token", async () => {
		t = await withToken();
		const res = await t.request("POST", "/api/auth/rotate", {}, { authorization: "Bearer tok-123" });
		expect(res.statusCode).toBe(200);
		const { token } = res.json() as { token: string };
		expect(token).not.toBe("tok-123");
		expect((await t.request("GET", "/api/servers", undefined, { authorization: "Bearer tok-123" })).statusCode).toBe(401);
		expect((await t.request("GET", "/api/servers", undefined, { authorization: `Bearer ${token}` })).statusCode).toBe(200);
	});

	it("generates a token and hands it to the browser that enabled it", async () => {
		t = await createTestApp();
		const res = await t.request("PUT", "/api/settings", { accessTokenEnabled: true });
		expect(res.statusCode).toBe(200);
		expect(res.json().accessTokenEnabled).toBe(true);
		const token = await t.secrets.get("accessToken");
		expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
		expect(res.json().issuedAccessToken).toBe(token);
		expect(res.headers["set-cookie"]).toBeUndefined();
		expect((await t.request("GET", "/api/servers")).statusCode).toBe(401);
		expect((await t.request("GET", "/api/servers", undefined, { authorization: `Bearer ${token}` })).statusCode).toBe(200);
		const again = await t.request("PUT", "/api/settings", { prunePrebuilds: false }, { authorization: `Bearer ${token}` });
		expect(again.json().issuedAccessToken).toBeUndefined();
	});
});

describe("error mapping", () => {
	it("maps ApiError, agent errors, Fastify client errors and unknown errors", () => {
		expect(toErrorResponse(new ApiError(409, "X", "冲突", { a: 1 }))).toEqual({
			status: 409,
			body: { error: { code: "X", message: "冲突", details: { a: 1 } } },
		});
		expect(toErrorResponse(new LinkRequestError("BUSY", "in use"))).toEqual({ status: 409, body: { error: { code: "BUSY", message: "in use" } } });
		expect(toErrorResponse(new LinkRequestError("TIMEOUT", "slow")).status).toBe(504);
		expect(toErrorResponse(Object.assign(new Error("v"), { validation: [] })).status).toBe(400);
		expect(toErrorResponse(Object.assign(new Error("big"), { statusCode: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE" }))).toEqual({
			status: 413,
			body: { error: { code: "FST_ERR_CTP_BODY_TOO_LARGE", message: "请求体过大" } },
		});
		expect(toErrorResponse(new Error("kaput"))).toEqual({ status: 500, body: { error: { code: "INTERNAL", message: "kaput" } } });
		expect(toErrorResponse("weird").status).toBe(500);
	});

	it("returns ApiErrorBody for invalid JSON, unknown API routes and thrown errors", async () => {
		t = await createTestApp();
		const invalid = await t.request("POST", "/api/sync/preview", "{nope", { "content-type": "application/json" });
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json().error.code).toBe("INVALID_JSON");
		const missing = await t.request("GET", "/api/does-not-exist");
		expect(missing.statusCode).toBe(404);
		expect(missing.json()).toEqual({ error: { code: "NOT_FOUND", message: "接口不存在" } });
		t.syncer.status = async () => {
			throw new Error("disk on fire");
		};
		const failed = await t.request("GET", "/api/sync/status");
		expect(failed.statusCode).toBe(500);
		expect(failed.json()).toEqual({ error: { code: "INTERNAL", message: "disk on fire" } });
	});

	it("accepts POST with an empty JSON body", async () => {
		t = await createTestApp();
		await t.store.saveServer((await import("./fakes.js")).makeServer());
		const res = await t.request("POST", "/api/servers/srv1/disconnect", "", { "content-type": "application/json" });
		expect(res.statusCode).toBe(200);
	});

	it("ignores __proto__ keys in JSON bodies", async () => {
		t = await createTestApp();
		const res = await t.request("PUT", "/api/settings", '{"__proto__": {"polluted": true}, "prunePrebuilds": false}', {
			"content-type": "application/json",
		});
		expect(res.statusCode).toBe(200);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("SPA hosting", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(path.join(tmpdir(), "pi-web-spa-"));
		writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Pi-Web</title>");
		mkdirSync(path.join(dir, "assets"));
		writeFileSync(path.join(dir, "assets", "app-123.js"), "console.log(1)");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("serves assets and falls back to index.html for client routes", async () => {
		t = await createTestApp({ webDistDir: dir });
		const root = await t.request("GET", "/");
		expect(root.statusCode).toBe(200);
		expect(root.body).toContain("<title>Pi-Web</title>");
		const route = await t.request("GET", "/w/ws1/chat/abc");
		expect(route.statusCode).toBe(200);
		expect(route.headers["content-type"]).toContain("text/html");
		expect(route.headers["cache-control"]).toBe("no-cache");
		const asset = await t.request("GET", "/assets/app-123.js");
		expect(asset.statusCode).toBe(200);
		expect(asset.headers["cache-control"]).toContain("immutable");
		expect(asset.body).toBe("console.log(1)");
		const api = await t.request("GET", "/api/nope");
		expect(api.statusCode).toBe(404);
		expect(api.json().error.code).toBe("NOT_FOUND");
		expect((await t.request("POST", "/whatever", {})).statusCode).toBe(404);
	});

	it("answers 404 for pages when the SPA is not built", async () => {
		t = await createTestApp({ webDistDir: null });
		const res = await t.request("GET", "/");
		expect(res.statusCode).toBe(404);
		expect(res.json().error.message).toBe("页面不存在");
	});
});

describe("request helper", () => {
	it("uses same-origin headers", () => {
		expect(ORIGIN).toBe(`http://${HOST}`);
	});
});
