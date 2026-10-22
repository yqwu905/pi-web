/**
 * Lazy file tree model: directory listings are loaded per expanded directory and the
 * visible tree is flattened into rows (for rendering and arrow-key navigation).
 */
import type { FsEntry } from "@pi-web/shared";
import { ancestorDirs, normalizePath } from "./remote-path";

/** A directory, or a symlink whose target is a directory. */
export function isDirEntry(entry: Pick<FsEntry, "type" | "targetType">): boolean {
	return entry.type === "dir" || (entry.type === "symlink" && entry.targetType === "dir");
}

export type DirListing =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "success"; entries: readonly FsEntry[] };

export type TreeRow =
	| {
			kind: "entry";
			key: string;
			entry: FsEntry;
			depth: number;
			dir: boolean;
			expanded: boolean;
	  }
	| {
			kind: "status";
			key: string;
			depth: number;
			/** Directory whose listing this row describes. */
			dirPath: string;
			status: "loading" | "error" | "empty";
			message?: string;
	  };

/**
 * Rows of the visible tree under `root` (root itself not included). Expanded directories
 * show their children, or a loading / error / empty status row.
 */
export function flattenTree(
	root: string,
	listing: (dirPath: string) => DirListing | undefined,
	expanded: ReadonlySet<string>,
): TreeRow[] {
	const rows: TreeRow[] = [];
	const visit = (dirPath: string, depth: number, guard: Set<string>) => {
		const result = listing(dirPath);
		if (!result || result.status === "loading") {
			rows.push({ kind: "status", key: `${dirPath}\0loading`, depth, dirPath, status: "loading" });
			return;
		}
		if (result.status === "error") {
			rows.push({ kind: "status", key: `${dirPath}\0error`, depth, dirPath, status: "error", message: result.message });
			return;
		}
		if (result.entries.length === 0) {
			rows.push({ kind: "status", key: `${dirPath}\0empty`, depth, dirPath, status: "empty" });
			return;
		}
		for (const entry of result.entries) {
			const dir = isDirEntry(entry);
			const path = normalizePath(entry.path);
			const open = dir && expanded.has(path) && !guard.has(path);
			rows.push({ kind: "entry", key: path, entry, depth, dir, expanded: open });
			if (open) {
				// Guard against symlink loops that resolve to an ancestor path string.
				const next = new Set(guard);
				next.add(path);
				visit(path, depth + 1, next);
			}
		}
	};
	visit(normalizePath(root), 0, new Set([normalizePath(root)]));
	return rows;
}

/** Directories whose listings are needed to render the tree: the root plus every visible expanded dir. */
export function visibleDirs(root: string, listing: (dirPath: string) => DirListing | undefined, expanded: ReadonlySet<string>): string[] {
	const dirs = [normalizePath(root)];
	for (const row of flattenTree(root, listing, expanded)) {
		if (row.kind === "entry" && row.expanded) dirs.push(row.key);
	}
	return dirs;
}

export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
	const next = new Set(expanded);
	const p = normalizePath(path);
	if (next.has(p)) next.delete(p);
	else next.add(p);
	return next;
}

/** Returns `expanded` itself when nothing changes (keeps React state stable). */
export function setExpanded(expanded: ReadonlySet<string>, path: string, open: boolean): ReadonlySet<string> {
	const p = normalizePath(path);
	if (expanded.has(p) === open) return expanded;
	const next = new Set(expanded);
	if (open) next.add(p);
	else next.delete(p);
	return next;
}

/** Expands every directory between `root` and `filePath` so the file becomes visible. */
export function revealPath(expanded: ReadonlySet<string>, root: string, filePath: string): Set<string> {
	const next = new Set(expanded);
	for (const dir of ancestorDirs(root, filePath)) next.add(dir);
	return next;
}

/** Number of entries flagged as git-ignored across the given listings. */
export function countIgnored(listings: Iterable<DirListing | undefined>): number {
	let n = 0;
	for (const l of listings) {
		if (l?.status === "success") for (const e of l.entries) if (e.ignored) n++;
	}
	return n;
}

/**
 * Keyboard navigation over the flattened rows (entry rows only). Returns the key of the
 * row to focus, a directory to expand/collapse, or nothing.
 */
export type TreeKeyAction = { focus: string } | { toggle: string; open: boolean } | null;

export function treeKeyAction(rows: readonly TreeRow[], currentKey: string, key: string, root: string): TreeKeyAction {
	const entries = rows.filter((r): r is Extract<TreeRow, { kind: "entry" }> => r.kind === "entry");
	if (entries.length === 0) return null;
	const index = entries.findIndex((r) => r.key === currentKey);
	const current = index >= 0 ? entries[index] : undefined;
	switch (key) {
		case "ArrowDown":
			return { focus: entries[Math.min(entries.length - 1, index + 1)].key };
		case "ArrowUp":
			return { focus: entries[Math.max(0, index - 1)].key };
		case "Home":
			return { focus: entries[0].key };
		case "End":
			return { focus: entries[entries.length - 1].key };
		case "ArrowRight":
			if (!current?.dir) return null;
			if (!current.expanded) return { toggle: current.key, open: true };
			{
				const child = entries[index + 1];
				return child && child.depth > current.depth ? { focus: child.key } : null;
			}
		case "ArrowLeft": {
			if (!current) return null;
			if (current.dir && current.expanded) return { toggle: current.key, open: false };
			const parent = current.key.slice(0, current.key.lastIndexOf("/")) || "/";
			if (normalizePath(parent) === normalizePath(root)) return null;
			return entries.some((r) => r.key === parent) ? { focus: parent } : null;
		}
		default:
			return null;
	}
}
