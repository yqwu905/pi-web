/**
 * OAuthKeeper: refreshes the host's OAuth credentials with pi's own logic (ModelRuntime.getAuth,
 * which refreshes under pi's auth.json file lock) and pushes auth.json to the servers whenever
 * it changes, so servers only ever hold short-lived access tokens.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { isPlainObject, type OAuthProviderStatus, type OAuthStatusResponse } from "@pi-web/shared";
import { ApiError, type AppContext, type AuthSyncedEvent, type OAuthKeeper } from "../core/types.js";

export type OAuthKeeperContext = Pick<AppContext, "paths" | "log" | "store" | "hub" | "hostPi" | "syncer">;

export interface OAuthKeeperOptions {
	/** Check period (default 60s). */
	intervalMs?: number;
	/** Refresh when a token expires within this margin (default 20 min). */
	refreshMarginMs?: number;
	/** Wait this long after a failed refresh before retrying automatically (default 5 min). */
	retryDelayMs?: number;
	/** Watch auth.json for changes (default true); the periodic check also detects changes. */
	watch?: boolean;
	/** Debounce for auth.json change events (default 300ms). */
	changeDebounceMs?: number;
	now?: () => number;
}

interface PushResult {
	at: number;
	ok: boolean;
	error?: string;
}

/** Persisted under store state key "oauth". */
interface OAuthState {
	lastRefreshAt: Record<string, number>;
	pushed: Record<string, PushResult>;
}

interface OAuthEntry {
	provider: string;
	expires: number;
	access?: unknown;
}

const STATE_KEY = "oauth";

function errorMessage(err: unknown): string {
	const e = err as { message?: unknown; cause?: { message?: unknown } };
	const base = typeof e?.message === "string" ? e.message : String(err);
	return typeof e?.cause?.message === "string" && !base.includes(e.cause.message) ? `${base}: ${e.cause.message}` : base;
}

class OAuthKeeperImpl implements OAuthKeeper {
	private readonly intervalMs: number;
	private readonly marginMs: number;
	private readonly retryDelayMs: number;
	private readonly now: () => number;
	private state: OAuthState = { lastRefreshAt: {}, pushed: {} };
	private readonly errors = new Map<string, { at: number; message: string }>();
	private readonly inflight = new Map<string, Promise<void>>();
	private lastHash: string | undefined;
	/** Last seen expiry per provider: an increase means someone (us or the host pi) refreshed it. */
	private readonly lastExpires = new Map<string, number>();
	private checkChain: Promise<void> = Promise.resolve();
	private timer: NodeJS.Timeout | undefined;
	private changeTimer: NodeJS.Timeout | undefined;
	private watcher: FSWatcher | undefined;
	private ticking: Promise<void> | undefined;
	private started = false;

	constructor(
		private readonly ctx: OAuthKeeperContext,
		private readonly options: OAuthKeeperOptions,
	) {
		this.intervalMs = options.intervalMs ?? 60_000;
		this.marginMs = options.refreshMarginMs ?? 20 * 60_000;
		this.retryDelayMs = options.retryDelayMs ?? 5 * 60_000;
		this.now = options.now ?? Date.now;
	}

	private get authPath(): string {
		return join(this.ctx.paths.hostAgentDir, "auth.json");
	}

	/** Regular syncs (deploy, manual, auto, connect) deliver auth.json too: record them as pushes. */
	private readonly onAuthSynced = (event: AuthSyncedEvent): void => {
		if (!this.started) return;
		this.state.pushed[event.serverId] = { at: event.at, ok: event.ok, ...(event.error ? { error: event.error } : {}) };
		void this.saveState().then(() => this.publish());
	};

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const stored = this.ctx.store.getState<OAuthState>(STATE_KEY);
		this.state = { lastRefreshAt: { ...stored?.lastRefreshAt }, pushed: { ...stored?.pushed } };
		this.ctx.syncer.on("auth-synced", this.onAuthSynced);
		const initial = await this.readAuthFile();
		this.lastHash = initial.hash;
		for (const entry of initial.entries) this.lastExpires.set(entry.provider, entry.expires);
		if (this.options.watch !== false) await this.openWatcher();
		this.timer = setInterval(() => void this.tick(), this.intervalMs);
		this.timer.unref?.();
		await this.tick();
	}

	async rewatch(): Promise<void> {
		if (!this.started) return;
		const previous = this.watcher;
		this.watcher = undefined;
		await previous?.close();
		if (!this.started || this.watcher) return;
		if (this.options.watch !== false) await this.openWatcher();
		this.ctx.log.info("auth.json watcher moved", { path: this.authPath });
		this.onAuthFileEvent();
	}

	private async openWatcher(): Promise<void> {
		const watcher = watch(this.authPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } });
		this.watcher = watcher;
		watcher.on("all", () => {
			if (this.watcher === watcher) this.onAuthFileEvent();
		});
		watcher.on("error", (err) => this.ctx.log.warn("auth.json watcher error", { error: errorMessage(err) }));
		await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
	}

	async stop(): Promise<void> {
		this.started = false;
		this.ctx.syncer.off("auth-synced", this.onAuthSynced);
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.changeTimer) clearTimeout(this.changeTimer);
		this.changeTimer = undefined;
		const watcher = this.watcher;
		this.watcher = undefined;
		await watcher?.close();
		await this.ticking?.catch(() => {});
		await this.checkChain.catch(() => {});
	}

	async status(): Promise<OAuthStatusResponse> {
		const entries = (await this.readAuthFile()).entries;
		const pushed = this.pushedForServers();
		const providers = entries.map((entry): OAuthProviderStatus => {
			const status: OAuthProviderStatus = {
				provider: entry.provider,
				expiresAt: entry.expires,
				refreshAt: entry.expires - this.marginMs,
				pushed,
			};
			const lastRefreshAt = this.state.lastRefreshAt[entry.provider];
			if (lastRefreshAt) status.lastRefreshAt = lastRefreshAt;
			const error = this.errors.get(entry.provider);
			if (error) status.error = error.message;
			return status;
		});
		return { providers };
	}

	async refresh(provider: string): Promise<OAuthStatusResponse> {
		const entry = (await this.readAuthFile()).entries.find((e) => e.provider === provider);
		if (!entry) throw new ApiError(404, "OAUTH_NOT_FOUND", `Host 的 auth.json 中没有 ${provider} 的 OAuth 凭据`);
		await this.refreshProvider(provider, true);
		const error = this.errors.get(provider);
		if (error) throw new ApiError(502, "OAUTH_REFRESH_FAILED", `刷新 ${provider} 的 OAuth 凭据失败：${error.message}`);
		return this.status();
	}

	/** One periodic pass: detect missed auth.json changes, refresh tokens close to expiry. */
	tick(): Promise<void> {
		if (this.ticking) return this.ticking;
		this.ticking = this.runTick().finally(() => {
			this.ticking = undefined;
		});
		return this.ticking;
	}

	private async runTick(): Promise<void> {
		try {
			await this.checkChanged();
			const now = this.now();
			for (const entry of (await this.readAuthFile()).entries) {
				if (entry.expires - now >= this.marginMs) continue;
				const error = this.errors.get(entry.provider);
				if (error && now - error.at < this.retryDelayMs) continue;
				await this.refreshProvider(entry.provider, false);
			}
		} catch (err) {
			this.ctx.log.warn("oauth check failed", { error: errorMessage(err) });
		}
	}

	private refreshProvider(provider: string, force: boolean): Promise<void> {
		const running = this.inflight.get(provider);
		if (running) return running;
		const promise = this.doRefresh(provider, force).finally(() => this.inflight.delete(provider));
		this.inflight.set(provider, promise);
		return promise;
	}

	private async doRefresh(provider: string, force: boolean): Promise<void> {
		const before = (await this.readAuthFile()).entries.find((e) => e.provider === provider);
		if (!before) return;
		const remaining = before.expires - this.now();
		const minOAuthValidityMs = force ? Math.max(this.marginMs, remaining + 60_000) : this.marginMs;
		let failure: unknown;
		try {
			const runtime = await this.ctx.hostPi.modelRuntime();
			await runtime.getAuth(provider, { minOAuthValidityMs });
		} catch (err) {
			failure = err;
		}
		const after = (await this.readAuthFile()).entries.find((e) => e.provider === provider);
		const refreshed = Boolean(after && (after.expires !== before.expires || after.access !== before.access));
		if (refreshed) {
			this.errors.delete(provider);
			this.state.lastRefreshAt[provider] = this.now();
			await this.saveState();
			this.ctx.log.info("oauth token refreshed", { provider, expiresAt: after?.expires });
		} else if (failure) {
			this.errors.set(provider, { at: this.now(), message: errorMessage(failure) });
			this.ctx.log.warn("oauth refresh failed", { provider, error: errorMessage(failure) });
		} else if (after && after.expires - this.now() < this.marginMs) {
			this.errors.set(provider, { at: this.now(), message: "pi 没有刷新该凭据（可能不支持刷新或需要重新登录）" });
		}
		await this.checkChanged();
		this.publish();
	}

	private onAuthFileEvent(): void {
		if (this.changeTimer) clearTimeout(this.changeTimer);
		this.changeTimer = setTimeout(() => {
			this.changeTimer = undefined;
			void this.checkChanged();
		}, this.options.changeDebounceMs ?? 300);
		this.changeTimer.unref?.();
	}

	/** Pushes auth.json to the servers when its content differs from the last seen version. */
	private checkChanged(): Promise<void> {
		const next = this.checkChain.then(async () => {
			const { hash, entries } = await this.readAuthFile();
			if (hash === this.lastHash) return;
			this.lastHash = hash;
			let refreshed = false;
			for (const entry of entries) {
				const previous = this.lastExpires.get(entry.provider);
				if (previous !== undefined && entry.expires > previous) {
					this.state.lastRefreshAt[entry.provider] = this.now();
					this.errors.delete(entry.provider);
					refreshed = true;
				}
				this.lastExpires.set(entry.provider, entry.expires);
			}
			if (refreshed) await this.saveState();
			await this.push();
		});
		this.checkChain = next.catch((err: unknown) => this.ctx.log.warn("auth push failed", { error: errorMessage(err) }));
		return this.checkChain;
	}

	private async push(): Promise<void> {
		const results = await this.ctx.syncer.pushAuth();
		const at = this.now();
		for (const result of results) {
			const entry: PushResult = { at, ok: result.ok };
			if (result.error) entry.error = result.error;
			this.state.pushed[result.serverId] = entry;
		}
		if (results.length > 0) {
			this.ctx.log.info("auth.json pushed", { servers: results.map((r) => `${r.serverId}:${r.ok ? "ok" : "error"}`) });
		}
		await this.saveState();
		this.publish();
	}

	private pushedForServers(): OAuthProviderStatus["pushed"] {
		const servers = this.ctx.store.listServers().filter((server) => !server.jumpOnly && server.sync.items.auth);
		return servers
			.filter((server) => this.state.pushed[server.id])
			.map((server) => {
				const result = this.state.pushed[server.id];
				const item: OAuthProviderStatus["pushed"][number] = { serverId: server.id, at: result.at, ok: result.ok };
				if (result.error) item.error = result.error;
				return item;
			});
	}

	private publish(): void {
		void this.status()
			.then((status) => this.ctx.hub.publish("oauth", status))
			.catch(() => {});
	}

	private async saveState(): Promise<void> {
		await this.ctx.store
			.setState(STATE_KEY, this.state)
			.catch((err: unknown) => this.ctx.log.warn("failed to persist oauth state", { error: errorMessage(err) }));
	}

	/** Reads auth.json without resolving or exposing any secret. */
	private async readAuthFile(): Promise<{ hash: string; entries: OAuthEntry[] }> {
		let text = "";
		try {
			text = await readFile(this.authPath, "utf8");
		} catch {
			return { hash: "", entries: [] };
		}
		const hash = createHash("sha256").update(text).digest("hex");
		const entries: OAuthEntry[] = [];
		try {
			const data = JSON.parse(text.replace(/^﻿/, "")) as unknown;
			if (isPlainObject(data)) {
				for (const [provider, credential] of Object.entries(data)) {
					if (!isPlainObject(credential) || credential.type !== "oauth" || typeof credential.expires !== "number") continue;
					entries.push({ provider, expires: credential.expires, access: credential.access });
				}
			}
		} catch {
			// invalid JSON: report no OAuth entries
		}
		entries.sort((a, b) => a.provider.localeCompare(b.provider));
		return { hash, entries };
	}
}

export function createOAuthKeeper(ctx: OAuthKeeperContext, options: OAuthKeeperOptions = {}): OAuthKeeper {
	return new OAuthKeeperImpl(ctx, options);
}
