import type { GitCommit, GitFileStatus, GitStatusResult } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import {
	buildReviewPrompt,
	changedFileCount,
	diffAreaFor,
	diffCommand,
	diffModeText,
	gitBadge,
	gitMarksByPath,
	gitStateText,
	groupGitFiles,
	parseRefs,
	splitDirName,
	splitLabelsFor,
	truncateLines,
	unpushedHashes,
} from "./git";

const files: GitFileStatus[] = [
	{ path: "src/data/loader.py", area: "unstaged", code: "M", additions: 8, deletions: 4 },
	{ path: "configs/train.yaml", area: "unstaged", code: "M", additions: 1, deletions: 1 },
	{ path: "configs/train.yaml", area: "staged", code: "M", additions: 2, deletions: 0 },
	{ path: "tests/test_loader_mem.py", area: "untracked", code: "?" },
	{ path: "merge.txt", area: "conflict", code: "U" },
];
const status: GitStatusResult = { isRepo: true, root: "/w", ahead: 2, behind: 0, branch: "main", upstream: "origin/main", files };

describe("groups and counts", () => {
	it("groups by area and sorts by path", () => {
		const g = groupGitFiles(files);
		expect(g.unstaged.map((f) => f.path)).toEqual(["configs/train.yaml", "src/data/loader.py"]);
		expect(g.staged).toHaveLength(1);
		expect(g.untracked).toHaveLength(1);
		expect(g.conflict).toHaveLength(1);
	});
	it("counts distinct paths", () => {
		expect(changedFileCount(status)).toBe(4);
		expect(changedFileCount({ isRepo: false, files: [] })).toBe(0);
		expect(changedFileCount(undefined)).toBe(0);
	});
});

describe("badges and marks", () => {
	it("maps codes to letters", () => {
		expect(gitBadge({ code: "M", area: "unstaged" })).toEqual({ letter: "M", label: "已修改", tone: "warning" });
		expect(gitBadge({ code: "?", area: "untracked" })).toMatchObject({ letter: "U", label: "未跟踪" });
		expect(gitBadge({ code: "U", area: "conflict" })).toMatchObject({ letter: "!", tone: "danger" });
		expect(gitBadge({ code: "A", area: "staged" }).tone).toBe("success");
		expect(gitBadge({ code: "D", area: "staged" }).tone).toBe("danger");
		expect(gitBadge({ code: "R", area: "staged" }).letter).toBe("R");
	});
	it("describes the state", () => {
		expect(gitStateText({ code: "M", area: "unstaged" })).toBe("已修改，未暂存");
		expect(gitStateText({ code: "A", area: "staged" })).toBe("已添加，已暂存");
		expect(gitStateText({ code: "?", area: "untracked" })).toBe("未跟踪");
	});
	it("keys marks by absolute path with area priority", () => {
		const marks = gitMarksByPath(status);
		expect(marks.get("/w/configs/train.yaml")?.area).toBe("unstaged");
		expect(marks.get("/w/merge.txt")?.area).toBe("conflict");
		expect(marks.size).toBe(4);
		expect(gitMarksByPath({ ...status, root: undefined }).size).toBe(0);
	});
});

describe("diff helpers", () => {
	it("chooses areas, commands and labels", () => {
		expect(diffAreaFor("conflict")).toBe("unstaged");
		expect(diffAreaFor("staged")).toBe("staged");
		expect(diffCommand("unstaged", "src/a.py")).toBe("git diff -- src/a.py");
		expect(diffCommand("staged", "a b.txt")).toBe("git diff --cached -- 'a b.txt'");
		expect(diffCommand("untracked", "t.py")).toBe("git diff --no-index -- /dev/null t.py");
		expect(splitLabelsFor("unstaged")).toEqual(["旧 · 暂存区", "新 · 工作区"]);
		expect(splitLabelsFor("staged")).toEqual(["旧 · HEAD", "新 · 暂存区"]);
		expect(splitLabelsFor("untracked")[0]).toBe("旧 · 无此文件");
	});
	it("splits directory and name", () => {
		expect(splitDirName("src/data/loader.py")).toEqual({ dir: "src/data/", name: "loader.py" });
		expect(splitDirName("README.md")).toEqual({ dir: "", name: "README.md" });
	});
});

describe("refs and unpushed commits", () => {
	it("parses decorations", () => {
		expect(parseRefs("HEAD -> main, origin/main, origin/HEAD, tag: v1.0, feature/x")).toEqual([
			{ label: "main", kind: "branch" },
			{ label: "origin/main", kind: "remote" },
			{ label: "v1.0", kind: "tag" },
			{ label: "feature/x", kind: "branch" },
		]);
		expect(parseRefs("HEAD")).toEqual([{ label: "HEAD", kind: "head" }]);
		expect(parseRefs(undefined)).toEqual([]);
	});
	const c = (hash: string, refs?: string): GitCommit => ({ hash, short: hash, subject: hash, author: "dev", email: "", dateMs: 0, refs });
	it("finds commits before the upstream ref", () => {
		const commits = [c("a", "HEAD -> main"), c("b"), c("c", "origin/main"), c("d")];
		expect([...unpushedHashes(commits, "origin/main", 2)]).toEqual(["a", "b"]);
		expect([...unpushedHashes(commits, "origin/main", 0)]).toEqual([]);
		expect([...unpushedHashes(commits, undefined, 2)]).toEqual([]);
	});
	it("falls back to the ahead count", () => {
		expect([...unpushedHashes([c("a"), c("b"), c("c")], "origin/main", 2)]).toEqual(["a", "b"]);
		expect([...unpushedHashes([c("a")], "origin/main", 5)]).toEqual(["a"]);
	});
});

describe("review prompt", () => {
	it("truncates at line boundaries", () => {
		const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
		expect(truncateLines(text, 1000, 2)).toEqual({ text: "aaaa\nbbbb", truncated: true, omittedLines: 2 });
		expect(truncateLines(text, 12, 100)).toEqual({ text: "aaaa\nbbbb", truncated: true, omittedLines: 2 });
		expect(truncateLines(`${text}\n`, 1000, 100)).toEqual({ text, truncated: false, omittedLines: 0 });
	});
	it("builds a fenced prompt", () => {
		const diff = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
		const { text, truncated } = buildReviewPrompt({ path: "x", area: "unstaged", diff, additions: 1, deletions: 1 });
		expect(truncated).toBe(false);
		expect(text).toContain("请审阅 `x` 的改动（未暂存，+1 −1）");
		expect(text).toContain("```diff\ndiff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n```");
	});
	it("notes truncation and uses a longer fence when needed", () => {
		const diff = Array.from({ length: 50 }, (_, i) => `+line ${i} \`\`\``).join("\n");
		const { text, truncated } = buildReviewPrompt({ path: "a.md", area: "staged", diff, additions: 50, deletions: 0, maxLines: 10 });
		expect(truncated).toBe(true);
		expect(text).toContain("````diff");
		expect(text).toContain("前 10 行，另有 40 行未包含");
		expect(text).toContain("git diff --cached -- a.md");
	});
});

describe("diffModeText", () => {
	it("describes modes", () => {
		expect(diffModeText({ status: "modified" }, "diff --git a/x b/x\nindex 1a2b..3c4d 100644\n")).toBe("100644");
		expect(diffModeText({ status: "added", newMode: "100644" }, "")).toBe("新文件 · 100644");
		expect(diffModeText({ status: "deleted", oldMode: "100755" }, "")).toBe("已删除 · 100755");
		expect(diffModeText({ status: "modified", oldMode: "100644", newMode: "100755" }, "")).toBe("100644 → 100755");
		expect(diffModeText(undefined, "")).toBe("");
	});
});
