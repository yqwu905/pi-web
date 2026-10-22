import { describe, expect, it } from "vitest";
import { findJsonErrorOffset, formatOverride, jsonEqual, offsetToLineColumn, parseSettingsOverride, syntaxErrorPosition } from "./json-override";

describe("parseSettingsOverride", () => {
	it("accepts empty text and objects", () => {
		expect(parseSettingsOverride("  ")).toEqual({ ok: true, value: {}, warnings: [] });
		expect(parseSettingsOverride('{"defaultThinkingLevel":"medium","compaction":{"reserveTokens":8192}}')).toEqual({
			ok: true,
			value: { defaultThinkingLevel: "medium", compaction: { reserveTokens: 8192 } },
			warnings: [],
		});
	});

	it("rejects non-objects", () => {
		for (const text of ["[]", "1", '"x"', "null"]) {
			const r = parseSettingsOverride(text);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toContain("JSON 对象");
		}
	});

	it("reports syntax errors with a position", () => {
		const r = parseSettingsOverride('{\n  "a": 1,\n  "b": }');
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/^JSON 格式错误/);
			expect(r.line).toBe(3);
		}
	});

	it("warns about keys the host injects", () => {
		const r = parseSettingsOverride('{"shellCommandPrefix":"x","transport":"websocket"}');
		expect(r.ok && r.warnings.length).toBe(2);
	});
});

describe("position helpers", () => {
	it("converts offsets and engine messages", () => {
		expect(offsetToLineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
		expect(syntaxErrorPosition("Unexpected token } in JSON at position 4", "ab\ncd")).toEqual({ line: 2, column: 2 });
		expect(syntaxErrorPosition("Expected ',' (line 3 column 7)", "")).toEqual({ line: 3, column: 7 });
		expect(syntaxErrorPosition("Unexpected end of JSON input", '{"a":\n')).toEqual({ line: 2, column: 1 });
		expect(syntaxErrorPosition("weird", '{"a": 1}')).toBeUndefined();
	});

	it("scans for the first syntax error", () => {
		for (const ok of ['{"a":[1,-2.5e3,true,false,null,"x\\n\\u00e9"],"b":{}}', " [ ] ", '"s"', "0"]) {
			expect(findJsonErrorOffset(ok)).toBeUndefined();
		}
		expect(findJsonErrorOffset('{"a": }')).toBe(6);
		expect(findJsonErrorOffset('{"a": 1,}')).toBe(8);
		expect(findJsonErrorOffset("{a: 1}")).toBe(1);
		expect(findJsonErrorOffset('{"a": 01}')).toBe(7);
		expect(findJsonErrorOffset('{"a": 1} x')).toBe(9);
		expect(findJsonErrorOffset('{"a": "unterminated')).toBe(19);
		expect(findJsonErrorOffset("")).toBe(0);
	});
});

describe("formatting and equality", () => {
	it("formats and compares JSON values", () => {
		expect(formatOverride({})).toBe("{}");
		expect(formatOverride(undefined)).toBe("{}");
		expect(formatOverride({ a: 1 })).toBe('{\n  "a": 1\n}');
		expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
		expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
		expect(jsonEqual([1, 2], [2, 1])).toBe(false);
		expect(jsonEqual(null, {})).toBe(false);
	});
});
