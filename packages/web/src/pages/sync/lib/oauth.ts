/** OAuth keeper display (pure): remaining validity, refresh countdown and push coverage. */
import type { OAuthProviderStatus, ServerView } from "@pi-web/shared";
import { formatDurationZh } from "../../../lib/format";

/** Assumed token lifetime when the last refresh time is unknown (bar scale). */
export const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60_000;

export interface OAuthProgress {
	remainingMs: number;
	/** 0..1 of the token lifetime still left (bar width). */
	ratio: number;
	expired: boolean;
	/** ms until the keeper refreshes (≤ 0: due now). */
	refreshInMs: number;
	pushedOk: number;
	pushedTotal: number;
	/** Servers the latest token did not reach. */
	missing: Array<{ serverId: string; name: string; error?: string }>;
	tone: "accent" | "warning" | "danger";
}

export function oauthProgress(p: OAuthProviderStatus, servers: readonly ServerView[], now: number): OAuthProgress {
	const remainingMs = p.expiresAt - now;
	const lifetime = p.lastRefreshAt && p.expiresAt > p.lastRefreshAt ? p.expiresAt - p.lastRefreshAt : DEFAULT_TOKEN_LIFETIME_MS;
	const ratio = Math.max(0, Math.min(1, remainingMs / lifetime));
	const names = new Map(servers.map((s) => [s.config.id, s.config.name]));
	const missing = p.pushed
		.filter((x) => !x.ok)
		.map((x) => ({ serverId: x.serverId, name: names.get(x.serverId) ?? x.serverId, ...(x.error ? { error: x.error } : {}) }));
	const expired = remainingMs <= 0;
	return {
		remainingMs,
		ratio,
		expired,
		refreshInMs: p.refreshAt - now,
		pushedOk: p.pushed.filter((x) => x.ok).length,
		pushedTotal: p.pushed.length,
		missing,
		tone: expired || p.error ? "danger" : remainingMs < 15 * 60_000 ? "warning" : "accent",
	};
}

/** "剩余 42 分钟" / "已过期". */
export function remainingText(progress: Pick<OAuthProgress, "remainingMs" | "expired">): string {
	return progress.expired ? "已过期" : `剩余 ${formatDurationZh(progress.remainingMs)}`;
}

/** "下次刷新约 32 分钟后" / "即将刷新". */
export function refreshText(refreshInMs: number): string {
	return refreshInMs <= 30_000 ? "即将刷新" : `下次刷新约 ${formatDurationZh(refreshInMs)}后`;
}

/** "已推送 2/3 台（staging-db 离线）". */
export function pushedText(progress: Pick<OAuthProgress, "pushedOk" | "pushedTotal" | "missing">, isOffline: (serverId: string) => boolean): string {
	if (progress.pushedTotal === 0) return "尚未推送到服务器";
	const base = `已推送 ${progress.pushedOk}/${progress.pushedTotal} 台`;
	if (progress.missing.length === 0) return base;
	const detail = progress.missing.map((m) => (isOffline(m.serverId) ? `${m.name} 离线` : `${m.name} 失败`)).join("、");
	return `${base}（${detail}）`;
}
