import { describe, expect, it } from "vitest";
import {
	ancestorDirs,
	baseName,
	displayPath,
	folderNameError,
	isInside,
	joinPath,
	normalizePath,
	parentPath,
	pathSegments,
	relativePath,
	resolveInRoot,
} from "./remote-path";

describe("normalizePath", () => {
	it("collapses slashes, dots and trailing slashes", () => {
		expect(normalizePath("/home//dev/./x/")).toBe("/home/dev/x");
		expect(normalizePath("/a/b/../c")).toBe("/a/c");
		expect(normalizePath("/../a")).toBe("/a");
		expect(normalizePath("/")).toBe("/");
		expect(normalizePath("")).toBe("");
	});
	it("keeps home-relative paths", () => {
		expect(normalizePath("~")).toBe("~");
		expect(normalizePath("~/")).toBe("~");
		expect(normalizePath("~/a/../b/")).toBe("~/b");
		expect(normalizePath("~/..")).toBe("~");
	});
	it("handles relative paths", () => {
		expect(normalizePath("a/./b")).toBe("a/b");
		expect(normalizePath("../a")).toBe("../a");
		expect(normalizePath("a/..")).toBe(".");
	});
});

describe("joinPath / parentPath / baseName", () => {
	it("joins and restarts on absolute parts", () => {
		expect(joinPath("/home/dev", "projects", "x")).toBe("/home/dev/projects/x");
		expect(joinPath("/home/dev/", "/etc")).toBe("/etc");
		expect(joinPath("/", "a")).toBe("/a");
		expect(joinPath("~", "a")).toBe("~/a");
		expect(joinPath("/a", "~/b")).toBe("~/b");
		expect(joinPath("/a", "")).toBe("/a");
	});
	it("returns parents", () => {
		expect(parentPath("/home/dev")).toBe("/home");
		expect(parentPath("/home")).toBe("/");
		expect(parentPath("/")).toBeNull();
		expect(parentPath("~")).toBeNull();
		expect(parentPath("~/x")).toBe("~");
		expect(parentPath("a")).toBeNull();
		expect(parentPath("a/b")).toBe("a");
	});
	it("returns base names", () => {
		expect(baseName("/a/b/c.txt")).toBe("c.txt");
		expect(baseName("/a/b/")).toBe("b");
		expect(baseName("/")).toBe("/");
		expect(baseName("~")).toBe("~");
	});
});

describe("relativePath / isInside / resolveInRoot / displayPath", () => {
	const root = "/home/dev/projects/llm-train";
	it("computes paths relative to a root", () => {
		expect(relativePath(root, `${root}/src/data/loader.py`)).toBe("src/data/loader.py");
		expect(relativePath(root, root)).toBe("");
		expect(relativePath(root, `${root}/`)).toBe("");
		expect(relativePath(root, "/home/dev/projects/llm-train2/x")).toBeNull();
		expect(relativePath("/", "/etc/hosts")).toBe("etc/hosts");
		expect(isInside(root, `${root}/a`)).toBe(true);
		expect(isInside(root, "/tmp")).toBe(false);
	});
	it("resolves relative paths against the root", () => {
		expect(resolveInRoot(root, "src/a.py")).toBe(`${root}/src/a.py`);
		expect(resolveInRoot(root, "/etc/hosts")).toBe("/etc/hosts");
		expect(resolveInRoot(root, "")).toBe(root);
		expect(resolveInRoot(root, ".")).toBe(root);
	});
	it("displays relative when inside", () => {
		expect(displayPath(root, `${root}/README.md`)).toBe("README.md");
		expect(displayPath(root, root)).toBe(".");
		expect(displayPath(root, "/etc/hosts")).toBe("/etc/hosts");
	});
});

describe("pathSegments", () => {
	it("splits absolute paths", () => {
		expect(pathSegments("/home/dev")).toEqual([
			{ name: "home", path: "/home" },
			{ name: "dev", path: "/home/dev" },
		]);
		expect(pathSegments("/")).toEqual([]);
	});
	it("splits home and relative paths", () => {
		expect(pathSegments("~/x/y")).toEqual([
			{ name: "~", path: "~" },
			{ name: "x", path: "~/x" },
			{ name: "y", path: "~/x/y" },
		]);
		expect(pathSegments("src/a.py")).toEqual([
			{ name: "src", path: "src" },
			{ name: "a.py", path: "src/a.py" },
		]);
	});
});

describe("ancestorDirs", () => {
	it("lists directories to expand", () => {
		expect(ancestorDirs("/w", "/w/src/data/loader.py")).toEqual(["/w/src", "/w/src/data"]);
		expect(ancestorDirs("/w", "/w/README.md")).toEqual([]);
		expect(ancestorDirs("/w", "/other/x")).toEqual([]);
		expect(ancestorDirs("/w", "/w")).toEqual([]);
	});
});

describe("folderNameError", () => {
	it("validates folder names", () => {
		expect(folderNameError("vision-exp")).toBeNull();
		expect(folderNameError("  ")).toBe("请输入文件夹名称");
		expect(folderNameError("..")).toBe("名称无效");
		expect(folderNameError("a/b")).toBe("名称不能包含 /");
		expect(folderNameError("x".repeat(256))).toBe("名称过长");
	});
});
