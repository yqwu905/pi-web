import type { RpcSlashCommand } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { applyCommand, classifyInput, insertAt, matchCommands, restoreQueuedText, slashToken, stripAnsi, visibleCommands } from "./composer";

const cmd = (name: string, source: RpcSlashCommand["source"] = "prompt", description?: string): RpcSlashCommand => ({ name, source, description });

describe("visibleCommands", () => {
	it("hides pi-web companion commands", () => {
		expect(visibleCommands([cmd("pi-web-navigate", "extension"), cmd("fix")]).map((c) => c.name)).toEqual(["fix"]);
	});
});

describe("slashToken", () => {
	it("detects a command name at the start of the message", () => {
		expect(slashToken("/fi", 3)).toEqual({ query: "fi", start: 0, end: 3 });
		expect(slashToken("/fix the tests", 2)).toEqual({ query: "f", start: 0, end: 4 });
		expect(slashToken("/", 1)).toEqual({ query: "", start: 0, end: 1 });
	});

	it("ignores slashes elsewhere and a cursor past the name", () => {
		expect(slashToken("see /fix", 8)).toBeNull();
		expect(slashToken("/fix now", 6)).toBeNull();
		expect(slashToken("/fix", 0)).toBeNull();
		expect(slashToken("", 0)).toBeNull();
	});
});

describe("matchCommands", () => {
	const commands = [
		cmd("review", "prompt", "Review the diff"),
		cmd("skill:refactor", "skill"),
		cmd("deploy", "extension", "Deploy to staging"),
		cmd("pre-review", "prompt"),
	];

	it("ranks exact and prefix matches first, skills by their bare name", () => {
		expect(matchCommands(commands, "re").map((c) => c.name)).toEqual(["review", "skill:refactor", "pre-review"]);
		expect(matchCommands(commands, "refactor").map((c) => c.name)).toEqual(["skill:refactor"]);
		expect(matchCommands(commands, "staging").map((c) => c.name)).toEqual(["deploy"]);
	});

	it("lists everything for an empty query, extensions first", () => {
		expect(matchCommands(commands, "").map((c) => c.name)).toEqual(["deploy", "pre-review", "review", "skill:refactor"]);
		expect(matchCommands(commands, "", 2)).toHaveLength(2);
	});
});

describe("applyCommand", () => {
	it("replaces the token and keeps the rest", () => {
		expect(applyCommand("/rev", { query: "rev", start: 0, end: 4 }, "review")).toEqual({ text: "/review ", cursor: 8 });
		expect(applyCommand("/r  src/a.ts", { query: "r", start: 0, end: 2 }, "review")).toEqual({ text: "/review src/a.ts", cursor: 8 });
	});
});

describe("classifyInput", () => {
	it("recognizes bash commands", () => {
		expect(classifyInput("!ls -la")).toEqual({ kind: "bash", command: "ls -la", excludeFromContext: false });
		expect(classifyInput("  !! git status ")).toEqual({ kind: "bash", command: "git status", excludeFromContext: true });
	});

	it("treats everything else as a prompt", () => {
		expect(classifyInput("hello ")).toEqual({ kind: "prompt", message: "hello" });
		expect(classifyInput("!")).toEqual({ kind: "prompt", message: "!" });
		expect(classifyInput("   ")).toEqual({ kind: "empty" });
		expect(classifyInput("", 1)).toEqual({ kind: "prompt", message: "" });
	});
});

describe("restoreQueuedText", () => {
	it("puts queued messages before the draft", () => {
		expect(restoreQueuedText("draft", ["a", " b "])).toBe("a\n\nb\n\ndraft");
		expect(restoreQueuedText("", ["a"])).toBe("a");
		expect(restoreQueuedText("x", [])).toBe("x");
	});
});

describe("stripAnsi", () => {
	it("removes color codes and OSC sequences", () => {
		expect(stripAnsi("\u001b[32m✓\u001b[0m done")).toBe("✓ done");
		expect(stripAnsi("\u001b]8;;http://x\u0007link\u001b]8;;\u0007")).toBe("link");
		expect(stripAnsi("plain")).toBe("plain");
	});
});

describe("insertAt", () => {
	it("adds a mention to the draft instead of replacing it", () => {
		expect(insertAt("", 0, "@src/a.ts")).toEqual({ text: "@src/a.ts", cursor: 9 });
		expect(insertAt("look at", 7, "@src/a.ts")).toEqual({ text: "look at @src/a.ts", cursor: 17 });
		expect(insertAt("see  please", 4, "@x")).toEqual({ text: "see @x please", cursor: 6 });
		expect(insertAt("draft", 99, "diff\nbody")).toEqual({ text: "draft\ndiff\nbody", cursor: 15 });
	});
});
