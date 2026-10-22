import { describe, expect, it } from "vitest";
import { imageMimeType, isImagePath, isMarkdownPath, languageFromPath, languageLabel, normalizeLanguage } from "./languages";

describe("languageFromPath", () => {
	it("maps extensions", () => {
		expect(languageFromPath("src/data/loader.py")).toBe("python");
		expect(languageFromPath("/a/b/App.tsx")).toBe("typescript");
		expect(languageFromPath("pyproject.toml")).toBe("ini");
		expect(languageFromPath("README.md")).toBe("markdown");
		expect(languageFromPath("x.YAML")).toBe("yaml");
		expect(languageFromPath("kernel.cu")).toBe("cpp");
	});
	it("maps well-known file names", () => {
		expect(languageFromPath("Dockerfile")).toBe("dockerfile");
		expect(languageFromPath("deploy/Dockerfile.prod")).toBe("dockerfile");
		expect(languageFromPath("Makefile")).toBe("makefile");
		expect(languageFromPath(".env.local")).toBe("bash");
		expect(languageFromPath(".gitignore")).toBe("plaintext");
	});
	it("returns undefined for unknown names", () => {
		expect(languageFromPath("LICENSE")).toBeUndefined();
		expect(languageFromPath("archive.xyz")).toBeUndefined();
		expect(languageFromPath(undefined)).toBeUndefined();
	});
});

describe("labels and aliases", () => {
	it("labels languages", () => {
		expect(languageLabel("python")).toBe("Python");
		expect(languageLabel("ini", "pyproject.toml")).toBe("TOML");
		expect(languageLabel(undefined)).toBe("纯文本");
	});
	it("normalizes fence info strings", () => {
		expect(normalizeLanguage("py")).toBe("python");
		expect(normalizeLanguage("Shell")).toBe("bash");
		expect(normalizeLanguage("tsx")).toBe("typescript");
		expect(normalizeLanguage("haskell")).toBe("haskell");
		expect(normalizeLanguage("")).toBeUndefined();
	});
	it("detects previewable files", () => {
		expect(isImagePath("a/b.PNG")).toBe(true);
		expect(isImagePath("a/b.txt")).toBe(false);
		expect(imageMimeType("x.svg")).toBe("image/svg+xml");
		expect(isMarkdownPath("README.md")).toBe(true);
	});
});
