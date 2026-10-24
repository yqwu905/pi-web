import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../../lib/diff-parse";
import {
	countLines,
	editChanges,
	editDiff,
	editDiffFromArgs,
	lineRangeLabel,
	parseBashResult,
	parsePartialJson,
	parseReadResult,
	payloadImages,
	payloadText,
	ToolExpansionOverrides,
	todoError,
	toolErrorLine,
	toolExpanded,
	toolTarget,
} from "./tools";

describe("payload helpers", () => {
	it("joins text and extracts images", () => {
		const payload = {
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "AAA", mimeType: "image/png" },
				{ type: "text", text: "b" },
			],
		};
		expect(payloadText(payload)).toBe("a\nb");
		expect(payloadImages(payload)).toEqual([{ type: "image", data: "AAA", mimeType: "image/png" }]);
		expect(payloadText(undefined)).toBe("");
	});
});

describe("toolTarget", () => {
	it("summarizes built-in tools", () => {
		expect(toolTarget("bash", { command: "ls -la\npwd" })).toBe("ls -la …");
		expect(toolTarget("read", { path: "src/a.ts", offset: 3 })).toBe("src/a.ts");
		expect(toolTarget("edit", { file_path: "x.py" })).toBe("x.py");
		expect(toolTarget("grep", { pattern: "foo", path: "src", glob: "*.ts" })).toBe("/foo/ in src (*.ts)");
		expect(toolTarget("find", { pattern: "*.md" })).toBe("*.md in .");
		expect(toolTarget("ls", {})).toBe(".");
		expect(toolTarget("custom", {})).toBe("");
		expect(toolTarget("custom", { a: 1 })).toBe('{"a":1}');
	});

	it("summarizes rpiv's todo calls", () => {
		expect(toolTarget("todo", { action: "create", subject: " Write the parser " })).toBe("Write the parser");
		expect(toolTarget("todo", { action: "create", tasks: [{ subject: "a" }, { subject: "b" }] })).toBe("2 项任务");
		expect(toolTarget("todo", { action: "create", tasks: JSON.stringify([{ subject: "a" }]) })).toBe("1 项任务");
		expect(toolTarget("todo", { action: "update", id: 3, status: "completed" })).toBe("#3 → 已完成");
		expect(toolTarget("todo", { action: "update", id: 3, status: "in_progress", activeForm: "writing" })).toBe("#3 → 进行中");
		expect(toolTarget("todo", { action: "update", id: 3, subject: "x", addBlockedBy: [1], removeBlockedBy: [2] })).toBe("#3 · 标题、依赖");
		expect(toolTarget("todo", { action: "update", id: 3, status: "toString" })).toBe("#3");
		expect(toolTarget("todo", { action: "delete", id: 3 })).toBe("#3");
		expect(toolTarget("todo", { action: "get", id: "4" })).toBe("#4");
		expect(toolTarget("todo", { action: "list" })).toBe("列表");
		expect(toolTarget("todo", { action: "list", status: "pending" })).toBe("列表 · 待处理");
		expect(toolTarget("todo", { action: "clear" })).toBe("清空");
		// Unknown actions (and other tools named differently) keep the raw JSON.
		expect(toolTarget("todo", { action: "zap" })).toBe('{"action":"zap"}');
		expect(toolTarget("todo", {})).toBe("");
	});
});

describe("toolErrorLine", () => {
	it("takes the first non-empty line of a failed call", () => {
		expect(toolErrorLine("read", true, "\n  ENOENT: no such file  \nat x", undefined)).toBe("ENOENT: no such file");
		expect(toolErrorLine("read", false, "fine", undefined)).toBe("");
		expect(toolErrorLine("custom", true, "", undefined)).toBe("");
	});

	it("drops bash's exit trailer", () => {
		expect(toolErrorLine("bash", true, "npm ERR! missing script\nmore\n\nCommand exited with code 1", undefined)).toBe("npm ERR! missing script");
		expect(toolErrorLine("bash", true, "Command exited with code 2", undefined)).toBe("");
	});

	it("reports rpiv's in-band todo rejections", () => {
		const details = { action: "update", params: {}, tasks: [], nextId: 1, error: "illegal transition completed → in_progress" };
		expect(todoError(details)).toBe("illegal transition completed → in_progress");
		expect(toolErrorLine("todo", false, "Error: illegal transition completed → in_progress", details)).toBe("illegal transition completed → in_progress");
		expect(todoError({ tasks: [], nextId: 1 })).toBeUndefined();
		expect(todoError(null)).toBeUndefined();
		expect(toolErrorLine("todo", false, "Created #1: a (pending)", { tasks: [], nextId: 2 })).toBe("");
	});
});

describe("tool card expansion", () => {
	it("follows the global preference unless the card was toggled", () => {
		expect(toolExpanded(undefined, false)).toBe(false);
		expect(toolExpanded(undefined, true)).toBe(true);
		expect(toolExpanded(true, false)).toBe(true);
		expect(toolExpanded(false, true)).toBe(false);
	});

	it("keeps per-card toggles until the preference changes", () => {
		const overrides = new ToolExpansionOverrides();
		overrides.set("a", true, 0);
		overrides.set("b", false, 0);
		expect(overrides.get("a", 0)).toBe(true);
		expect(overrides.get("b", 0)).toBe(false);
		expect(overrides.get("c", 0)).toBeUndefined();
		// A new epoch (global expand/collapse all) drops every toggle; stale epochs are ignored.
		expect(overrides.get("a", 1)).toBeUndefined();
		overrides.set("b", true, 0);
		expect(overrides.get("b", 1)).toBeUndefined();
		overrides.set("b", true, 1);
		expect(overrides.get("b", 1)).toBe(true);
		expect(overrides.get("b", 0)).toBeUndefined();
	});

	it("ignores calls without an id and stays bounded", () => {
		const overrides = new ToolExpansionOverrides(2);
		overrides.set("", true, 0);
		expect(overrides.get("", 0)).toBeUndefined();
		overrides.set("a", true, 0);
		overrides.set("b", true, 0);
		overrides.set("a", false, 0);
		overrides.set("c", true, 0);
		// "b" is the least recently toggled one.
		expect(overrides.get("b", 0)).toBeUndefined();
		expect(overrides.get("a", 0)).toBe(false);
		expect(overrides.get("c", 0)).toBe(true);
	});
});

describe("parseReadResult", () => {
	it("strips pi's continuation notice and computes the range", () => {
		const text = "line1\nline2\nline3\n\n[Showing lines 41-43 of 120. Use offset=44 to continue.]";
		const r = parseReadResult({ path: "a", offset: 41 }, text);
		expect(r.content).toBe("line1\nline2\nline3");
		expect(r.notice).toBe("Showing lines 41-43 of 120. Use offset=44 to continue.");
		expect(r.startLine).toBe(41);
		expect(r.lineCount).toBe(3);
		expect(lineRangeLabel(r.startLine, r.lineCount)).toBe("第 41–43 行");
	});

	it("handles the user-limit notice and plain content", () => {
		const r = parseReadResult({ path: "a", limit: 2 }, "x\ny\n\n[5 more lines in file. Use offset=3 to continue.]");
		expect(r.content).toBe("x\ny");
		expect(r.notice).toContain("5 more lines");
		expect(r.startLine).toBe(1);
		expect(parseReadResult({}, "only").notice).toBeUndefined();
		expect(lineRangeLabel(7, 1)).toBe("第 7 行");
		expect(lineRangeLabel(1, 0)).toBe("");
	});

	it("handles an over-long first line", () => {
		const r = parseReadResult({ offset: 5 }, "[Line 5 is 80.0KB, exceeds 50.0KB limit. Use bash: sed -n '5p' a | head -c 51200]");
		expect(r.content).toBe("");
		expect(r.lineCount).toBe(0);
		expect(r.notice).toContain("exceeds");
	});
});

describe("parseBashResult", () => {
	it("derives the exit code", () => {
		expect(parseBashResult("ok\n", false)).toEqual({ output: "ok\n", exitCode: 0 });
		expect(parseBashResult("boom\n\nCommand exited with code 2", true)).toEqual({ output: "boom", exitCode: 2 });
		expect(parseBashResult("Command exited with code 1", true)).toEqual({ output: "", exitCode: 1 });
		expect(parseBashResult("(no output)", false)).toEqual({ output: "", exitCode: 0 });
	});

	it("maps abnormal endings", () => {
		expect(parseBashResult("partial\n\nCommand aborted", true)).toEqual({ output: "partial", status: "已中止" });
		expect(parseBashResult("Command timed out after 30 seconds", true)).toEqual({ output: "", status: "超时（30 秒）" });
		expect(parseBashResult("weird failure", true)).toEqual({ output: "weird failure" });
	});
});

describe("edit arguments", () => {
	it("normalizes every argument shape pi accepts", () => {
		const one = { oldText: "a", newText: "b" };
		expect(editChanges({ path: "x", edits: [one] })).toEqual([one]);
		expect(editChanges({ path: "x", edits: JSON.stringify([one]) })).toEqual([one]);
		expect(editChanges({ path: "x", edits: one })).toEqual([one]);
		expect(editChanges({ path: "x", oldText: "a", newText: "b" })).toEqual([one]);
		expect(editChanges({ path: "x", edits: "not json" })).toEqual([]);
		expect(editChanges({ path: "x", edits: [{ oldText: 1 }] })).toEqual([]);
	});

	it("computes a diff with one hunk group per replacement", () => {
		const diff = editDiffFromArgs("src/a.py", [
			{ oldText: "x = 1\ny = 2", newText: "x = 1\ny = 3" },
			{ oldText: "z = dict()", newText: "z = LRU()\nw = 0" },
		]);
		const files = parseUnifiedDiff(diff);
		expect(files).toHaveLength(1);
		expect(files[0].newPath).toBe("src/a.py");
		expect(files[0].hunks).toHaveLength(2);
		expect(files[0].additions).toBe(3);
		expect(files[0].deletions).toBe(2);
		expect(diff).not.toContain("No newline");
		expect(editDiffFromArgs("a", [])).toBe("");
	});

	it("prefers pi's patch from the result details", () => {
		const patch = "--- a.ts\n+++ a.ts\n@@ -10,1 +10,1 @@\n-old\n+new\n";
		expect(editDiff({ path: "a.ts", edits: [{ oldText: "q", newText: "r" }] }, { patch, diff: "" })).toBe(patch);
		expect(editDiff({ path: "a.ts", edits: [{ oldText: "q", newText: "r" }] }, undefined)).toContain("+r");
	});
});

describe("parsePartialJson", () => {
	it("parses complete and truncated JSON", () => {
		expect(parsePartialJson('{"a":1}')).toEqual({ a: 1 });
		expect(parsePartialJson('{"command": "npm te')).toEqual({ command: "npm te" });
		expect(parsePartialJson('{"path": "src/a.ts", "edits": [{"oldText": "x\\')).toEqual({ path: "src/a.ts", edits: [{ oldText: "x" }] });
		expect(parsePartialJson('{"path": "a", "conte')).toEqual({ path: "a" });
		expect(parsePartialJson('{"a": tr')).toEqual({});
		expect(parsePartialJson("")).toBeUndefined();
		expect(parsePartialJson("[1,2")).toBeUndefined();
	});
});

describe("countLines", () => {
	it("ignores a trailing newline", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("a")).toBe(1);
		expect(countLines("a\nb\n")).toBe(2);
	});
});
