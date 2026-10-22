import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { AgentError } from "./errors.js";

/** Expands a leading "~" and resolves relative paths against the home directory. */
export function resolveUserPath(input: string, home = homedir()): string {
	if (typeof input !== "string" || input === "") throw new AgentError("BAD_PATH", "路径不能为空");
	if (input.includes("\0")) throw new AgentError("BAD_PATH", "路径包含非法字符");
	let p = input;
	if (p === "~") p = home;
	else if (p.startsWith("~/")) p = join(home, p.slice(2));
	return isAbsolute(p) ? resolve(p) : resolve(home, p);
}

/** True when `child` equals `parent` or lies inside it (both absolute, normalized). */
export function isWithin(parent: string, child: string): boolean {
	if (child === parent) return true;
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(prefix);
}

/**
 * Validates a relative POSIX path that must stay inside a base directory
 * (no absolute paths, no "..", no NUL). Returns the normalized relative path.
 */
export function safeRelativePath(rel: unknown): string {
	if (typeof rel !== "string" || rel === "" || rel.includes("\0") || rel.includes("\\")) {
		throw new AgentError("BAD_PATH", `非法路径：${String(rel)}`);
	}
	if (rel.startsWith("/") || isAbsolute(rel)) throw new AgentError("BAD_PATH", `不允许绝对路径：${rel}`);
	if (rel.split("/").some((seg) => seg === "..")) throw new AgentError("BAD_PATH", `路径越界：${rel}`);
	const normalized = posix.normalize(rel).replace(/\/+$/, "");
	if (normalized === "" || normalized === "." || normalized.startsWith("../") || normalized === "..") {
		throw new AgentError("BAD_PATH", `非法路径：${rel}`);
	}
	return normalized;
}

/** Joins a validated relative path to `base`, re-checking containment. */
export function joinInside(base: string, rel: string): string {
	const normalized = safeRelativePath(rel);
	const full = resolve(base, ...normalized.split("/"));
	if (!isWithin(resolve(base), full) || full === resolve(base)) {
		throw new AgentError("BAD_PATH", `路径越界：${rel}`);
	}
	return full;
}

export function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolvePromise(hash.digest("hex")));
	});
}

export function symlinkSha(target: string): string {
	return sha256(`symlink:${target}`);
}

/** Writes a file atomically (temp file in the same directory + rename). */
export async function writeFileAtomic(path: string, content: string | Buffer, mode = 0o600): Promise<void> {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		await writeFile(tmp, content, { mode });
		await rename(tmp, path);
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}
