/**
 * Git view helpers: change groups, status badges, diff labels, ref parsing and the
 * "发给 pi 审阅" prompt.
 */
import { type GitArea, type GitCommit, type GitFileStatus, type GitStatusResult, shellQuote } from "@pi-web/shared";
import type { Tone } from "../../../lib/status";
import { joinPath } from "./remote-path";

export type DiffArea = "staged" | "unstaged" | "untracked";

/** Display order of the change groups (conflicts first when present). */
export const GIT_AREA_ORDER: readonly GitArea[] = ["conflict", "staged", "unstaged", "untracked"];

export const GIT_AREA_LABELS: Record<GitArea, string> = {
	conflict: "冲突",
	staged: "已暂存",
	unstaged: "未暂存",
	untracked: "未跟踪",
};

export function groupGitFiles(files: readonly GitFileStatus[]): Record<GitArea, GitFileStatus[]> {
	const groups: Record<GitArea, GitFileStatus[]> = { conflict: [], staged: [], unstaged: [], untracked: [] };
	for (const f of files) groups[f.area]?.push(f);
	for (const list of Object.values(groups)) list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return groups;
}

/** Distinct changed paths (a file staged and modified again counts once). */
export function changedFileCount(status: Pick<GitStatusResult, "isRepo" | "files"> | undefined): number {
	if (!status?.isRepo) return 0;
	return new Set(status.files.map((f) => f.path)).size;
}

export interface GitBadge {
	letter: string;
	/** Accessible / tooltip text, e.g. "已修改". */
	label: string;
	tone: Tone;
}

/** Status letter shown next to a file (Files tree and Git list). */
export function gitBadge(file: Pick<GitFileStatus, "code" | "area">): GitBadge {
	if (file.area === "conflict") return { letter: "!", label: "冲突", tone: "danger" };
	if (file.area === "untracked" || file.code === "?") return { letter: "U", label: "未跟踪", tone: "success" };
	switch (file.code) {
		case "M":
			return { letter: "M", label: "已修改", tone: "warning" };
		case "A":
			return { letter: "A", label: "已添加", tone: "success" };
		case "D":
			return { letter: "D", label: "已删除", tone: "danger" };
		case "R":
			return { letter: "R", label: "已重命名", tone: "accent" };
		case "C":
			return { letter: "C", label: "已复制", tone: "accent" };
		case "T":
			return { letter: "T", label: "类型变更", tone: "warning" };
		default:
			return { letter: file.code || "?", label: "已变更", tone: "neutral" };
	}
}

const MARK_PRIORITY: Record<GitArea, number> = { conflict: 3, unstaged: 2, staged: 1, untracked: 0 };

/**
 * Absolute path → most relevant status for decorating the file tree. Status paths are
 * relative to the repository root (`status.root`).
 */
export function gitMarksByPath(status: GitStatusResult | undefined): Map<string, GitFileStatus> {
	const marks = new Map<string, GitFileStatus>();
	if (!status?.isRepo || !status.root) return marks;
	for (const f of status.files) {
		const abs = joinPath(status.root, f.path);
		const prev = marks.get(abs);
		if (!prev || MARK_PRIORITY[f.area] > MARK_PRIORITY[prev.area]) marks.set(abs, f);
	}
	return marks;
}

/** Text for a file's state next to the badge: "已修改，未暂存". */
export function gitStateText(file: Pick<GitFileStatus, "code" | "area">): string {
	const badge = gitBadge(file);
	if (file.area === "untracked" || file.area === "conflict") return badge.label;
	return `${badge.label}，${GIT_AREA_LABELS[file.area]}`;
}

/** The diff area to request for a file (conflicts are shown with the worktree diff). */
export function diffAreaFor(area: GitArea): DiffArea {
	return area === "conflict" ? "unstaged" : area;
}

/** The git command the agent runs for this diff (shown in the footer). */
export function diffCommand(area: GitArea, path: string): string {
	const p = shellQuote(path);
	if (area === "untracked") return `git diff --no-index -- /dev/null ${p}`;
	if (area === "staged") return `git diff --cached -- ${p}`;
	return `git diff -- ${p}`;
}

/** Column titles for the side-by-side view. */
export function splitLabelsFor(area: GitArea): [string, string] {
	switch (area) {
		case "staged":
			return ["旧 · HEAD", "新 · 暂存区"];
		case "untracked":
			return ["旧 · 无此文件", "新 · 工作区"];
		default:
			return ["旧 · 暂存区", "新 · 工作区"];
	}
}

/** "src/data/loader.py" → { dir: "src/data/", name: "loader.py" }. */
export function splitDirName(path: string): { dir: string; name: string } {
	const i = path.lastIndexOf("/");
	return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export interface RefChip {
	label: string;
	kind: "head" | "branch" | "remote" | "tag";
}

/** Parses `git log --format=%D` ("HEAD -> main, origin/main, tag: v1"). */
export function parseRefs(refs: string | undefined, remotes: readonly string[] = ["origin"]): RefChip[] {
	if (!refs) return [];
	const chips: RefChip[] = [];
	for (const raw of refs.split(",")) {
		const ref = raw.trim();
		if (!ref) continue;
		if (ref.startsWith("HEAD -> ")) chips.push({ label: ref.slice(8), kind: "branch" });
		else if (ref === "HEAD") chips.push({ label: "HEAD", kind: "head" });
		else if (ref.startsWith("tag: ")) chips.push({ label: ref.slice(5), kind: "tag" });
		else if (remotes.some((r) => ref.startsWith(`${r}/`))) chips.push({ label: ref, kind: "remote" });
		else chips.push({ label: ref, kind: "branch" });
	}
	return chips.filter((c) => !c.label.endsWith("/HEAD"));
}

/**
 * Commits not yet on the upstream: those listed before the first commit decorated with the
 * upstream ref; without that ref in the list, the first `ahead` commits.
 */
export function unpushedHashes(commits: readonly GitCommit[], upstream: string | undefined, ahead: number): Set<string> {
	const result = new Set<string>();
	if (!upstream || ahead <= 0) return result;
	const at = commits.findIndex((c) => parseRefs(c.refs).some((r) => r.label === upstream));
	const count = at >= 0 ? at : Math.min(ahead, commits.length);
	for (const c of commits.slice(0, count)) result.add(c.hash);
	return result;
}

export interface TruncatedText {
	text: string;
	truncated: boolean;
	/** Lines left out. */
	omittedLines: number;
}

/** Keeps whole lines of `text` within both limits. */
export function truncateLines(text: string, maxChars: number, maxLines: number): TruncatedText {
	const lines = text.replace(/\n$/, "").split("\n");
	const kept: string[] = [];
	let size = 0;
	for (const line of lines) {
		if (kept.length >= maxLines || size + line.length + 1 > maxChars) break;
		kept.push(line);
		size += line.length + 1;
	}
	const omittedLines = lines.length - kept.length;
	return { text: kept.join("\n"), truncated: omittedLines > 0, omittedLines };
}

export interface ReviewPromptInput {
	path: string;
	area: GitArea;
	diff: string;
	additions: number;
	deletions: number;
	/** Diff body limits (the prompt travels in a URL, so keep it modest). */
	maxChars?: number;
	maxLines?: number;
}

/** Chat prefill asking pi to review one file's diff; long diffs are cut at a line boundary. */
export function buildReviewPrompt(input: ReviewPromptInput): { text: string; truncated: boolean } {
	const { path, area, diff, additions, deletions } = input;
	const body = truncateLines(diff, input.maxChars ?? 4000, input.maxLines ?? 160);
	const stats = [additions > 0 ? `+${additions}` : "", deletions > 0 ? `−${deletions}` : ""].filter(Boolean).join(" ");
	const head = `请审阅 \`${path}\` 的改动（${GIT_AREA_LABELS[area]}${stats ? `，${stats}` : ""}），指出潜在的 bug、边界情况和可以改进的地方。`;
	const fence = body.text.includes("```") ? "````" : "```";
	const parts = [head, "", `${fence}diff`, body.text, fence];
	if (body.truncated) parts.push("", `（diff 较长，以上只包含前 ${body.text.split("\n").length} 行，另有 ${body.omittedLines} 行未包含；完整内容可运行 \`${diffCommand(area, path)}\` 查看。）`);
	return { text: parts.join("\n"), truncated: body.truncated };
}

/** File mode shown in the diff header: "100644", "新文件 · 100644", "100644 → 100755". */
export function diffModeText(file: { status: string; oldMode?: string; newMode?: string } | undefined, rawDiff: string): string {
	if (!file) return "";
	const indexMode = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/m.exec(rawDiff)?.[1];
	if (file.status === "added") return `新文件${file.newMode ? ` · ${file.newMode}` : ""}`;
	if (file.status === "deleted") return `已删除${file.oldMode ? ` · ${file.oldMode}` : ""}`;
	if (file.oldMode && file.newMode && file.oldMode !== file.newMode) return `${file.oldMode} → ${file.newMode}`;
	return file.newMode ?? indexMode ?? "";
}
