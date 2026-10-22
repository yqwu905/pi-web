/**
 * Unified diff parsing for DiffView. Understands `git diff` output (multiple files,
 * rename/mode/binary headers), the `diff` package's createPatch output ("Index:" headers)
 * and bare hunks. Hunk line counts are tracked so content lines such as "--- x" inside a
 * hunk are never mistaken for file headers.
 */
import { createTwoFilesPatch } from "diff";

export type DiffLineType = "context" | "add" | "del" | "note";

export interface DiffLine {
	type: DiffLineType;
	/** Line text without the leading marker (" ", "+", "-", "\"). */
	content: string;
	oldNo?: number;
	newNo?: number;
}

export interface DiffHunk {
	/** The full "@@ -a,b +c,d @@ section" line. */
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** Text after the closing "@@" (function context), trimmed. */
	section: string;
	lines: DiffLine[];
}

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface DiffFile {
	/** null for /dev/null (added files) or when unknown. */
	oldPath: string | null;
	/** null for /dev/null (deleted files) or when unknown. */
	newPath: string | null;
	status: DiffFileStatus;
	binary: boolean;
	oldMode?: string;
	newMode?: string;
	similarity?: number;
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function unquote(path: string): string {
	if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
		return path.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
	}
	return path;
}

/** Parses the path of a "--- "/"+++ " line ("a/x", "/dev/null", "x\t2024-01-01 …"). */
function parseHeaderPath(raw: string): string | null {
	let p = raw;
	const tab = p.indexOf("\t");
	if (tab >= 0) p = p.slice(0, tab);
	p = unquote(p.trim());
	if (p === "/dev/null") return null;
	if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
	return p;
}

function parseGitHeaderPaths(rest: string): { oldPath: string | null; newPath: string | null } {
	// rest is `a/<old> b/<new>`, possibly quoted.
	const quoted = /^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
	if (quoted) return { oldPath: unquote(`"${quoted[1]}"`), newPath: unquote(`"${quoted[2]}"`) };
	if (rest.startsWith("a/")) {
		// Prefer a split where both halves are equal (the common, unrenamed case).
		const body = rest.slice(2);
		const half = (body.length - 3) / 2;
		if (Number.isInteger(half) && body.slice(half, half + 3) === " b/" && body.slice(0, half) === body.slice(half + 3)) {
			return { oldPath: body.slice(0, half), newPath: body.slice(half + 3) };
		}
		const idx = body.indexOf(" b/");
		if (idx >= 0) return { oldPath: body.slice(0, idx), newPath: body.slice(idx + 3) };
	}
	return { oldPath: null, newPath: null };
}

function newFile(init: Partial<DiffFile> = {}): DiffFile {
	return {
		oldPath: null,
		newPath: null,
		status: "modified",
		binary: false,
		hunks: [],
		additions: 0,
		deletions: 0,
		...init,
	};
}

export function parseUnifiedDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	if (!text) return files;
	const lines = text.split("\n");
	if (lines.length && lines[lines.length - 1] === "") lines.pop();

	let file: DiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let oldRemaining = 0;
	let newRemaining = 0;
	let oldNo = 0;
	let newNo = 0;
	// True once a file's "---" line was seen, so a following "+++" belongs to it.
	let sawOldHeader = false;

	const startFile = (init: Partial<DiffFile> = {}): DiffFile => {
		file = newFile(init);
		files.push(file);
		hunk = null;
		oldRemaining = 0;
		newRemaining = 0;
		sawOldHeader = false;
		return file;
	};
	const ensureFile = (): DiffFile => file ?? startFile();

	for (const rawLine of lines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const current = file as DiffFile | null;
		const currentHunk = hunk as DiffHunk | null;

		if (currentHunk && current && (oldRemaining > 0 || newRemaining > 0)) {
			const marker = line[0];
			if (marker === "+") {
				currentHunk.lines.push({ type: "add", content: line.slice(1), newNo: newNo++ });
				current.additions++;
				newRemaining--;
				continue;
			}
			if (marker === "-") {
				currentHunk.lines.push({ type: "del", content: line.slice(1), oldNo: oldNo++ });
				current.deletions++;
				oldRemaining--;
				continue;
			}
			if (marker === "\\") {
				currentHunk.lines.push({ type: "note", content: line.slice(1).trim() });
				continue;
			}
			if (marker === " " || line === "") {
				currentHunk.lines.push({ type: "context", content: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
				oldRemaining--;
				newRemaining--;
				continue;
			}
			// Malformed hunk (counts too large): fall through and treat as header text.
			oldRemaining = 0;
			newRemaining = 0;
		}

		if (line.startsWith("\\") && currentHunk) {
			currentHunk.lines.push({ type: "note", content: line.slice(1).trim() });
			continue;
		}

		if (line.startsWith("diff --git ")) {
			const { oldPath, newPath } = parseGitHeaderPaths(line.slice("diff --git ".length));
			startFile({ oldPath, newPath });
			continue;
		}
		if (line.startsWith("diff ") && !line.startsWith("diff --git")) {
			startFile();
			continue;
		}
		if (line.startsWith("Index: ")) {
			const p = line.slice("Index: ".length).trim();
			startFile({ oldPath: p, newPath: p });
			continue;
		}
		if (/^={10,}$/.test(line)) continue;

		const m = HUNK_RE.exec(line);
		if (m) {
			const f = ensureFile();
			const h: DiffHunk = {
				header: line,
				oldStart: Number(m[1]),
				oldLines: m[2] === undefined ? 1 : Number(m[2]),
				newStart: Number(m[3]),
				newLines: m[4] === undefined ? 1 : Number(m[4]),
				section: (m[5] ?? "").trim(),
				lines: [],
			};
			f.hunks.push(h);
			hunk = h;
			oldRemaining = h.oldLines;
			newRemaining = h.newLines;
			oldNo = h.oldStart;
			newNo = h.newStart;
			continue;
		}

		if (line.startsWith("--- ")) {
			// A "---" after hunks of the current file starts the next file of a plain multi-file diff.
			const f = !current || current.hunks.length > 0 || sawOldHeader ? startFile() : current;
			f.oldPath = parseHeaderPath(line.slice(4));
			if (f.oldPath === null) f.status = "added";
			sawOldHeader = true;
			continue;
		}
		if (line.startsWith("+++ ")) {
			const f = ensureFile();
			f.newPath = parseHeaderPath(line.slice(4));
			if (f.newPath === null) f.status = "deleted";
			sawOldHeader = false;
			continue;
		}

		if (!current) continue;
		if (line.startsWith("new file mode ")) {
			current.status = "added";
			current.newMode = line.slice("new file mode ".length).trim();
		} else if (line.startsWith("deleted file mode ")) {
			current.status = "deleted";
			current.oldMode = line.slice("deleted file mode ".length).trim();
		} else if (line.startsWith("old mode ")) {
			current.oldMode = line.slice("old mode ".length).trim();
		} else if (line.startsWith("new mode ")) {
			current.newMode = line.slice("new mode ".length).trim();
		} else if (line.startsWith("rename from ")) {
			current.status = "renamed";
			current.oldPath = unquote(line.slice("rename from ".length));
		} else if (line.startsWith("rename to ")) {
			current.status = "renamed";
			current.newPath = unquote(line.slice("rename to ".length));
		} else if (line.startsWith("copy from ")) {
			current.status = "copied";
			current.oldPath = unquote(line.slice("copy from ".length));
		} else if (line.startsWith("copy to ")) {
			current.status = "copied";
			current.newPath = unquote(line.slice("copy to ".length));
		} else if (line.startsWith("similarity index ")) {
			current.similarity = Number.parseInt(line.slice("similarity index ".length), 10);
		} else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
			current.binary = true;
		}
	}

	for (const f of files) {
		if (f.status === "added" && f.oldPath === f.newPath) f.oldPath = null;
		if (f.status === "deleted" && f.oldPath === f.newPath) f.newPath = null;
	}
	return files;
}

/** Display path of a file entry ("old → new" for renames). */
export function diffFilePath(file: DiffFile): string {
	if ((file.status === "renamed" || file.status === "copied") && file.oldPath && file.newPath && file.oldPath !== file.newPath) {
		return `${file.oldPath} → ${file.newPath}`;
	}
	return file.newPath ?? file.oldPath ?? "";
}

export interface DiffStats {
	files: number;
	additions: number;
	deletions: number;
}

export function diffStats(files: DiffFile[]): DiffStats {
	return files.reduce<DiffStats>(
		(acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
		{ files: 0, additions: 0, deletions: 0 },
	);
}

export type SplitRow = { kind: "pair"; left: DiffLine | null; right: DiffLine | null } | { kind: "note"; text: string };

/**
 * Side-by-side rows for a hunk: context lines appear on both sides; a run of deletions
 * followed by a run of additions is paired line by line, the remainder padded with null.
 */
export function toSplitRows(hunk: DiffHunk): SplitRow[] {
	const rows: SplitRow[] = [];
	let dels: DiffLine[] = [];
	let adds: DiffLine[] = [];
	const flush = () => {
		const n = Math.max(dels.length, adds.length);
		for (let i = 0; i < n; i++) rows.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
		dels = [];
		adds = [];
	};
	for (const line of hunk.lines) {
		if (line.type === "del") {
			if (adds.length) flush();
			dels.push(line);
		} else if (line.type === "add") {
			adds.push(line);
		} else if (line.type === "note") {
			flush();
			rows.push({ kind: "note", text: line.content });
		} else {
			flush();
			rows.push({ kind: "pair", left: line, right: line });
		}
	}
	flush();
	return rows;
}

/** Unified diff text for an in-memory edit (e.g. pi's edit tool oldText → newText). */
export function makeUnifiedDiff(oldText: string, newText: string, path = "file", context = 3): string {
	return createTwoFilesPatch(`a/${path}`, `b/${path}`, oldText, newText, undefined, undefined, { context });
}
