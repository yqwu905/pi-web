import { describe, expect, it } from "vitest";
import { isAutoLoadableImage } from "./Markdown";

describe("isAutoLoadableImage", () => {
	const origin = "http://127.0.0.1:7878";
	it("loads only data:/blob: and same-origin images", () => {
		expect(isAutoLoadableImage("data:image/png;base64,AAAA", origin)).toBe(true);
		expect(isAutoLoadableImage("blob:http://127.0.0.1:7878/123", origin)).toBe(true);
		expect(isAutoLoadableImage("/assets/logo.png", origin)).toBe(true);
		expect(isAutoLoadableImage("logo.png", origin)).toBe(true);
		expect(isAutoLoadableImage("http://127.0.0.1:7878/x.png", origin)).toBe(true);
	});

	it("never auto-loads remote or other-port URLs", () => {
		expect(isAutoLoadableImage("https://attacker.example/p?d=c2VjcmV0", origin)).toBe(false);
		expect(isAutoLoadableImage("http://127.0.0.1:9999/x", origin)).toBe(false);
		expect(isAutoLoadableImage("//attacker.example/x.png", origin)).toBe(false);
		expect(isAutoLoadableImage("data:text/html,<b>x</b>", origin)).toBe(false);
	});
});
