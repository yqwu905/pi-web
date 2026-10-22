import { spawn } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
	FsEntry,
	FsEntryType,
	FsListParams,
	FsListResult,
	FsMkdirParams,
	FsReadParams,
	FsReadResult,
	FsRealpathParams,
	FsRealpathResult,
	FsStatParams,
	FsStatResult,
} from "@pi-web/shared";
import { AgentError, errnoCode } from "../errors.js";
import { resolveUserPath } from "../fsutil.js";

const DEFAULT_MAX_READ = 2 * 1024 * 1024;
/** Hard cap so a response (base64 included) stays well below the Link message limit. */
const MAX_READ = 32 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

function typeOf(s: Stats | Dirent): FsEntryType {
	if (s.isSymbolicLink()) return "symlink";
	if (s.isDirectory()) return "dir";
	if (s.isFile()) return "file";
	return "other";
}

function fsError(err: unknown, path: string): AgentError {
	switch (errnoCode(err)) {
		case "ENOENT":
			return new AgentError("ENOENT", `路径不存在：${path}`);
		case "EACCES":
		case "EPERM":
			return new AgentError("EACCES", `没有权限访问：${path}`);
		case "ENOTDIR":
			return new AgentError("ENOTDIR", `不是目录：${path}`);
		default:
			return new AgentError(errnoCode(err) ?? "FS_ERROR", `${(err as Error)?.message ?? String(err)}`);
	}
}

/** Paths among `names` (relative to `dir`) that git reports as ignored; empty when `dir` is not in a repo. */
export function gitIgnored(dir: string, names: string[]): Promise<Set<string>> {
	return new Promise((resolve) => {
		if (names.length === 0) {
			resolve(new Set());
			return;
		}
		const child = spawn("git", ["check-ignore", "--stdin", "-z"], {
			cwd: dir,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
			stdio: ["pipe", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (c: Buffer) => chunks.push(c));
		child.on("error", () => resolve(new Set()));
		child.on("close", (code) => {
			// 0 = some ignored, 1 = none ignored, 128 = not a repository / error
			if (code !== 0) {
				resolve(new Set());
				return;
			}
			const out = Buffer.concat(chunks).toString("utf8");
			resolve(new Set(out.split("\0").filter(Boolean).map((p) => p.replace(/\/$/, ""))));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(`${names.join("\0")}\0`);
	});
}

export async function fsList(params: FsListParams): Promise<FsListResult> {
	const dir = resolveUserPath(params?.path);
	let dirents: Dirent[];
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		throw fsError(err, dir);
	}
	const showHidden = params.showHidden ?? false;
	const entries: FsEntry[] = [];
	await Promise.all(
		dirents
			.filter((d) => showHidden || !d.name.startsWith("."))
			.map(async (d) => {
				const path = join(dir, d.name);
				let s: Stats;
				try {
					s = await lstat(path);
				} catch {
					return;
				}
				const entry: FsEntry = { name: d.name, path, type: typeOf(s), size: s.size, mtimeMs: s.mtimeMs };
				if (entry.type === "symlink") {
					try {
						const target = await stat(path);
						entry.targetType = typeOf(target);
						entry.size = target.size;
					} catch {
						// broken link
					}
				}
				entries.push(entry);
			}),
	);
	if (params.respectGitignore) {
		const isDir = (e: FsEntry) => e.type === "dir" || e.targetType === "dir";
		const ignored = await gitIgnored(
			dir,
			entries.map((e) => (isDir(e) ? `${e.name}/` : e.name)),
		);
		for (const e of entries) if (ignored.has(e.name)) e.ignored = true;
	}
	const visible = params.respectGitignore && params.hideIgnored ? entries.filter((e) => !e.ignored) : entries;
	const dirFirst = (e: FsEntry) => (e.type === "dir" || e.targetType === "dir" ? 0 : 1);
	visible.sort((a, b) => dirFirst(a) - dirFirst(b) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.name < b.name ? -1 : 1));
	const parent = dirname(dir);
	return { path: dir, parent: parent === dir ? null : parent, entries: visible };
}

export async function fsRead(params: FsReadParams): Promise<FsReadResult> {
	const path = resolveUserPath(params?.path);
	const maxBytes = params.maxBytes && params.maxBytes > 0 ? Math.min(Math.floor(params.maxBytes), MAX_READ) : DEFAULT_MAX_READ;
	let s: Stats;
	try {
		s = await stat(path);
	} catch (err) {
		throw fsError(err, path);
	}
	if (s.isDirectory()) throw new AgentError("EISDIR", `是目录，不能读取：${path}`);
	if (!s.isFile()) throw new AgentError("NOT_FILE", `不是普通文件：${path}`);
	const length = Math.min(s.size, maxBytes);
	const buffer = Buffer.alloc(length);
	let read = 0;
	const handle = await open(path, "r").catch((err) => {
		throw fsError(err, path);
	});
	try {
		while (read < length) {
			const { bytesRead } = await handle.read(buffer, read, length - read, read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
	} finally {
		await handle.close();
	}
	const data = buffer.subarray(0, read);
	const truncated = s.size > read;
	const binary = data.subarray(0, BINARY_SNIFF_BYTES).includes(0);
	let content: string;
	if (binary) {
		content = data.toString("base64");
	} else {
		// Drop an incomplete trailing UTF-8 sequence when the read was cut short.
		const decoder = new StringDecoder("utf8");
		content = decoder.write(data);
		if (!truncated) content += decoder.end();
	}
	return { path, size: s.size, mtimeMs: s.mtimeMs, encoding: binary ? "base64" : "utf8", content, truncated, binary };
}

export async function fsStat(params: FsStatParams): Promise<FsStatResult> {
	const path = resolveUserPath(params?.path);
	try {
		const s = await stat(path);
		return { path, exists: true, type: typeOf(s), size: s.size, mtimeMs: s.mtimeMs };
	} catch (err) {
		if (errnoCode(err) === "ENOENT") {
			const l = await lstat(path).catch(() => null);
			if (l) return { path, exists: true, type: "symlink", size: l.size, mtimeMs: l.mtimeMs };
			return { path, exists: false };
		}
		throw fsError(err, path);
	}
}

export async function fsMkdir(params: FsMkdirParams): Promise<{ ok: true }> {
	const path = resolveUserPath(params?.path);
	try {
		await mkdir(path, { recursive: params.recursive ?? true });
	} catch (err) {
		if (errnoCode(err) === "EEXIST") throw new AgentError("EEXIST", `路径已存在：${path}`);
		throw fsError(err, path);
	}
	return { ok: true };
}

export async function fsRealpath(params: FsRealpathParams): Promise<FsRealpathResult> {
	const path = resolveUserPath(params?.path);
	try {
		return { path: await realpath(path) };
	} catch (err) {
		throw fsError(err, path);
	}
}
