import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ApiError, type HostPi, type OAuthKeeper, type Syncer } from "../../src/core/types.js";
import { createOAuthKeeper } from "../../src/sync/oauth-keeper.js";
import { FakeHub, MemoryStore, makePaths, makeServer, noopLogger, put, tempDir, waitFor } from "./fakes.js";

const MIN = 60_000;
const keepers: OAuthKeeper[] = [];
afterEach(async () => {
	await Promise.all(keepers.splice(0).map((k) => k.stop()));
});

async function setup(options: { watch?: boolean; failRefresh?: boolean } = {}) {
	const dir = await tempDir("piweb-oauth-");
	const agentDir = join(dir, "agent");
	const authPath = join(agentDir, "auth.json");
	const now = Date.now();
	await put(
		authPath,
		JSON.stringify({
			anthropic: { type: "oauth", access: "a-1", refresh: "r-1", expires: now + 5 * MIN },
			"openai-codex": { type: "oauth", access: "c-1", refresh: "rc-1", expires: now + 120 * MIN },
			openai: { type: "api_key", key: "sk-secret" },
		}),
	);
	// Simulates pi's refresh: rotates the token in auth.json (under its lock in reality).
	const getAuth = vi.fn(async (provider: string, opts?: { minOAuthValidityMs?: number }) => {
		if (options.failRefresh) throw new Error("invalid_grant");
		const data = JSON.parse(await readFile(authPath, "utf8"));
		const cred = data[provider];
		if (Date.now() + (opts?.minOAuthValidityMs ?? 5 * MIN) >= cred.expires) {
			data[provider] = { ...cred, access: `${cred.access}+`, refresh: `${cred.refresh}+`, expires: Date.now() + 60 * MIN };
			await writeFile(authPath, JSON.stringify(data));
		}
		return { auth: {}, source: "OAuth" };
	});
	const runtime = { getAuth } as unknown as ModelRuntime;
	const hostPi: HostPi = { agentDir, version: async () => "1.4.0", modelRuntime: async () => runtime, invalidate() {} };
	const pushAuth = vi.fn(async () => [{ serverId: "s1", ok: true }]);
	const syncer = Object.assign(new EventEmitter(), { pushAuth }) as unknown as Syncer;
	const store = new MemoryStore([makeServer()]);
	const hub = new FakeHub();
	const paths = makePaths(agentDir, join(dir, "data"));
	const keeper = createOAuthKeeper(
		{ paths, log: noopLogger, store, hub, hostPi, syncer },
		{ intervalMs: 3600_000, watch: options.watch ?? false, changeDebounceMs: 50 },
	);
	keepers.push(keeper);
	return { dir, agentDir, authPath, paths, keeper, getAuth, pushAuth, syncer, store, hub };
}

describe("OAuthKeeper", () => {
	it("refreshes tokens close to expiry and pushes the new auth.json", async () => {
		const env = await setup();
		await env.keeper.start();
		expect(env.getAuth).toHaveBeenCalledTimes(1);
		expect(env.getAuth).toHaveBeenCalledWith("anthropic", { minOAuthValidityMs: 20 * MIN });
		expect(env.pushAuth).toHaveBeenCalledTimes(1);

		const status = await env.keeper.status();
		expect(status.providers.map((p) => p.provider)).toEqual(["anthropic", "openai-codex"]);
		const anthropic = status.providers[0];
		expect(anthropic.expiresAt).toBeGreaterThan(Date.now() + 50 * MIN);
		expect(anthropic.refreshAt).toBe(anthropic.expiresAt - 20 * MIN);
		expect(anthropic.lastRefreshAt).toBeGreaterThan(0);
		expect(anthropic.pushed).toEqual([{ serverId: "s1", at: expect.any(Number), ok: true }]);
		expect(status.providers[1].lastRefreshAt).toBeUndefined();
		expect(JSON.stringify(status)).not.toMatch(/sk-secret|a-1|r-1/);
		expect(env.store.getState<{ lastRefreshAt: Record<string, number> }>("oauth")?.lastRefreshAt.anthropic).toBeGreaterThan(0);
		await waitFor(() => env.hub.topic("oauth").length > 0);

		// A second pass finds nothing to refresh and nothing changed.
		await (env.keeper as unknown as { tick(): Promise<void> }).tick();
		expect(env.getAuth).toHaveBeenCalledTimes(1);
		expect(env.pushAuth).toHaveBeenCalledTimes(1);
	});

	it("records auth.json delivered by regular syncs (deploy, manual, auto) as pushed", async () => {
		const env = await setup();
		await env.keeper.start();
		env.syncer.emit("auth-synced", { serverId: "s1", at: 1234, ok: false, error: "disk full" });
		expect((await env.keeper.status()).providers[0].pushed).toEqual([{ serverId: "s1", at: 1234, ok: false, error: "disk full" }]);
		env.syncer.emit("auth-synced", { serverId: "s1", at: 5678, ok: true });
		expect((await env.keeper.status()).providers[0].pushed).toEqual([{ serverId: "s1", at: 5678, ok: true }]);
		await waitFor(() => env.store.getState<{ pushed: Record<string, { at: number }> }>("oauth")?.pushed.s1?.at === 5678);
		await env.keeper.stop();
		env.syncer.emit("auth-synced", { serverId: "s1", at: 9999, ok: true });
		expect(env.syncer.listenerCount("auth-synced")).toBe(0);
	});

	it("watches the auth.json of a changed host agent dir", async () => {
		const env = await setup({ watch: true });
		await env.keeper.start();
		expect(env.pushAuth).toHaveBeenCalledTimes(1);
		const newDir = join(env.dir, "other");
		const later = Date.now() + 120 * MIN;
		await put(join(newDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "n-1", refresh: "nr-1", expires: later } }));
		env.paths.hostAgentDir = newDir;
		await env.keeper.rewatch();
		await waitFor(() => env.pushAuth.mock.calls.length === 2, 5000);
		expect((await env.keeper.status()).providers).toMatchObject([{ provider: "anthropic", expiresAt: later }]);
		await writeFile(env.authPath, JSON.stringify({})); // the old file is no longer watched
		await new Promise((r) => setTimeout(r, 600));
		expect(env.pushAuth).toHaveBeenCalledTimes(2);
		await writeFile(join(newDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "n-2", refresh: "nr-1", expires: later + MIN } }));
		await waitFor(() => env.pushAuth.mock.calls.length === 3, 5000);
	});

	it("pushes when the host pi changes auth.json by itself", async () => {
		const env = await setup({ watch: true });
		await env.keeper.start();
		expect(env.pushAuth).toHaveBeenCalledTimes(1);
		const data = JSON.parse(await readFile(env.authPath, "utf8"));
		data["openai-codex"].access = "c-2";
		data["openai-codex"].expires += 60 * MIN;
		await writeFile(env.authPath, JSON.stringify(data));
		await waitFor(() => env.pushAuth.mock.calls.length === 2, 5000);
		expect(env.getAuth).toHaveBeenCalledTimes(1);
		const codex = (await env.keeper.status()).providers.find((p) => p.provider === "openai-codex")!;
		expect(codex.lastRefreshAt).toBeGreaterThan(0);
		expect(codex.expiresAt).toBe(data["openai-codex"].expires);
	});

	it("forces a refresh on demand", async () => {
		const env = await setup();
		await env.keeper.start();
		const before = (await env.keeper.status()).providers[1];
		const status = await env.keeper.refresh("openai-codex");
		const call = env.getAuth.mock.calls.at(-1)!;
		expect(call[0]).toBe("openai-codex");
		expect(call[1]!.minOAuthValidityMs).toBeGreaterThan(before.expiresAt - Date.now());
		expect(status.providers[1].lastRefreshAt).toBeGreaterThan(0);
		await expect(env.keeper.refresh("openai")).rejects.toMatchObject({ status: 404 });
	});

	it("reports refresh failures and backs off", async () => {
		const env = await setup({ failRefresh: true });
		await env.keeper.start();
		expect(env.getAuth).toHaveBeenCalledTimes(1);
		expect(env.pushAuth).not.toHaveBeenCalled();
		const status = await env.keeper.status();
		expect(status.providers[0].error).toContain("invalid_grant");
		await (env.keeper as unknown as { tick(): Promise<void> }).tick();
		expect(env.getAuth).toHaveBeenCalledTimes(1);
		const error = await env.keeper.refresh("anthropic").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(502);
	});
});
