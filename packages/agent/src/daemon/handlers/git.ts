import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type {
	GitCommit,
	GitDiffParams,
	GitDiffResult,
	GitLogParams,
	GitLogResult,
	GitStatusParams,
	GitStatusResult,
} from "@pi-web/shared";
import { AgentError } from "../errors.js";
import { resolveUserPath } from "../fsutil.js";

const DIFF_LIMIT = 4 * 1024 * 1024;
const STATUS_LIMIT = 32 * 1024 * 1024;

export interface GitRunResult {
	code: number | null;
	stdout: Buffer;
	stderr: string;
	truncated: boolean;
}

/** Runs git without a shell (`-c core.quotepath=off`, no prompts, C locale). */
export function runGit(cwd: string, args: string[], options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<GitRunResult> {
	const maxBytes = options.maxBytes ?? STATUS_LIMIT;
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["-c", "core.quotepath=off", ...args], {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
		child.stdout.on("data", (chunk: Buffer) => {
			if (truncated) return;
			if (size + chunk.length > maxBytes) {
				chunks.push(chunk.subarray(0, maxBytes - size));
				size = maxBytes;
				truncated = true;
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
			size += chunk.length;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new AgentError("GIT_UNAVAILABLE", `无法执行 git：${err.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(chunks), stderr, truncated });
		});
	});
}

async function resolveCwd(cwd: string): Promise<string> {
	const dir = resolveUserPath(cwd);
	const s = await stat(dir).catch(() => null);
	if (!s?.isDirectory()) throw new AgentError("ENOENT", `目录不存在：${dir}`);
	return dir;
}

/** Repository top level, or null when `cwd` is not inside a work tree. */
async function repoRoot(cwd: string): Promise<string | null> {
	const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return null;
	return result.stdout.toString("utf8").trim() || null;
}

function parseNumstat(out: string): Map<string, { additions?: number; deletions?: number; binary?: boolean }> {
	const map = new Map<string, { additions?: number; deletions?: number; binary?: boolean }>();
	const parts = out.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const record = parts[i];
		if (!record) continue;
		const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
		if (!m) continue;
		let path = m[3];
		if (path === "") {
			// rename/copy: "<a>\t<d>\t\0<old>\0<new>\0"
			i += 2;
			path = parts[i] ?? "";
		}
		const binary = m[1] === "-" && m[2] === "-";
		map.set(path, binary ? { binary: true } : { additions: Number(m[1]), deletions: Number(m[2]) });
	}
	return map;
}

export async function gitStatus(params: GitStatusParams): Promise<GitStatusResult> {
	const cwd = await resolveCwd(params?.cwd);
	const root = await repoRoot(cwd);
	if (!root) return { isRepo: false, ahead: 0, behind: 0, files: [] };
	const status = await runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
	if (status.code !== 0) throw new AgentError("GIT_FAILED", `git status 失败：${status.stderr.trim()}`);
	const result: GitStatusResult = { isRepo: true, root, ahead: 0, behind: 0, files: [] };
	const parts = status.stdout.toString("utf8").split("\0");
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (!rec) continue;
		if (rec.startsWith("# ")) {
			const [key, ...rest] = rec.slice(2).split(" ");
			const value = rest.join(" ");
			if (key === "branch.oid") {
				if (value !== "(initial)") result.headShort = value.slice(0, 7);
			} else if (key === "branch.head") {
				if (value === "(detached)") result.detached = true;
				else result.branch = value;
			} else if (key === "branch.upstream") {
				result.upstream = value;
			} else if (key === "branch.ab") {
				const m = /^\+(\d+) -(\d+)$/.exec(value);
				if (m) {
					result.ahead = Number(m[1]);
					result.behind = Number(m[2]);
				}
			}
			continue;
		}
		const kind = rec[0];
		if (kind === "?") {
			result.files.push({ path: rec.slice(2), area: "untracked", code: "?" });
		} else if (kind === "1" || kind === "2") {
			const fields = rec.split(" ");
			const xy = fields[1];
			const path = fields.slice(kind === "1" ? 8 : 9).join(" ");
			let origPath: string | undefined;
			if (kind === "2") {
				i++;
				origPath = parts[i];
			}
			const x = xy[0];
			const y = xy[1];
			if (x !== ".") result.files.push({ path, origPath, area: "staged", code: x });
			if (y !== ".") result.files.push({ path, area: "unstaged", code: y });
		} else if (kind === "u") {
			const fields = rec.split(" ");
			result.files.push({ path: fields.slice(10).join(" "), area: "conflict", code: "U" });
		}
	}
	const [unstaged, staged] = await Promise.all([
		runGit(root, ["diff", "--numstat", "-z", "--no-ext-diff"]),
		runGit(root, ["diff", "--cached", "--numstat", "-z", "--no-ext-diff"]),
	]);
	const unstagedStats = parseNumstat(unstaged.stdout.toString("utf8"));
	const stagedStats = parseNumstat(staged.stdout.toString("utf8"));
	for (const file of result.files) {
		const stats = file.area === "staged" ? stagedStats.get(file.path) : file.area === "unstaged" ? unstagedStats.get(file.path) : undefined;
		if (stats) Object.assign(file, stats);
	}
	return result;
}

function decodeDiff(result: GitRunResult): GitDiffResult {
	return { diff: result.stdout.toString("utf8"), truncated: result.truncated };
}

export async function gitDiff(params: GitDiffParams): Promise<GitDiffResult> {
	const cwd = await resolveCwd(params?.cwd);
	const root = await repoRoot(cwd);
	if (!root) throw new AgentError("NOT_A_REPO", "不是 Git 仓库");
	const context = Number.isInteger(params.contextLines) && (params.contextLines as number) >= 0 ? params.contextLines : 3;
	const base = ["diff", "--no-color", "--no-ext-diff", `-U${context}`];
	if (params.area === "untracked") {
		const paths = params.path ? [params.path] : await listUntracked(root);
		let diff = "";
		let truncated = false;
		for (const path of paths) {
			const remaining = DIFF_LIMIT - Buffer.byteLength(diff);
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			const result = await runGit(root, [...base, "--no-index", "--", "/dev/null", path], { maxBytes: remaining });
			// --no-index exits with 1 when the files differ
			if (result.code !== 0 && result.code !== 1 && !result.truncated) {
				throw new AgentError("GIT_FAILED", `git diff 失败：${result.stderr.trim()}`);
			}
			diff += result.stdout.toString("utf8");
			if (result.truncated) {
				truncated = true;
				break;
			}
		}
		return { diff, truncated };
	}
	const args = params.area === "staged" ? [...base, "--cached"] : base;
	if (params.path) args.push("--", params.path);
	const result = await runGit(root, args, { maxBytes: DIFF_LIMIT });
	if (result.code !== 0 && !result.truncated) throw new AgentError("GIT_FAILED", `git diff 失败：${result.stderr.trim()}`);
	return decodeDiff(result);
}

async function listUntracked(root: string): Promise<string[]> {
	const result = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (result.code !== 0) return [];
	return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

export async function gitLog(params: GitLogParams): Promise<GitLogResult> {
	const cwd = await resolveCwd(params?.cwd);
	const limit = Number.isInteger(params.limit) && (params.limit as number) > 0 ? Math.min(params.limit as number, 1000) : 50;
	const result = await runGit(cwd, ["log", "-n", String(limit), "--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%ct%x00%D%x1e"]);
	if (result.code !== 0) return { commits: [] };
	const commits: GitCommit[] = [];
	for (const raw of result.stdout.toString("utf8").split("\x1e")) {
		const rec = raw.replace(/^\n/, "");
		if (!rec) continue;
		const [hash, short, subject, author, email, ct, refs] = rec.split("\0");
		if (!hash) continue;
		const commit: GitCommit = { hash, short, subject, author, email, dateMs: Number(ct) * 1000 };
		if (refs) commit.refs = refs;
		commits.push(commit);
	}
	return { commits };
}

