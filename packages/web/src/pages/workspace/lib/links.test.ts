import type { FsReadResult } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { countLines, fileMetaText, imageDataUrl, previewKind } from "./file-view";
import { chatPrefillPath, gitFilePath, mentionText } from "./links";

describe("links", () => {
	it("builds chat prefill URLs", () => {
		expect(chatPrefillPath("w1", "@src/a.py")).toBe("/w/w1/chat?prefill=%40src%2Fa.py");
		expect(chatPrefillPath("w1", "hi there", "s-1")).toBe("/w/w1/chat/s-1?prefill=hi+there");
		expect(new URLSearchParams(chatPrefillPath("w", "a&b=c\n").split("?")[1]).get("prefill")).toBe("a&b=c\n");
	});
	it("formats mentions", () => {
		expect(mentionText("src/data/loader.py")).toBe("@src/data/loader.py");
		expect(mentionText("docs/my notes.md")).toBe('@"docs/my notes.md"');
	});
	it("builds git links", () => {
		expect(gitFilePath("w1")).toBe("/w/w1/git");
		expect(gitFilePath("w1", "src/a.py", "staged")).toBe("/w/w1/git?path=src%2Fa.py&area=staged");
	});
});

const read = (over: Partial<FsReadResult> = {}): FsReadResult => ({
	path: "/w/x",
	size: 1331,
	mtimeMs: 1_000_000,
	encoding: "utf8",
	content: "a\nb\n",
	truncated: false,
	binary: false,
	...over,
});

describe("file view", () => {
	it("chooses the preview kind", () => {
		expect(previewKind("a.py", read())).toBe("code");
		expect(previewKind("README.md", read())).toBe("markdown");
		expect(previewKind("logo.png", read({ binary: true, encoding: "base64" }))).toBe("image");
		expect(previewKind("logo.png", read({ binary: true, encoding: "base64", truncated: true }))).toBe("binary");
		expect(previewKind("a.bin", read({ binary: true, encoding: "base64" }))).toBe("binary");
		expect(previewKind("icon.svg", read())).toBe("svg");
		expect(previewKind("icon.svg", read({ truncated: true }))).toBe("code");
	});
	it("builds data URLs", () => {
		expect(imageDataUrl("a.png", read({ encoding: "base64", content: "AAA" }))).toBe("data:image/png;base64,AAA");
		expect(imageDataUrl("a.svg", read({ content: "<svg/>" }))).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E");
		expect(imageDataUrl("a.txt", read())).toBeNull();
	});
	it("counts lines", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("a")).toBe(1);
		expect(countLines("a\nb\n")).toBe(2);
		expect(countLines("a\nb")).toBe(2);
	});
	it("describes files", () => {
		const now = 1_000_000 + 5 * 60_000;
		expect(fileMetaText("src/loader.py", read(), now)).toBe("Python · 2 行 · 1.3 KB · UTF-8 · 修改于 5 分钟前");
		expect(fileMetaText("x.toml", read({ truncated: true }), now)).toBe("TOML · 1.3 KB · UTF-8 · 修改于 5 分钟前");
		expect(fileMetaText("a.png", read({ binary: true, encoding: "base64" }), now)).toBe("image/png · 1.3 KB · base64 · 修改于 5 分钟前");
	});
});
