/**
 * Display formatting helpers. All user-visible output is Simplified Chinese / compact units
 * matching the artboards ("3 分钟前", "68.1k", "1.3 KB", "$0.62").
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function trimFixed(value: number, digits: number): string {
	return value.toFixed(digits);
}

/** "512 B", "1.3 KB", "28.9 MB", "312 MB", "118 GB". */
export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "-";
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	const sign = bytes < 0 ? "-" : "";
	let value = Math.abs(bytes);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	if (unit === 0) return `${sign}${Math.round(value)} B`;
	const text = value >= 100 ? String(Math.round(value)) : trimFixed(value, 1);
	return `${sign}${text} ${units[unit]}`;
}

/** Transfer rate, e.g. "6.1 MB/s". */
export function formatRate(bytesPerSecond: number): string {
	return `${formatBytes(bytesPerSecond)}/s`;
}

function startOfDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** "2026年3月5日" (other year) or "3月5日" (same year as `now`). */
export function formatDate(ms: number, now: number = Date.now()): string {
	const d = new Date(ms);
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	const md = `${d.getMonth() + 1}月${d.getDate()}日`;
	return sameYear ? md : `${d.getFullYear()}年${md}`;
}

/** "2026-10-22 09:14" (local time). */
export function formatDateTime(ms: number, withSeconds = false): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	return withSeconds ? `${base}:${p(d.getSeconds())}` : base;
}

/** "09:14" or "09:14:03". */
export function formatTime(ms: number, withSeconds = false): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return withSeconds ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Relative time in Chinese: "刚刚", "12 秒前", "3 分钟前", "2 小时前", "昨天", "3 天前",
 * "2 周前", then an absolute date. Future timestamps read "3 分钟后" etc.
 */
export function formatRelativeTime(ms: number | null | undefined, now: number = Date.now()): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
	const diff = now - ms;
	if (diff < 0) {
		const ahead = -diff;
		if (ahead < 10_000) return "马上";
		if (ahead < MINUTE) return `${Math.round(ahead / 1000)} 秒后`;
		if (ahead < HOUR) return `${Math.round(ahead / MINUTE)} 分钟后`;
		if (ahead < DAY) return `${Math.round(ahead / HOUR)} 小时后`;
		return `${Math.round(ahead / DAY)} 天后`;
	}
	if (diff < 10_000) return "刚刚";
	if (diff < MINUTE) return `${Math.floor(diff / 1000)} 秒前`;
	if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
	const today = startOfDay(now);
	if (diff < DAY && ms >= today) return `${Math.floor(diff / HOUR)} 小时前`;
	const days = Math.round((today - startOfDay(ms)) / DAY);
	if (days <= 1) return "昨天";
	if (days < 7) return `${days} 天前`;
	if (days < 30) return `${Math.floor(days / 7)} 周前`;
	return formatDate(ms, now);
}

/** Compact duration for tool timings: "0.3s", "4.2s", "12s", "3m 12s", "1h 05m". */
export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
	if (ms < 10_000) return `${trimFixed(ms / 1000, 1)}s`;
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) return `${totalMin}m ${String(totalSec % 60).padStart(2, "0")}s`;
	const hours = Math.floor(totalMin / 60);
	return `${hours}h ${String(totalMin % 60).padStart(2, "0")}m`;
}

/** Chinese duration for prose: "4.2 秒", "12 秒", "42 分钟", "3 小时 5 分钟", "3 天". */
export function formatDurationZh(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
	if (ms < 10_000) return `${trimFixed(ms / 1000, 1)} 秒`;
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec} 秒`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) return `${totalMin} 分钟`;
	const hours = Math.floor(totalMin / 60);
	if (hours < 24) {
		const min = totalMin % 60;
		return min ? `${hours} 小时 ${min} 分钟` : `${hours} 小时`;
	}
	const days = Math.floor(hours / 24);
	return `${days} 天`;
}

/** Stopwatch style: "0:10", "12:03", "1:02:03". */
export function formatClock(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Token counts: "980", "9.8k", "21.0k", "200k", "1.2M". Exact thousands drop the decimal. */
export function formatTokens(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "-";
	const abs = Math.abs(n);
	const sign = n < 0 ? "-" : "";
	if (abs < 1000) return `${sign}${Math.round(abs)}`;
	if (abs < 1_000_000) {
		if (abs % 1000 === 0) return `${sign}${abs / 1000}k`;
		const k = abs / 1000;
		if (k >= 999.95) return `${sign}1.0M`;
		return `${sign}${trimFixed(k, 1)}k`;
	}
	if (abs % 1_000_000 === 0) return `${sign}${abs / 1_000_000}M`;
	return `${sign}${trimFixed(abs / 1_000_000, 1)}M`;
}

/** Output throughput: "52 tok/s", "4.2 tok/s" below 10, "<0.1 tok/s" for a trickle. */
export function formatTokenRate(tokensPerSecond: number | null | undefined): string {
	if (tokensPerSecond === null || tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) return "-";
	if (tokensPerSecond === 0) return "0 tok/s";
	if (tokensPerSecond < 0.1) return "<0.1 tok/s";
	// 9.96 would round to "10.0": from there on whole numbers.
	if (tokensPerSecond < 9.95) return `${trimFixed(tokensPerSecond, 1)} tok/s`;
	return `${Math.round(tokensPerSecond)} tok/s`;
}

/** USD cost: "$0.00", "<$0.01", "$0.62", "$12.30", "$1,234". */
export function formatCost(usd: number | null | undefined): string {
	if (usd === null || usd === undefined || !Number.isFinite(usd)) return "-";
	if (usd === 0) return "$0.00";
	if (usd > 0 && usd < 0.01) return "<$0.01";
	if (usd < 1000) return `$${usd.toFixed(2)}`;
	return `$${Math.round(usd).toLocaleString("en-US")}`;
}

/** "1,234,567". */
export function formatNumber(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "-";
	return n.toLocaleString("en-US");
}

/** Ratio (0..1) → "34%"; values are clamped to [0, 100]. */
export function formatPercent(ratio: number | null | undefined, digits = 0): string {
	if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "-";
	const pct = Math.min(100, Math.max(0, ratio * 100));
	return `${pct.toFixed(digits)}%`;
}

/** Single-line preview of a text: collapses whitespace and truncates with "…". */
export function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Shortens "/home/dev/projects/x" to "~/projects/x" given the remote home. */
export function tildify(path: string, home: string | undefined): string {
	if (!home) return path;
	const h = home.replace(/\/+$/, "");
	if (path === h) return "~";
	if (path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`;
	return path;
}

/** Last path segment ("/a/b/c.txt" → "c.txt"). */
export function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const i = trimmed.lastIndexOf("/");
	return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
