/** Domain allowlist and NO_PROXY list helpers (same rules as the host's validation). */

/** Exact host, "*.example.com" or "*" (mirrors DOMAIN_PATTERN in the host's server routes). */
export const DOMAIN_PATTERN = /^(\*|(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)$/;

/** Accepts pasted URLs ("https://pypi.org/simple") and host:port, returning the bare host name. */
export function normalizeDomain(input: string): string {
	let d = input.trim().toLowerCase();
	d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	d = d.replace(/[/?#].*$/, "");
	d = d.replace(/^[^@]*@/, "");
	d = d.replace(/:\d+$/, "");
	return d.replace(/\.$/, "");
}

/** Error message, or null when `domain` (already normalized) is acceptable. */
export function validateDomain(domain: string, existing: readonly string[] = []): string | null {
	if (!domain) return "请输入域名";
	if (!DOMAIN_PATTERN.test(domain)) return "域名格式无效，例如 pypi.org 或 *.example.com";
	if (existing.includes(domain)) return "该域名已在列表中";
	return null;
}

/** Splits comma / whitespace / newline separated text into unique entries, order kept. */
export function parseList(text: string): string[] {
	const out: string[] = [];
	for (const part of text.split(/[\s,]+/)) {
		const v = part.trim();
		if (v && !out.includes(v)) out.push(v);
	}
	return out;
}

export function formatList(list: readonly string[]): string {
	return list.join(",");
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
