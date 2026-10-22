import { describe, expect, it } from "vitest";
import { matchesNoProxy, parseNoProxy } from "../../src/proxy/no-proxy.js";
import { formatAuthority, redactProxyUrl, selectUpstreamProxy } from "../../src/proxy/upstream.js";
import { normalizeDomainPattern } from "../../src/proxy/tunnel-proxy.js";

describe("NO_PROXY", () => {
	const entries = parseNoProxy("localhost, .corp.example,internal.test:8443  10.0.0.0/8,*.svc.cluster.local,[::1]");

	it("parses comma and space separated lists", () => {
		expect(entries).toEqual(["localhost", ".corp.example", "internal.test:8443", "10.0.0.0/8", "*.svc.cluster.local", "[::1]"]);
		expect(parseNoProxy(undefined)).toEqual([]);
	});

	it("matches hosts, suffixes, ports, CIDR ranges and IPv6", () => {
		expect(matchesNoProxy("localhost", 80, entries)).toBe(true);
		expect(matchesNoProxy("api.corp.example", 443, entries)).toBe(true);
		expect(matchesNoProxy("corp.example", 443, entries)).toBe(true);
		expect(matchesNoProxy("notcorp.example", 443, entries)).toBe(false);
		expect(matchesNoProxy("internal.test", 8443, entries)).toBe(true);
		expect(matchesNoProxy("internal.test", 443, entries)).toBe(false);
		expect(matchesNoProxy("10.20.30.40", 443, entries)).toBe(true);
		expect(matchesNoProxy("11.0.0.1", 443, entries)).toBe(false);
		expect(matchesNoProxy("db.svc.cluster.local", 5432, entries)).toBe(true);
		expect(matchesNoProxy("::1", 80, entries)).toBe(true);
		expect(matchesNoProxy("api.openai.com", 443, entries)).toBe(false);
		expect(matchesNoProxy("anything", 1, ["*"])).toBe(true);
	});
});

describe("upstream selection", () => {
	it("prefers settings.upstreamProxy, then HTTPS_PROXY, and honors NO_PROXY", () => {
		const env = { HTTPS_PROXY: "http://env-proxy:3128", NO_PROXY: "internal.test" };
		expect(selectUpstreamProxy("api.openai.com", 443, { env })?.host).toBe("env-proxy:3128");
		expect(selectUpstreamProxy("api.openai.com", 443, { env, configured: "http://set:8080" })?.host).toBe("set:8080");
		expect(selectUpstreamProxy("internal.test", 443, { env, configured: "http://set:8080" })).toBeUndefined();
		expect(selectUpstreamProxy("api.openai.com", 443, { env: { https_proxy: "proxy.lan:3128" } })?.href).toBe("http://proxy.lan:3128/");
		expect(selectUpstreamProxy("api.openai.com", 443, { env: {} })).toBeUndefined();
		expect(selectUpstreamProxy("api.openai.com", 443, { env: { HTTPS_PROXY: "socks5://x:1080" } })).toBeUndefined();
	});

	it("formats authorities and redacts credentials", () => {
		expect(formatAuthority("::1", 443)).toBe("[::1]:443");
		expect(formatAuthority("a.test", 80)).toBe("a.test:80");
		expect(redactProxyUrl(new URL("http://user:secret@proxy:3128"))).toBe("http://proxy:3128");
	});

	it("normalizes allowlist input", () => {
		expect(normalizeDomainPattern("API.Example.com.")).toBe("api.example.com");
		expect(normalizeDomainPattern("https://api.example.com:8443/v1")).toBe("api.example.com");
		expect(normalizeDomainPattern("*.example.com")).toBe("*.example.com");
		expect(normalizeDomainPattern("10.0.0.5")).toBe("10.0.0.5");
		expect(normalizeDomainPattern("bad domain")).toBeUndefined();
		expect(normalizeDomainPattern("")).toBeUndefined();
	});
});
