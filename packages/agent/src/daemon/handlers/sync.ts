import { execFile } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, readdir, readlink, realpath, rename, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import {
	SYNC_EXCLUDES,
	type SyncApplyParams,
	type SyncApplyResult,
	type SyncFileInfo,
	type SyncManifestParams,
	type SyncManifestResult,
} from "@pi-web/shared";
import { AgentError, errnoCode, errorMessage } from "../errors.js";
import { isWithin, joinInside, readJsonFile, safeRelativePath, sha256File, symlinkSha, writeFileAtomic } from "../fsutil.js";
import type { RemotePaths } from "../paths.js";

const SKIP_DIRS = new Set([".git"]);
/** Backup folder inside a shared agent dir (never a sync root, so never scanned or deleted). */
export const SHARED_BACKUP_DIR = ".pi-web-backup";
const SKIP_NAMES = new Set([".DS_Store"]);

interface HashCacheEntry {
	size: number;
	mtimeMs: number;
	sha256: string;
}

interface ManagedFile {
	version: 1;
	files: Record<string, string>;
}

/** True for paths that are never synced (top-level excludes and "*.log" anywhere). */
export function isExcluded(rel: string): boolean {
	const top = rel.split("/")[0];
	const base = posix.basename(rel);
	for (const pattern of SYNC_EXCLUDES) {
		if (pattern.startsWith("*.")) {
			if (base.endsWith(pattern.slice(1))) return true;
		} else if (top === pattern) {
			return true;
		}
	}
	return SKIP_NAMES.has(base);
}

export interface SyncDeps {
	paths: RemotePaths;
	getAgentDir: () => string;
}

export class SyncHandler {
	constructor(private readonly deps: SyncDeps) {}

	async manifest(params: SyncManifestParams): Promise<SyncManifestResult> {
		const agentDir = resolve(this.deps.getAgentDir());
		const roots = Array.isArray(params?.roots) ? params.roots : [];
		const oldCache = (await readJsonFile<Record<string, HashCacheEntry>>(this.deps.paths.hashCache)) ?? {};
		const newCache: Record<string, HashCacheEntry> = {};
		const files: Record<string, SyncFileInfo> = {};
		const scannedRoots: string[] = [];
		let cacheChanged = false;

		const visit = async (rel: string, st: Stats): Promise<void> => {
			if (isExcluded(rel)) return;
			const abs = join(agentDir, ...rel.split("/"));
			if (st.isSymbolicLink()) {
				const target = await readlink(abs);
				files[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: symlinkSha(target), link: target };
				return;
			}
			if (st.isFile()) {
				const cached = oldCache[rel];
				let sha: string;
				if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
					sha = cached.sha256;
				} else {
					sha = await sha256File(abs);
					cacheChanged = true;
				}
				newCache[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha };
				files[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha };
				return;
			}
			if (st.isDirectory()) {
				if (SKIP_DIRS.has(posix.basename(rel))) return;
				let dirents: Dirent[];
				try {
					dirents = await readdir(abs, { withFileTypes: true });
				} catch {
					return;
				}
				for (const d of dirents) {
					const childRel = `${rel}/${d.name}`;
					const childStat = await lstat(join(abs, d.name)).catch(() => null);
					if (childStat) await visit(childRel, childStat);
				}
			}
		};

		for (const root of roots) {
			const rel = safeRelativePath(root);
			scannedRoots.push(rel);
			const st = await lstat(join(agentDir, ...rel.split("/"))).catch(() => null);
			if (st) await visit(rel, st);
		}

		// Keep cache entries of roots that were not scanned this time.
		for (const [rel, entry] of Object.entries(oldCache)) {
			if (newCache[rel]) continue;
			const underScanned = scannedRoots.some((r) => rel === r || rel.startsWith(`${r}/`));
			if (underScanned) cacheChanged = true;
			else newCache[rel] = entry;
		}
		if (cacheChanged) await writeFileAtomic(this.deps.paths.hashCache, JSON.stringify(newCache), 0o600).catch(() => {});
		const managed = await this.loadManaged();
		return { agentDir, files, managed: managed.files };
	}

	async apply(params: SyncApplyParams): Promise<SyncApplyResult> {
		const agentDir = resolve(this.deps.getAgentDir());
		await mkdir(agentDir, { recursive: true, mode: 0o700 });
		const realAgentDir = await realpath(agentDir);
		const label = sanitizeLabel(params?.backupLabel);
		const backupRoot = join(this.backupBase(agentDir), label);
		const staging = join(this.deps.paths.incomingDir, label);
		const result: SyncApplyResult = { written: 0, deleted: 0, backedUp: [], errors: [] };
		const managed = await this.loadManaged();
		const writes = Array.isArray(params?.writes) ? params.writes : [];
		const deletes = Array.isArray(params?.deletes) ? params.deletes : [];
		const adopt = Array.isArray(params?.adopt) ? params.adopt : [];

		// Validate every path up front: one bad path rejects the whole request.
		for (const w of writes) safeRelativePath(w?.path);
		for (const d of deletes) safeRelativePath(d);
		for (const a of adopt) safeRelativePath(a?.path);

		// The manifest is saved as work progresses (and at the end, whatever happens), so a daemon
		// that dies mid-apply does not forget files it already wrote.
		let lastSaved = Date.now();
		const saveManaged = () => writeFileAtomic(this.deps.paths.syncManifest, `${JSON.stringify(managed)}\n`, 0o600);
		const progress = async () => {
			if (Date.now() - lastSaved < 1000) return;
			lastSaved = Date.now();
			await saveManaged().catch(() => {});
		};

		try {
			if (params.archivePath) {
				if (typeof params.archivePath !== "string" || !isAbsolute(params.archivePath)) {
					throw new AgentError("BAD_PATH", "归档路径必须是绝对路径");
				}
				await rm(staging, { recursive: true, force: true });
				await mkdir(staging, { recursive: true, mode: 0o700 });
				await extractTarGz(params.archivePath, staging);
			}

			const backup = async (rel: string, abs: string, st: Stats): Promise<void> => {
				const dest = join(backupRoot, ...rel.split("/"));
				await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
				if (st.isSymbolicLink()) {
					await rm(dest, { force: true });
					await symlink(await readlink(abs), dest);
				} else if (st.isDirectory()) {
					await cp(abs, dest, { recursive: true, verbatimSymlinks: true });
				} else {
					await copyFile(abs, dest);
				}
				result.backedUp.push(rel);
			};

			/** Backs up `abs` when it holds content the last sync did not write. */
			const backupIfConflict = async (rel: string, abs: string, newSha?: string): Promise<Stats | null> => {
				const st = await lstat(abs).catch(() => null);
				if (!st) return null;
				const current = st.isSymbolicLink() ? symlinkSha(await readlink(abs)) : st.isFile() ? await sha256File(abs) : null;
				if (current !== null && current === newSha) return st;
				if (current === null || managed.files[rel] !== current) await backup(rel, abs, st);
				return st;
			};

			// Deletes first: after a directory↔symlink swap on the host, a delete under the old
			// directory must not run once a write turned that directory into a link (it would delete
			// the link target's file), and writes must not go through a link that is about to go.
			for (const d of deletes) {
				const rel = safeRelativePath(d);
				try {
					const target = joinInside(agentDir, rel);
					await assertParentInside(realAgentDir, agentDir, target);
					if (await symlinkedParent(agentDir, target)) {
						// The file's directory is now a link: the file itself is gone from here.
						delete managed.files[rel];
						continue;
					}
					if ((await lstat(target).catch(() => null))?.isDirectory()) throw new Error("目标是目录，未删除");
					const st = await backupIfConflict(rel, target);
					if (st) {
						await unlink(target);
						await pruneEmptyDirs(agentDir, dirname(target));
						result.deleted++;
					}
					delete managed.files[rel];
				} catch (err) {
					result.errors.push({ path: rel, error: errorMessage(err) });
				}
				await progress();
			}

			for (const w of writes) {
				const rel = safeRelativePath(w.path);
				try {
					const target = joinInside(agentDir, rel);
					await assertParentInside(realAgentDir, agentDir, target);
					const linked = await symlinkedParent(agentDir, target);
					if (linked) throw new Error(`父目录 ${linked} 是符号链接，未写入（不经由链接写入其他目录）`);
					let source: string | null = null;
					if (w.link !== undefined) {
						if (typeof w.link !== "string" || symlinkSha(w.link) !== w.sha256) throw new Error("符号链接校验失败");
						const staged = params.archivePath ? join(staging, ...rel.split("/")) : null;
						const stagedStat = staged ? await lstat(staged).catch(() => null) : null;
						if (stagedStat?.isSymbolicLink() && (await readlink(staged as string)) !== w.link) throw new Error("符号链接目标不一致");
					} else {
						if (!params.archivePath) throw new Error("缺少归档文件");
						source = join(staging, ...rel.split("/"));
						const st = await lstat(source).catch(() => null);
						if (!st?.isFile()) throw new Error("归档中缺少该文件");
						if ((await sha256File(source)) !== w.sha256) throw new Error("sha256 校验失败");
						if (typeof w.mode === "number") await chmod(source, w.mode & 0o7777);
					}
					const existing = await backupIfConflict(rel, target, w.sha256);
					await mkdir(dirname(target), { recursive: true });
					if (existing?.isDirectory()) await rm(target, { recursive: true, force: true });
					if (source) {
						await moveInto(source, target);
					} else {
						const tmp = `${target}.pi-web-link.tmp`;
						await rm(tmp, { force: true });
						await symlink(w.link as string, tmp);
						await rename(tmp, target);
					}
					managed.files[rel] = w.sha256;
					result.written++;
				} catch (err) {
					result.errors.push({ path: rel, error: errorMessage(err) });
				}
				await progress();
			}

			// Already identical on the server: record as managed so later host deletions apply.
			for (const a of adopt) {
				const rel = safeRelativePath(a.path);
				try {
					const target = joinInside(agentDir, rel);
					if (await symlinkedParent(agentDir, target)) continue;
					const st = await lstat(target).catch(() => null);
					if (!st) continue;
					const current = st.isSymbolicLink() ? symlinkSha(await readlink(target)) : st.isFile() ? await sha256File(target) : null;
					if (current !== null && current === a.sha256) managed.files[rel] = a.sha256;
				} catch {
					// not adopted; nothing else changes
				}
			}
		} finally {
			await saveManaged();
			await rm(staging, { recursive: true, force: true }).catch(() => {});
			if (params?.archivePath && typeof params.archivePath === "string" && isWithin(this.deps.paths.root, resolve(params.archivePath))) {
				await rm(params.archivePath, { force: true }).catch(() => {});
			}
		}
		if (result.backedUp.length > 0) result.backupDir = backupRoot;
		return result;
	}

	/**
	 * Where conflict backups go. In the default layout the agent dir lives under R and so does
	 * state/backup. A shared agent dir (~/.pi/agent) holds the user's own files, which uninstall
	 * must not destroy together with R: their backups live next to them instead.
	 */
	private backupBase(agentDir: string): string {
		return isWithin(this.deps.paths.root, agentDir) ? this.deps.paths.backupDir : join(agentDir, SHARED_BACKUP_DIR);
	}

	private async loadManaged(): Promise<ManagedFile> {
		const raw = await readJsonFile<Partial<ManagedFile>>(this.deps.paths.syncManifest);
		const files = raw && raw.files && typeof raw.files === "object" ? raw.files : {};
		return { version: 1, files: { ...files } };
	}
}

function sanitizeLabel(label: unknown): string {
	const cleaned = typeof label === "string" ? label.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") : "";
	return cleaned.slice(0, 100) || `sync-${Date.now()}`;
}

function extractTarGz(archive: string, dest: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		execFile("tar", ["-xzf", archive, "-C", dest, "--no-same-owner"], { maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
			if (err) reject(new AgentError("EXTRACT_FAILED", `解压同步归档失败：${String(stderr).trim() || err.message}`));
			else resolvePromise();
		});
	});
}

/** Rejects writes whose existing parent directories resolve (via symlinks) outside the agent dir. */
async function assertParentInside(realAgentDir: string, agentDir: string, target: string): Promise<void> {
	let dir = dirname(target);
	while (isWithin(agentDir, dir)) {
		const real = await realpath(dir).catch((err) => {
			if (errnoCode(err) === "ENOENT") return null;
			throw err;
		});
		if (real !== null) {
			if (!isWithin(realAgentDir, real)) throw new AgentError("BAD_PATH", "路径越界（经由符号链接）");
			return;
		}
		if (dir === agentDir) return;
		dir = dirname(dir);
	}
}

/** The first directory between agentDir and target (exclusive) that is a symlink, as a relative path. */
async function symlinkedParent(agentDir: string, target: string): Promise<string | undefined> {
	const parts = target.slice(agentDir.length + 1).split(/[\\/]/).slice(0, -1);
	let current = agentDir;
	for (const part of parts) {
		current = join(current, part);
		const st = await lstat(current).catch(() => null);
		if (!st) return undefined;
		if (st.isSymbolicLink()) return current.slice(agentDir.length + 1);
	}
	return undefined;
}

async function moveInto(source: string, target: string): Promise<void> {
	try {
		await rename(source, target);
	} catch (err) {
		if (errnoCode(err) !== "EXDEV") throw err;
		const tmp = `${target}.pi-web.tmp`;
		await copyFile(source, tmp);
		const st = await lstat(source);
		await chmod(tmp, st.mode & 0o7777);
		await rename(tmp, target);
		await unlink(source).catch(() => {});
	}
}

async function pruneEmptyDirs(agentDir: string, dir: string): Promise<void> {
	let current = dir;
	while (current !== agentDir && isWithin(agentDir, current)) {
		try {
			await rmdir(current);
		} catch {
			return;
		}
		current = dirname(current);
	}
}
