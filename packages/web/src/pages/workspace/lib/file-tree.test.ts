import type { FsEntry } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { countIgnored, type DirListing, flattenTree, isDirEntry, revealPath, setExpanded, toggleExpanded, treeKeyAction, visibleDirs } from "./file-tree";

const dir = (path: string, extra: Partial<FsEntry> = {}): FsEntry => ({
	name: path.slice(path.lastIndexOf("/") + 1),
	path,
	type: "dir",
	size: 0,
	mtimeMs: 0,
	...extra,
});
const file = (path: string, extra: Partial<FsEntry> = {}): FsEntry => ({ ...dir(path), type: "file", ...extra });

const ROOT = "/w";
const listings: Record<string, DirListing> = {
	"/w": { status: "success", entries: [dir("/w/src"), dir("/w/empty"), dir("/w/.venv", { ignored: true }), file("/w/README.md")] },
	"/w/src": { status: "success", entries: [dir("/w/src/data"), file("/w/src/train.py")] },
	"/w/src/data": { status: "loading" },
	"/w/empty": { status: "success", entries: [] },
};
const lookup = (p: string) => listings[p];

describe("isDirEntry", () => {
	it("treats symlinks to directories as directories", () => {
		expect(isDirEntry({ type: "dir" })).toBe(true);
		expect(isDirEntry({ type: "symlink", targetType: "dir" })).toBe(true);
		expect(isDirEntry({ type: "symlink", targetType: "file" })).toBe(false);
		expect(isDirEntry({ type: "file" })).toBe(false);
	});
});

describe("flattenTree", () => {
	it("lists only the root when nothing is expanded", () => {
		const rows = flattenTree(ROOT, lookup, new Set());
		expect(rows.map((r) => r.key)).toEqual(["/w/src", "/w/empty", "/w/.venv", "/w/README.md"]);
		expect(rows.every((r) => r.depth === 0)).toBe(true);
	});

	it("shows children, loading and empty rows for expanded directories", () => {
		const rows = flattenTree(ROOT, lookup, new Set(["/w/src", "/w/src/data", "/w/empty"]));
		expect(rows.map((r) => [r.key, r.depth])).toEqual([
			["/w/src", 0],
			["/w/src/data", 1],
			["/w/src/data\0loading", 2],
			["/w/src/train.py", 1],
			["/w/empty", 0],
			["/w/empty\0empty", 1],
			["/w/.venv", 0],
			["/w/README.md", 0],
		]);
		const src = rows[0];
		expect(src.kind === "entry" && src.expanded && src.dir).toBe(true);
	});

	it("renders an error row and a loading row for an unknown root", () => {
		const rows = flattenTree("/x", () => ({ status: "error", message: "boom" }), new Set());
		expect(rows).toEqual([{ kind: "status", key: "/x\0error", depth: 0, dirPath: "/x", status: "error", message: "boom" }]);
		expect(flattenTree("/y", () => undefined, new Set())[0]).toMatchObject({ status: "loading" });
	});

	it("does not loop on symlinked ancestors", () => {
		const loop: Record<string, DirListing> = {
			"/w": { status: "success", entries: [dir("/w/a")] },
			"/w/a": { status: "success", entries: [dir("/w/a", { type: "symlink", targetType: "dir" })] },
		};
		const rows = flattenTree(ROOT, (p) => loop[p], new Set(["/w/a"]));
		expect(rows.length).toBe(2);
	});
});

describe("visibleDirs / reveal / toggle", () => {
	it("collects directories that need listings", () => {
		expect(visibleDirs(ROOT, lookup, new Set(["/w/src", "/w/src/data", "/w/other"]))).toEqual(["/w", "/w/src", "/w/src/data"]);
	});
	it("reveals ancestors of a file", () => {
		expect([...revealPath(new Set(["/w/x"]), ROOT, "/w/src/data/loader.py")].sort()).toEqual(["/w/src", "/w/src/data", "/w/x"]);
	});
	it("toggles and sets expansion", () => {
		const a = toggleExpanded(new Set(), "/w/src/");
		expect(a.has("/w/src")).toBe(true);
		expect(toggleExpanded(a, "/w/src").has("/w/src")).toBe(false);
		expect(setExpanded(a, "/w/src", true)).toBe(a);
		expect(setExpanded(a, "/w/src", false).has("/w/src")).toBe(false);
	});
});

describe("countIgnored", () => {
	it("counts ignored entries in loaded listings", () => {
		expect(countIgnored(Object.values(listings))).toBe(1);
		expect(countIgnored([undefined, { status: "loading" }])).toBe(0);
	});
});

describe("treeKeyAction", () => {
	const rows = flattenTree(ROOT, lookup, new Set(["/w/src"]));
	it("moves focus up and down", () => {
		expect(treeKeyAction(rows, "/w/src", "ArrowDown", ROOT)).toEqual({ focus: "/w/src/data" });
		expect(treeKeyAction(rows, "/w/src/data", "ArrowUp", ROOT)).toEqual({ focus: "/w/src" });
		expect(treeKeyAction(rows, "/w/src", "ArrowUp", ROOT)).toEqual({ focus: "/w/src" });
		expect(treeKeyAction(rows, "/w/src", "End", ROOT)).toEqual({ focus: "/w/README.md" });
		expect(treeKeyAction(rows, "/w/README.md", "Home", ROOT)).toEqual({ focus: "/w/src" });
	});
	it("expands, enters, collapses and goes to the parent", () => {
		expect(treeKeyAction(rows, "/w/src/data", "ArrowRight", ROOT)).toEqual({ toggle: "/w/src/data", open: true });
		expect(treeKeyAction(rows, "/w/src", "ArrowRight", ROOT)).toEqual({ focus: "/w/src/data" });
		expect(treeKeyAction(rows, "/w/src", "ArrowLeft", ROOT)).toEqual({ toggle: "/w/src", open: false });
		expect(treeKeyAction(rows, "/w/src/train.py", "ArrowLeft", ROOT)).toEqual({ focus: "/w/src" });
		expect(treeKeyAction(rows, "/w/README.md", "ArrowLeft", ROOT)).toBeNull();
		expect(treeKeyAction(rows, "/w/README.md", "ArrowRight", ROOT)).toBeNull();
		expect(treeKeyAction(rows, "/w/README.md", "x", ROOT)).toBeNull();
	});
});
