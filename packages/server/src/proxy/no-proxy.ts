/** NO_PROXY matching (curl/undici semantics plus IPv4 CIDR ranges). */
import { isIP } from "node:net";

export function parseNoProxy(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/[\s,]+/)
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

function ipv4ToInt(ip: string): number {
	return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function matchCidr(host: string, cidr: string): boolean {
	const [base, bitsText] = cidr.split("/");
	const bits = Number(bitsText);
	if (isIP(host) !== 4 || isIP(base) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return (ipv4ToInt(host) & mask) === (ipv4ToInt(base) & mask);
}

function splitHostPort(entry: string): { host: string; port?: number } {
	if (entry.startsWith("[")) {
		const end = entry.indexOf("]");
		const host = entry.slice(1, end < 0 ? undefined : end);
		const rest = end < 0 ? "" : entry.slice(end + 1);
		return rest.startsWith(":") ? { host, port: Number(rest.slice(1)) } : { host };
	}
	const colons = entry.split(":").length - 1;
	if (colons === 1) {
		const [host, port] = entry.split(":");
		return { host, port: Number(port) };
	}
	return { host: entry };
}

/** True when `host:port` must bypass the proxy according to `entries`. `port` 0 matches any port rule. */
export function matchesNoProxy(host: string, port: number, entries: readonly string[]): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	for (const raw of entries) {
		const entry = raw.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "*") return true;
		if (entry.includes("/")) {
			if (matchCidr(h, entry)) return true;
			continue;
		}
		const { host: ruleHost, port: rulePort } = splitHostPort(entry);
		if (rulePort && port && rulePort !== port) continue;
		const rule = ruleHost.replace(/^\*?\./, "");
		if (!rule) continue;
		if (h === rule || (!isIP(h) && h.endsWith(`.${rule}`))) return true;
	}
	return false;
}
