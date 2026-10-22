import { describe, expect, it } from "vitest";
import { escapeHtml, highlightCode, resolveLanguage, splitHighlightedLines } from "./highlight";

describe("highlightCode", () => {
	it("highlights by explicit language and by filename", () => {
		const py = highlightCode("def f():\n    return 1", { filename: "a.py" });
		expect(py.language).toBe("python");
		expect(py.html).toContain('<span class="hljs-keyword">def</span>');
		const ts = highlightCode("const x = 1;", { language: "ts" });
		expect(ts.language).toBe("typescript");
	});
	it("escapes plain text", () => {
		const r = highlightCode("<b>&</b>", { language: "plaintext" });
		expect(r.html).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
		expect(escapeHtml('"')).toBe("&quot;");
	});
	it("resolves only registered languages", () => {
		expect(resolveLanguage({ filename: "Dockerfile" })).toBe("dockerfile");
		expect(resolveLanguage({ language: "nope" })).toBeUndefined();
	});
});

describe("splitHighlightedLines", () => {
	it("splits plain lines", () => {
		expect(splitHighlightedLines("a\nb\n")).toEqual(["a", "b", ""]);
	});
	it("re-opens spans across line breaks", () => {
		const html = 'x <span class="hljs-string">"a\nb"</span> y';
		expect(splitHighlightedLines(html)).toEqual(['x <span class="hljs-string">"a</span>', '<span class="hljs-string">b"</span> y']);
	});
	it("handles nested spans", () => {
		const html = '<span class="a"><span class="b">1\n2</span>3\n4</span>';
		expect(splitHighlightedLines(html)).toEqual([
			'<span class="a"><span class="b">1</span></span>',
			'<span class="a"><span class="b">2</span>3</span>',
			'<span class="a">4</span>',
		]);
	});
	it("matches highlight.js output line count", () => {
		const code = '"""doc\nstring"""\nx = 1';
		const { html } = highlightCode(code, { language: "python" });
		expect(splitHighlightedLines(html)).toHaveLength(3);
	});
});
