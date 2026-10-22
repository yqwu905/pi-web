import { describe, expect, it } from "vitest";
import { fileNameFromDisposition } from "./client";

describe("fileNameFromDisposition", () => {
	it("prefers the UTF-8 filename* over the ASCII fallback that precedes it", () => {
		// What the server sends (routes/files.ts contentDisposition).
		const header = `attachment; filename="UI ___.html"; filename*=UTF-8''UI%20%E9%87%8D%E5%91%BD%E5%90%8D.html`;
		expect(fileNameFromDisposition(header)).toBe("UI 重命名.html");
	});

	it("falls back to the plain filename", () => {
		expect(fileNameFromDisposition(`attachment; filename="session.html"`)).toBe("session.html");
		expect(fileNameFromDisposition("attachment; filename=plain.html")).toBe("plain.html");
		expect(fileNameFromDisposition(`attachment; filename="ok.html"; filename*=UTF-8''%E0%A4%A`)).toBe("ok.html");
	});

	it("returns undefined without a file name", () => {
		expect(fileNameFromDisposition(null)).toBeUndefined();
		expect(fileNameFromDisposition("inline")).toBeUndefined();
	});
});
