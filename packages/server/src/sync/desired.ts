/** Builds the desired remote agent-dir tree for one server from the host agent dir. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPlainObject, type ServerConfig, type SyncItemKey } from "@pi-web/shared";
import { type HashCache, type NativeKind, sha256 } from "./hash-cache.js";
import { AGENTS_SKILLS_REMOTE, EXTERNAL_ROOT, itemDefinition, rootsForItems } from "./items.js";
import { type ExternalRef, toJsonFile, transformAuth, transformSettings } from "./transform.js";
import { walkHostTree, type WalkedEntry } from "./walk.js";
import { authWarnings, mcpWarnings, modelsWarnings, nativeWarnings } from "./warnings.js";

export interface DesiredEntry {
	/** Relative POSIX path under the remote agent dir. */
	path: string;
	item: SyncItemKey;
	size: number;
	sha256: string;
	mode?: number;
	/** Symlink target (kept relative). */
	link?: string;
	/** Host file to copy. */
	source?: string;
	/** Generated content (transformed settings.json / auth.json). */
	content?: Buffer;
}

export interface DesiredTree {
	entries: Map<string, DesiredEntry>;
	/** Roots for sync.manifest. */
	roots: string[];
	/**
	 * Roots whose host source could not be read this time (unparsable settings.json/auth.json,
	 * missing host agent dir): nothing under them is deleted on the server.
	 */
	protectedRoots: string[];
	warnings: string[];
	/** Host paths outside the agent dir that feed this tree (for the watcher). */
	externalPaths: string[];
}

export interface DesiredTreeOptions {
	hostAgentDir: string;
	homeDir: string;
	/** Host ~/.agents/skills. */
	agentsSkillsDir: string;
	server: Pick<ServerConfig, "proxy" | "sync">;
	items: readonly SyncItemKey[];
	/** Server architecture for native addon checks. */
	arch?: string;
	/** Effective NO_PROXY entries of the server (settings.defaultNoProxy ∪ server.proxy.noProxy). */
	noProxy: readonly string[];
	hashCache: HashCache;
}

const NATIVE_ITEMS = new Set<SyncItemKey>(["npm", "git", "extensions", "skills", "agentsSkills", "settings"]);

async function readJsonObject(path: string): Promise<{ value?: Record<string, unknown>; mode?: number; error?: string; missing?: boolean }> {
	let text: string;
	let mode: number | undefined;
	try {
		const st = await stat(path);
		if (!st.isFile()) return { missing: true };
		mode = st.mode & 0o777;
		text = await readFile(path, "utf8");
	} catch {
		return { missing: true };
	}
	try {
		const value = JSON.parse(text.replace(/^﻿/, "")) as unknown;
		if (!isPlainObject(value)) return { error: "顶层不是 JSON 对象", mode };
		return { value, mode };
	} catch (err) {
		return { error: (err as Error).message, mode };
	}
}

async function dirExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function buildDesiredTree(options: DesiredTreeOptions): Promise<DesiredTree> {
	const { hostAgentDir, items, hashCache } = options;
	const entries = new Map<string, DesiredEntry>();
	const warnings: string[] = [];
	const externalPaths: string[] = [];
	const natives: Array<{ rel: string; native: NativeKind }> = [];

	const addWalked = (walked: WalkedEntry[], item: SyncItemKey): void => {
		for (const entry of walked) {
			if (entry.kind === "link") {
				entries.set(entry.rel, { path: entry.rel, item, size: 0, sha256: entry.sha256, link: entry.link });
			} else {
				entries.set(entry.rel, { path: entry.rel, item, size: entry.size, sha256: entry.sha256, mode: entry.mode, source: entry.abs });
				if (entry.native && NATIVE_ITEMS.has(item)) natives.push({ rel: entry.rel, native: entry.native });
			}
		}
	};
	const addGenerated = (path: string, item: SyncItemKey, content: Buffer, mode: number): void => {
		entries.set(path, { path, item, size: content.length, sha256: sha256(content), mode, content });
	};
	const walkInto = async (abs: string, remote: string, item: SyncItemKey): Promise<void> => {
		addWalked(await walkHostTree(abs, remote, hashCache), item);
	};

	const roots = rootsForItems(items);
	if (!(await dirExists(hostAgentDir))) {
		// A missing (mistyped, unmounted) host agent dir must not read as "everything was deleted".
		warnings.push(`Host 的 agent 目录不存在或不可读：${hostAgentDir}，本次不同步任何文件`);
		return { entries, roots, protectedRoots: roots, warnings, externalPaths };
	}
	const protectedRoots: string[] = [];
	const agentsSkillsEnabled = items.includes("agentsSkills") && (await dirExists(options.agentsSkillsDir));

	for (const item of items) {
		switch (item) {
			case "settings": {
				const file = await readJsonObject(join(hostAgentDir, "settings.json"));
				if (file.error) {
					warnings.push(`Host 的 settings.json 无法解析（${file.error}），本次未同步 settings.json`);
					// Keep the server's copies (and the externals it references) until the file parses again.
					protectedRoots.push("settings.json", EXTERNAL_ROOT);
					break;
				}
				const result = transformSettings(file.value ?? {}, {
					hostAgentDir,
					homeDir: options.homeDir,
					server: options.server,
					agentsSkillsDir: agentsSkillsEnabled ? options.agentsSkillsDir : undefined,
				});
				warnings.push(...result.warnings);
				if (!file.missing || Object.keys(result.settings).length > 0) {
					addGenerated("settings.json", "settings", toJsonFile(result.settings), file.mode ?? 0o644);
				}
				await addExternals(result.externals, walkInto, externalPaths);
				break;
			}
			case "auth": {
				const file = await readJsonObject(join(hostAgentDir, "auth.json"));
				if (file.error) {
					warnings.push(`Host 的 auth.json 无法解析（${file.error}），本次未同步凭据`);
					protectedRoots.push("auth.json");
					break;
				}
				if (file.missing || !file.value) break;
				warnings.push(...authWarnings(file.value));
				addGenerated("auth.json", "auth", toJsonFile(transformAuth(file.value)), 0o600);
				break;
			}
			case "agentsSkills": {
				if (agentsSkillsEnabled) {
					await walkInto(options.agentsSkillsDir, AGENTS_SKILLS_REMOTE, item);
					externalPaths.push(options.agentsSkillsDir);
				}
				break;
			}
			default: {
				for (const rel of itemDefinition(item).paths) await walkInto(join(hostAgentDir, rel), rel, item);
				if (item === "models") {
					const file = await readJsonObject(join(hostAgentDir, "models.json"));
					if (file.error) warnings.push(`Host 的 models.json 无法解析（${file.error}），服务器上的 pi 也将无法读取它`);
					if (file.value) {
						warnings.push(...modelsWarnings(file.value, { tunnel: options.server.proxy.mode === "tunnel", noProxy: options.noProxy }));
					}
				} else if (item === "mcp") {
					const file = await readJsonObject(join(hostAgentDir, "mcp.json"));
					if (file.value) warnings.push(...mcpWarnings(file.value));
				}
			}
		}
	}

	warnings.push(...nativeWarnings(natives, options.arch));
	return { entries, roots, protectedRoots, warnings, externalPaths };
}

async function addExternals(
	externals: ExternalRef[],
	walkInto: (abs: string, remote: string, item: SyncItemKey) => Promise<void>,
	externalPaths: string[],
): Promise<void> {
	for (const ref of externals) {
		await walkInto(ref.abs, ref.remote, "settings");
		externalPaths.push(ref.abs);
	}
}
