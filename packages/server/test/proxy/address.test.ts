import { describe, expect, it } from "vitest";
import { classifyAddress, isHostLocalAddress, isNumericHostShorthand, normalizeIp } from "../../src/proxy/address.js";
import { matchHostPattern } from "../../src/proxy/domains.js";

describe("classifyAddress", () => {
	it("classifies IPv4 ranges", () => {
		expect(classifyAddress("127.0.0.1")).toBe("loopback");
		expect(classifyAddress("127.255.0.9")).toBe("loopback");
		expect(classifyAddress("0.0.0.0")).toBe("unspecified");
		expect(classifyAddress("10.0.0.1")).toBe("private");
		expect(classifyAddress("172.31.255.255")).toBe("private");
		expect(classifyAddress("172.32.0.1")).toBe("public");
		expect(classifyAddress("192.168.0.1")).toBe("private");
		expect(classifyAddress("169.254.169.254")).toBe("link-local");
		expect(classifyAddress("100.64.0.1")).toBe("cgnat");
		expect(classifyAddress("224.0.0.1")).toBe("multicast");
		expect(classifyAddress("255.255.255.255")).toBe("reserved");
		expect(classifyAddress("8.8.8.8")).toBe("public");
		// Fake-IP answers of local TUN proxies must keep working.
		expect(classifyAddress("198.18.0.5")).toBe("public");
	});

	it("classifies IPv6 ranges and embedded IPv4", () => {
		expect(classifyAddress("::1")).toBe("loopback");
		expect(classifyAddress("::")).toBe("unspecified");
		expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
		expect(classifyAddress("::ffff:7f00:1")).toBe("loopback");
		expect(classifyAddress("::ffff:10.0.0.1")).toBe("private");
		expect(classifyAddress("::127.0.0.1")).toBe("loopback");
		expect(classifyAddress("64:ff9b::a9fe:a9fe")).toBe("link-local");
		expect(classifyAddress("2002:7f00:1::1")).toBe("loopback");
		expect(classifyAddress("fe80::1%eth0")).toBe("link-local");
		expect(classifyAddress("fd12:3456::1")).toBe("ula");
		expect(classifyAddress("ff02::1")).toBe("multicast");
		expect(classifyAddress("2606:4700::1111")).toBe("public");
		expect(classifyAddress("not-an-ip")).toBe("reserved");
	});

	it("recognizes this machine's own addresses", () => {
		const own = new Set(["192.0.2.10"]);
		expect(isHostLocalAddress("192.0.2.10", own)).toBe(true);
		expect(isHostLocalAddress("::ffff:192.0.2.10", own)).toBe(true);
		expect(isHostLocalAddress("127.0.0.5", own)).toBe(true);
		expect(isHostLocalAddress("93.184.216.34", own)).toBe(false);
		expect(normalizeIp("::FFFF:192.0.2.10")).toBe("192.0.2.10");
	});

	it("rejects numeric host shorthands", () => {
		for (const host of ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "0", "1.2.3"]) expect(isNumericHostShorthand(host), host).toBe(true);
		for (const host of ["127.0.0.1", "api.example.com", "1.example", "x1"]) expect(isNumericHostShorthand(host), host).toBe(false);
	});
});

describe("matchHostPattern", () => {
	it("matches region placeholders within one label only", () => {
		expect(matchHostPattern("bedrock-runtime.us-east-1.amazonaws.com", "bedrock-runtime.{aws-region}.amazonaws.com")).toBe(true);
		expect(matchHostPattern("bedrock-runtime.us-gov-west-1.amazonaws.com", "bedrock-runtime.{aws-region}.amazonaws.com")).toBe(true);
		expect(matchHostPattern("bedrock-runtime.s3.amazonaws.com", "bedrock-runtime.{aws-region}.amazonaws.com")).toBe(false);
		expect(matchHostPattern("bedrock-runtime.x.us-east-1.amazonaws.com", "bedrock-runtime.{aws-region}.amazonaws.com")).toBe(false);
		expect(matchHostPattern("us-central1-aiplatform.googleapis.com", "{gcp-region}-aiplatform.googleapis.com")).toBe(true);
		expect(matchHostPattern("evil.storage-aiplatform.googleapis.com", "{gcp-region}-aiplatform.googleapis.com")).toBe(false);
		expect(matchHostPattern("api.individual.githubcopilot.com", "*.githubcopilot.com")).toBe(true);
		expect(matchHostPattern("githubcopilot.com.evil", "*.githubcopilot.com")).toBe(false);
	});
});
