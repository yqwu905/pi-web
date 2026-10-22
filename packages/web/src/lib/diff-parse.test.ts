import { describe, expect, it } from "vitest";
import { diffFilePath, diffStats, makeUnifiedDiff, parseUnifiedDiff, toSplitRows } from "./diff-parse";

const GIT_DIFF = [
	"diff --git a/src/data/loader.py b/src/data/loader.py",
	"index 3b18e51..a1c2d3e 100644",
	"--- a/src/data/loader.py",
	"+++ b/src/data/loader.py",
	"@@ -42,7 +42,9 @@ class ShardedTextDataset(Dataset):",
	"     self.shards = shards",
	"-    self._cache = dict()",
	"+    self._cache = LRUCache(maxsize=cache_shards)",
	"+    self._cache_shards = cache_shards",
	"     ...",
	"-    self._cache[idx] = shard",
	"+    shard_id = self._shard_of(idx)",
	"+    self._cache[shard_id] = shard",
	"     return shard",
	"     # end",
	"     pass",
	"diff --git a/new.txt b/new.txt",
	"new file mode 100644",
	"index 0000000..e69de29",
	"--- /dev/null",
	"+++ b/new.txt",
	"@@ -0,0 +1,2 @@",
	"+--- not a header",
	"+second",
	"\\ No newline at end of file",
	"diff --git a/old name.txt b/new name.txt",
	"similarity index 90%",
	"rename from old name.txt",
	"rename to new name.txt",
	"diff --git a/img.png b/img.png",
	"Binary files a/img.png and b/img.png differ",
	"diff --git a/gone.txt b/gone.txt",
	"deleted file mode 100644",
	"--- a/gone.txt",
	"+++ /dev/null",
	"@@ -1 +0,0 @@",
	"-bye",
	"",
].join("\n");

describe("parseUnifiedDiff", () => {
	const files = parseUnifiedDiff(GIT_DIFF);

	it("splits files and detects statuses", () => {
		expect(files.map((f) => f.status)).toEqual(["modified", "added", "renamed", "modified", "deleted"]);
		expect(files[1].oldPath).toBeNull();
		expect(files[1].newPath).toBe("new.txt");
		expect(files[2].oldPath).toBe("old name.txt");
		expect(files[2].newPath).toBe("new name.txt");
		expect(files[2].similarity).toBe(90);
		expect(diffFilePath(files[2])).toBe("old name.txt → new name.txt");
		expect(files[3].binary).toBe(true);
		expect(files[4].newPath).toBeNull();
		expect(diffFilePath(files[4])).toBe("gone.txt");
	});

	it("numbers lines and counts changes", () => {
		const f = files[0];
		expect(f.additions).toBe(4);
		expect(f.deletions).toBe(2);
		const h = f.hunks[0];
		expect(h.section).toBe("class ShardedTextDataset(Dataset):");
		expect(h.lines[0]).toEqual({ type: "context", content: "    self.shards = shards", oldNo: 42, newNo: 42 });
		expect(h.lines[1]).toMatchObject({ type: "del", oldNo: 43 });
		expect(h.lines[2]).toMatchObject({ type: "add", newNo: 43 });
		expect(h.lines[h.lines.length - 1]).toMatchObject({ type: "context", oldNo: 48, newNo: 50 });
	});

	it("keeps header-looking content inside hunks", () => {
		const h = files[1].hunks[0];
		expect(h.lines.map((l) => l.type)).toEqual(["add", "add", "note"]);
		expect(h.lines[0].content).toBe("--- not a header");
		expect(h.lines[2].content).toBe("No newline at end of file");
	});

	it("parses hunks with omitted counts", () => {
		const h = files[4].hunks[0];
		expect(h.oldLines).toBe(1);
		expect(h.newLines).toBe(0);
		expect(h.lines).toEqual([{ type: "del", content: "bye", oldNo: 1 }]);
	});

	it("aggregates stats", () => {
		expect(diffStats(files)).toEqual({ files: 5, additions: 6, deletions: 3 });
	});

	it("parses bare hunks and plain multi-file diffs", () => {
		const bare = parseUnifiedDiff("@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
		expect(bare).toHaveLength(1);
		expect(bare[0].hunks[0].lines).toHaveLength(3);
		const plain = parseUnifiedDiff("--- x\n+++ x\n@@ -1 +1 @@\n-a\n+b\n--- y\n+++ y\n@@ -1 +1 @@\n-c\n+d\n");
		expect(plain.map((f) => f.newPath)).toEqual(["x", "y"]);
	});

	it("handles CRLF and empty input", () => {
		expect(parseUnifiedDiff("")).toEqual([]);
		const crlf = parseUnifiedDiff("@@ -1 +1 @@\r\n-a\r\n+b\r\n");
		expect(crlf[0].hunks[0].lines.map((l) => l.content)).toEqual(["a", "b"]);
	});
});

describe("toSplitRows", () => {
	it("pairs deletions with additions", () => {
		const [file] = parseUnifiedDiff(GIT_DIFF);
		const rows = toSplitRows(file.hunks[0]);
		expect(rows).toHaveLength(9);
		expect(rows[0]).toMatchObject({ kind: "pair", left: { type: "context" }, right: { type: "context" } });
		expect(rows[1]).toMatchObject({ left: { type: "del", oldNo: 43 }, right: { type: "add", newNo: 43 } });
		expect(rows[2]).toMatchObject({ left: null, right: { type: "add", newNo: 44 } });
		expect(rows[4]).toMatchObject({ left: { type: "del" }, right: { type: "add" } });
		expect(rows[5]).toMatchObject({ left: null, right: { type: "add" } });
	});

	it("emits note rows", () => {
		const files = parseUnifiedDiff(GIT_DIFF);
		const rows = toSplitRows(files[1].hunks[0]);
		expect(rows[rows.length - 1]).toEqual({ kind: "note", text: "No newline at end of file" });
	});
});

describe("makeUnifiedDiff", () => {
	it("round-trips through the parser", () => {
		const text = makeUnifiedDiff("a\nb\nc\n", "a\nB\nc\nd\n", "src/x.ts");
		const files = parseUnifiedDiff(text);
		expect(files).toHaveLength(1);
		expect(files[0].newPath).toBe("src/x.ts");
		expect(files[0].additions).toBe(2);
		expect(files[0].deletions).toBe(1);
	});
});
