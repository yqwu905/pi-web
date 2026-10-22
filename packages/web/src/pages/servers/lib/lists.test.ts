import { describe, expect, it } from "vitest";
import { parseAgentLogLine } from "./agent-log";
import { formatList, normalizeDomain, parseList, sameList, validateDomain } from "./lists";

describe("domains", () => {
	it("normalizes pasted URLs", () => {
		expect(normalizeDomain(" https://PyPI.org/simple/ ")).toBe("pypi.org");
		expect(normalizeDomain("files.pythonhosted.org:443")).toBe("files.pythonhosted.org");
		expect(normalizeDomain("user@host.example.com")).toBe("host.example.com");
		expect(normalizeDomain("*.example.com")).toBe("*.example.com");
		expect(normalizeDomain("example.com.")).toBe("example.com");
	});
	it("validates patterns and duplicates", () => {
		expect(validateDomain("pypi.org")).toBeNull();
		expect(validateDomain("*.hf.co")).toBeNull();
		expect(validateDomain("*")).toBeNull();
		expect(validateDomain("")).toBe("请输入域名");
		expect(validateDomain("bad domain")).toBeTruthy();
		expect(validateDomain("-x.com")).toBeTruthy();
		expect(validateDomain("pypi.org", ["pypi.org"])).toBe("该域名已在列表中");
	});
});

describe("lists", () => {
	it("splits on commas, spaces and newlines, deduplicating", () => {
		expect(parseList("localhost, 127.0.0.1\n::1  10.0.0.0/8,localhost,,")).toEqual(["localhost", "127.0.0.1", "::1", "10.0.0.0/8"]);
		expect(formatList(["a", "b"])).toBe("a,b");
		expect(sameList(["a"], ["a"])).toBe(true);
		expect(sameList(["a", "b"], ["b", "a"])).toBe(false);
	});
});

describe("agent log lines", () => {
	it("parses timestamp and level", () => {
		const line = parseAgentLogLine("2026-10-22T06:05:32.123Z WARN  proxy denied pypi.org {\"pid\":1}");
		expect(line.level).toBe("WARN");
		expect(line.message).toBe('proxy denied pypi.org {"pid":1}');
		expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		expect(parseAgentLogLine("garbage")).toEqual({ raw: "garbage", message: "garbage" });
	});
});
