/**
 * Address classification for the tunnel proxy: a remote may only reach the host's own
 * loopback, private networks or link-local services when the user allowed that exact target.
 */
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export type AddressKind =
	| "public"
	| "loopback"
	| "unspecified"
	| "private"
	| "link-local"
	| "ula"
	| "cgnat"
	| "multicast"
	| "reserved";

function ipv4Octets(ip: string): number[] | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
	return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : undefined;
}

function classifyIpv4(octets: number[]): AddressKind {
	const [a, b] = octets;
	if (a === 0) return "unspecified";
	if (a === 127) return "loopback";
	if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
	if (a === 169 && b === 254) return "link-local";
	if (a === 100 && b >= 64 && b <= 127) return "cgnat";
	if (a === 192 && b === 0 && octets[2] === 0) return "reserved";
	if (a >= 224 && a <= 239) return "multicast";
	if (a >= 240) return "reserved";
	// 198.18.0.0/15 stays "public": local proxies in TUN/fake-IP mode answer DNS with it.
	return "public";
}

/** The 8 16-bit groups of an IPv6 address (zone id dropped), or undefined. */
function ipv6Groups(input: string): number[] | undefined {
	let ip = input.replace(/%.*$/, "").toLowerCase();
	let tail: number[] = [];
	if (ip.includes(".")) {
		// Trailing dotted IPv4 ("::ffff:1.2.3.4"): two groups; keep a "::" right before it.
		const lastColon = ip.lastIndexOf(":");
		const v4 = ipv4Octets(ip.slice(lastColon + 1));
		if (!v4) return undefined;
		tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
		ip = ip.slice(0, lastColon + 1);
		if (!ip.endsWith("::")) ip = ip.slice(0, -1);
	}
	const halves = ip.split("::");
	if (halves.length > 2) return undefined;
	const parse = (part: string): number[] | undefined => {
		if (part === "") return [];
		const groups = part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : NaN));
		return groups.every((n) => Number.isInteger(n)) ? groups : undefined;
	};
	const head = parse(halves[0]);
	const rest = halves.length === 2 ? parse(halves[1]) : [];
	if (!head || !rest) return undefined;
	const known = head.length + rest.length + tail.length;
	if (halves.length === 1) return known === 8 ? [...head, ...tail] : undefined;
	if (known > 7) return undefined;
	return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

function embeddedV4(hi: number, lo: number): number[] {
	return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function classifyIpv6(groups: number[]): AddressKind {
	const zeroPrefix = (n: number) => groups.slice(0, n).every((g) => g === 0);
	if (zeroPrefix(8)) return "unspecified";
	if (zeroPrefix(7) && groups[7] === 1) return "loopback";
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): classify the IPv4 address.
	if (zeroPrefix(5) && groups[5] === 0xffff) return classifyIpv4(embeddedV4(groups[6], groups[7]));
	if (zeroPrefix(6)) return classifyIpv4(embeddedV4(groups[6], groups[7]));
	// NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address as well.
	if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
		return classifyIpv4(embeddedV4(groups[6], groups[7]));
	}
	if (groups[0] === 0x2002) {
		const kind = classifyIpv4(embeddedV4(groups[1], groups[2]));
		if (kind !== "public") return kind;
	}
	if ((groups[0] & 0xffc0) === 0xfe80) return "link-local";
	if ((groups[0] & 0xffc0) === 0xfec0) return "private";
	if ((groups[0] & 0xfe00) === 0xfc00) return "ula";
	if ((groups[0] & 0xff00) === 0xff00) return "multicast";
	return "public";
}

/** Classifies an IP address literal; anything that is not a valid IP is "reserved". */
export function classifyAddress(ip: string): AddressKind {
	const family = isIP(ip.replace(/%.*$/, ""));
	if (family === 4) {
		const octets = ipv4Octets(ip);
		return octets ? classifyIpv4(octets) : "reserved";
	}
	if (family === 6) {
		const groups = ipv6Groups(ip);
		return groups ? classifyIpv6(groups) : "reserved";
	}
	return "reserved";
}

export function isInternalAddress(ip: string): boolean {
	return classifyAddress(ip) !== "public";
}

/** Loopback, unspecified or an address of one of this machine's interfaces. */
export function isHostLocalAddress(ip: string, ownAddresses: ReadonlySet<string> = hostAddresses()): boolean {
	const kind = classifyAddress(ip);
	if (kind === "loopback" || kind === "unspecified") return true;
	return ownAddresses.has(normalizeIp(ip));
}

/** Lowercased, zone-less, IPv4-mapped IPv6 reduced to IPv4. */
export function normalizeIp(ip: string): string {
	const plain = ip.replace(/%.*$/, "").toLowerCase();
	if (isIP(plain) === 6) {
		const groups = ipv6Groups(plain);
		if (groups && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return embeddedV4(groups[6], groups[7]).join(".");
	}
	return plain;
}

/** Addresses of this machine's network interfaces (normalized). */
export function hostAddresses(): Set<string> {
	const out = new Set<string>();
	for (const list of Object.values(networkInterfaces())) {
		for (const info of list ?? []) out.add(normalizeIp(info.address));
	}
	return out;
}

/**
 * True for host names that are numeric IPv4 shorthands rather than DNS names ("127.1",
 * "2130706433", "0x7f.1", "0177.0.0.1"): resolvers turn them into addresses, but no real
 * host name ends in a numeric label.
 */
export function isNumericHostShorthand(host: string): boolean {
	if (isIP(host)) return false;
	const last = host.split(".").pop() ?? "";
	return /^(?:0x[0-9a-f]*|\d+)$/i.test(last);
}
