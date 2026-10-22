/** Small pure helpers shared by host, agent and browser. */

/** pi's session directory name for a cwd: "--<path without leading slash, / \\ : replaced by ->--". */
export function encodeCwdForSessions(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Host name matching for proxy allowlists. Patterns: exact host ("api.openai.com"),
 * wildcard subdomain ("*.example.com" matches a.example.com and example.com), or "*".
 */
export function matchDomain(host: string, patterns: readonly string[]): boolean {
	const h = host.toLowerCase().replace(/\.$/, "");
	for (const raw of patterns) {
		const p = raw.trim().toLowerCase();
		if (!p) continue;
		if (p === "*") return true;
		if (p.startsWith("*.")) {
			const base = p.slice(2);
			if (h === base || h.endsWith(`.${base}`)) return true;
		} else if (h === p) {
			return true;
		}
	}
	return false;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge for JSON-like objects: objects merge recursively, everything else (arrays included) replaces. */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = out[key];
		out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
	}
	return out as T;
}

/** Formats bytes as "12.3 MB" style text. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes)) return "-";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (Math.abs(value) >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Quote a string for POSIX sh. */
export function shellQuote(value: string): string {
	if (value === "") return "''";
	if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
