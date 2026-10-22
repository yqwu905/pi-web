/**
 * POSIX path helpers for paths on a remote server (workspace roots, fs/list entries).
 * Paths are either absolute ("/home/dev/x") or home-relative ("~", "~/x").
 */

/** Collapses duplicate slashes, "." and ".." segments and drops a trailing slash. */
export function normalizePath(path: string): string {
	if (!path) return "";
	const home = path === "~" || path.startsWith("~/");
	const absolute = path.startsWith("/");
	const body = home ? path.slice(1) : path;
	const out: string[] = [];
	for (const seg of body.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
			else if (!absolute && !home) out.push("..");
			continue;
		}
		out.push(seg);
	}
	const joined = out.join("/");
	if (home) return joined ? `~/${joined}` : "~";
	if (absolute) return `/${joined}`;
	return joined || ".";
}

/** Joins path parts; an absolute or "~" part restarts the path. */
export function joinPath(base: string, ...parts: string[]): string {
	let result = base;
	for (const part of parts) {
		if (!part) continue;
		if (part.startsWith("/") || part === "~" || part.startsWith("~/")) result = part;
		else result = result ? `${result.replace(/\/+$/, "")}/${part}` : part;
	}
	return normalizePath(result);
}

/** Parent directory, or null for "/", "~" and single relative segments. */
export function parentPath(path: string): string | null {
	const p = normalizePath(path);
	if (p === "/" || p === "~" || p === "." || p === "") return null;
	const i = p.lastIndexOf("/");
	if (i < 0) return null;
	if (i === 0) return "/";
	return p.slice(0, i);
}

/** Last segment of a path ("/a/b/c.txt" → "c.txt", "/" → "/"). */
export function baseName(path: string): string {
	const p = normalizePath(path);
	if (p === "/") return "/";
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
}

/** True when `path` equals `root` or lies below it. */
export function isInside(root: string, path: string): boolean {
	return relativePath(root, path) !== null;
}

/** `path` relative to `root` ("" when equal), or null when it is outside `root`. */
export function relativePath(root: string, path: string): string | null {
	const r = normalizePath(root);
	const p = normalizePath(path);
	if (p === r) return "";
	const prefix = r === "/" ? "/" : `${r}/`;
	return p.startsWith(prefix) ? p.slice(prefix.length) : null;
}

/** Resolves a workspace-relative path against `root`; absolute and "~" paths are kept. */
export function resolveInRoot(root: string, path: string): string {
	if (!path || path === ".") return normalizePath(root);
	return joinPath(root, path);
}

/** Path relative to `root` when inside it, otherwise the absolute path. */
export function displayPath(root: string, path: string): string {
	const rel = relativePath(root, path);
	if (rel === null) return normalizePath(path);
	return rel || ".";
}

export interface PathSegment {
	name: string;
	/** Full path up to and including this segment. */
	path: string;
}

/**
 * Breadcrumb segments: "/home/dev" → [home (/home), dev (/home/dev)];
 * "~/x" → [~ (~), x (~/x)]; "a/b" → [a (a), b (a/b)]. The root "/" yields no segment.
 */
export function pathSegments(path: string): PathSegment[] {
	const p = normalizePath(path);
	if (!p || p === "/" || p === ".") return [];
	const segments: PathSegment[] = [];
	if (p === "~" || p.startsWith("~/")) {
		segments.push({ name: "~", path: "~" });
		let acc = "~";
		for (const name of p.slice(2).split("/").filter(Boolean)) {
			acc = `${acc}/${name}`;
			segments.push({ name, path: acc });
		}
		return segments;
	}
	const absolute = p.startsWith("/");
	let acc = "";
	for (const name of p.split("/").filter(Boolean)) {
		acc = acc ? `${acc}/${name}` : absolute ? `/${name}` : name;
		segments.push({ name, path: acc });
	}
	return segments;
}

/**
 * Directories between `root` (exclusive) and the parent of `path` (inclusive), outermost
 * first; used to expand the tree down to a file. Empty when `path` is outside `root`.
 */
export function ancestorDirs(root: string, path: string): string[] {
	const rel = relativePath(root, path);
	if (!rel) return [];
	const parts = rel.split("/");
	parts.pop();
	const dirs: string[] = [];
	let acc = normalizePath(root);
	for (const part of parts) {
		acc = joinPath(acc, part);
		dirs.push(acc);
	}
	return dirs;
}

/** Validation message for a new folder name, or null when it is acceptable. */
export function folderNameError(name: string): string | null {
	const n = name.trim();
	if (!n) return "请输入文件夹名称";
	if (n === "." || n === "..") return "名称无效";
	if (n.includes("/")) return "名称不能包含 /";
	if (n.includes("\0")) return "名称无效";
	if (new TextEncoder().encode(n).length > 255) return "名称过长";
	return null;
}
