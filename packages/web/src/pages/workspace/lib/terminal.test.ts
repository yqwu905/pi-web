import { describe, expect, it } from "vitest";
import { binaryStringToBytes, clampDimension, parseTermControl, resizeMessage, terminalLabel, terminalTheme, termSocketUrl } from "./terminal";

describe("termSocketUrl", () => {
	it("builds ws and wss URLs with encoded params", () => {
		expect(termSocketUrl({ protocol: "http:", host: "127.0.0.1:7878" }, { serverId: "s1", cwd: "/home/dev/a b", cols: 132.7, rows: 36 })).toBe(
			"ws://127.0.0.1:7878/ws/term?serverId=s1&cwd=%2Fhome%2Fdev%2Fa+b&cols=132&rows=36",
		);
		expect(termSocketUrl({ protocol: "https:", host: "x" }, { serverId: "s", cwd: "~", cols: NaN, rows: 0 })).toBe(
			"wss://x/ws/term?serverId=s&cwd=%7E&cols=80&rows=1",
		);
	});
});

describe("control messages", () => {
	it("clamps dimensions", () => {
		expect(clampDimension(undefined, 80)).toBe(80);
		expect(clampDimension(5000, 80)).toBe(1000);
		expect(clampDimension(-3, 80)).toBe(1);
	});
	it("serializes resize", () => {
		expect(JSON.parse(resizeMessage(100, 30))).toEqual({ type: "resize", cols: 100, rows: 30 });
	});
	it("parses server controls", () => {
		expect(parseTermControl('{"type":"ready"}')).toEqual({ type: "ready" });
		expect(parseTermControl('{"type":"exit","code":0}')).toEqual({ type: "exit", code: 0 });
		expect(parseTermControl('{"type":"exit"}')).toEqual({ type: "exit", code: null });
		expect(parseTermControl('{"type":"error","message":"x"}')).toEqual({ type: "error", message: "x" });
		expect(parseTermControl('{"type":"other"}')).toBeNull();
		expect(parseTermControl("plain text")).toBeNull();
		expect(parseTermControl("null")).toBeNull();
	});
});

describe("binaryStringToBytes", () => {
	it("keeps the low byte of each char", () => {
		expect([...binaryStringToBytes("\x1b[M\xff")]).toEqual([27, 91, 77, 255]);
	});
});

describe("terminalLabel", () => {
	it("uses the directory name and numbers duplicates", () => {
		expect(terminalLabel("/home/dev/projects/llm-train", [])).toBe("shell · llm-train");
		expect(terminalLabel("~", [])).toBe("shell · ~");
		expect(terminalLabel("/a/x", ["shell · x"])).toBe("shell · x (2)");
		expect(terminalLabel("/a/x", ["shell · x", "shell · x (2)"])).toBe("shell · x (3)");
	});
});

describe("terminalTheme", () => {
	it("reads theme variables and skips missing ones", () => {
		const vars: Record<string, string> = { "--color-code": " #0b0d11 ", "--color-success-fg": "#7fe0d2" };
		const theme = terminalTheme((name) => vars[name] ?? "");
		expect(theme.background).toBe("#0b0d11");
		expect(theme.cursorAccent).toBe("#0b0d11");
		expect(theme.brightGreen).toBe("#7fe0d2");
		expect(theme.foreground).toBeUndefined();
	});
});
