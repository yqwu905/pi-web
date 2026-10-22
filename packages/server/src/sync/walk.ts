/**
 * Host file tree walker for the desired sync tree. Symlinks whose target stays inside
 * the walked root are kept as links (relative targets); every other symlink is
 * dereferenced and its content copied.
 */
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type HashCache, linkSha256, type NativeKind } from "./hash-cache.js";

export interface WalkedFile {
	kind: "file";
	/** Relative POSIX path in the remote agent dir. */
	rel: string;
	/** Host path to read the content from. */
	abs: string;
	size: number;
	mtimeMs: number;
	mode: number;
	sha256: string;
	native?: NativeKind;
}
export interface WalkedLink {
	kind: "link";
	rel: string;
	link: string;
	sha256: string;
}
export type WalkedEntry = WalkedFile | WalkedLink;

const MAX_DEPTH = 64;

interface DirState {
	/** Real path of the walked root; links resolving inside it are kept. */
	containment: string;
	/** Inside a dereferenced subtree: every symlink is dereferenced. */
	deref: boolean;
	/** Real paths of the dereferenced ancestors (cycle detection). */
	ancestors: Set<string>;
	depth: number;
}

export function isWithin(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Names never synced at any depth. */
export function isIgnoredName(name: string, isDir: boolean): boolean {
	if (name === ".DS_Store") return true;
	if (isDir) return name === ".git";
	return name.endsWith(".log");
}

/**
 * Walk a host file or directory and return its entries with remote paths under `remotePrefix`.
 * Missing roots yield an empty list.
 */
export async function walkHostTree(rootAbs: string, remotePrefix: string, cache: HashCache): Promise<WalkedEntry[]> {
	const out: WalkedEntry[] = [];
	let st: Stats;
	try {
		st = await lstat(rootAbs);
	} catch {
		return out;
	}
	let real: string;
	try {
		real = await realpath(rootAbs);
	} catch {
		return out;
	}
	const target = st.isSymbolicLink() ? await stat(real).catch(() => undefined) : st;
	if (!target) return out;
	if (target.isFile()) {
		await pushFile(out, remotePrefix, real, target, cache);
	} else if (target.isDirectory()) {
		await walkDir(real, real, remotePrefix, { containment: real, deref: false, ancestors: new Set([real]), depth: 0 }, cache, out);
	}
	return out;
}

async function walkDir(
	dirAbs: string,
	dirReal: string,
	relPrefix: string,
	state: DirState,
	cache: HashCache,
	out: WalkedEntry[],
): Promise<void> {
	if (state.depth > MAX_DEPTH) return;
	let dirents: Dirent[];
	try {
		dirents = await readdir(dirAbs, { withFileTypes: true });
	} catch {
		return;
	}
	dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const dirent of dirents) {
		const name = dirent.name;
		const abs = join(dirAbs, name);
		const rel = `${relPrefix}/${name}`;
		if (dirent.isSymbolicLink()) {
			await walkLink(abs, join(dirReal, name), dirReal, rel, state, cache, out);
		} else if (dirent.isDirectory()) {
			if (isIgnoredName(name, true)) continue;
			await walkDir(abs, join(dirReal, name), rel, { ...state, depth: state.depth + 1 }, cache, out);
		} else if (dirent.isFile()) {
			if (isIgnoredName(name, false)) continue;
			const st = await stat(abs).catch(() => undefined);
			if (st?.isFile()) await pushFile(out, rel, abs, st, cache);
		}
	}
}

async function walkLink(
	abs: string,
	linkReal: string,
	dirReal: string,
	rel: string,
	state: DirState,
	cache: HashCache,
	out: WalkedEntry[],
): Promise<void> {
	const name = rel.slice(rel.lastIndexOf("/") + 1);
	if (isIgnoredName(name, true) || isIgnoredName(name, false)) return;
	let target: string;
	try {
		target = await readlink(abs);
	} catch {
		return;
	}
	if (!state.deref) {
		const lexical = resolve(dirReal, target);
		if (isWithin(state.containment, lexical) && lexical !== linkReal) {
			const link = isAbsolute(target) ? relative(dirname(linkReal), lexical) || "." : target;
			out.push({ kind: "link", rel, link, sha256: linkSha256(link) });
			return;
		}
	}
	let real: string;
	try {
		real = await realpath(abs);
	} catch {
		return; // dangling link pointing outside the root
	}
	const st = await stat(real).catch(() => undefined);
	if (!st) return;
	if (st.isFile()) {
		await pushFile(out, rel, real, st, cache);
	} else if (st.isDirectory()) {
		if (state.ancestors.has(real)) return;
		const ancestors = new Set(state.ancestors).add(real);
		await walkDir(real, real, rel, { containment: state.containment, deref: true, ancestors, depth: state.depth + 1 }, cache, out);
	}
}

/** Adds a file entry; files that vanish while being hashed (e.g. during npm install) are skipped. */
async function pushFile(out: WalkedEntry[], rel: string, abs: string, st: Stats, cache: HashCache): Promise<void> {
	let hashed;
	try {
		hashed = await cache.hash(abs, st.size, st.mtimeMs);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	const entry: WalkedFile = { kind: "file", rel, abs, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777, sha256: hashed.sha256 };
	if (hashed.native) entry.native = hashed.native;
	out.push(entry);
}
