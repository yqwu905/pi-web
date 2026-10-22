/** Host agent dir inventory for the sync center (never exposes secret values). */
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type HostInventory, type HostInventoryItem, isPlainObject, SYNC_ITEMS, type SyncItemKey } from "@pi-web/shared";
import { isIgnoredName } from "./walk.js";

interface Tally {
	files: number;
	bytes: number;
}

async function tallyTree(path: string, tally: Tally, depth = 0): Promise<void> {
	if (depth > 64) return;
	let st;
	try {
		st = await stat(path);
	} catch {
		return;
	}
	if (st.isFile()) {
		tally.files++;
		tally.bytes += st.size;
		return;
	}
	if (!st.isDirectory()) return;
	let dirents: Dirent[];
	try {
		dirents = await readdir(path, { withFileTypes: true });
	} catch {
		return;
	}
	for (const dirent of dirents) {
		const isDir = dirent.isDirectory();
		if (isIgnoredName(dirent.name, isDir) || (!isDir && !dirent.isFile() && !dirent.isSymbolicLink())) continue;
		if (dirent.isSymbolicLink()) {
			// Count link targets without descending into linked directories (cheap and cycle-free).
			const target = await stat(join(path, dirent.name)).catch(() => undefined);
			if (target?.isFile()) {
				tally.files++;
				tally.bytes += target.size;
			}
			continue;
		}
		await tallyTree(join(path, dirent.name), tally, depth + 1);
	}
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value = JSON.parse((await readFile(path, "utf8")).replace(/^﻿/, "")) as unknown;
		return isPlainObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function listNames(dir: string): Promise<Dirent[]> {
	try {
		return (await readdir(dir, { withFileTypes: true })).filter((d) => !d.name.startsWith(".") && !isIgnoredName(d.name, d.isDirectory()));
	} catch {
		return [];
	}
}

async function countNpmPackages(dir: string): Promise<number> {
	let count = 0;
	for (const dirent of await listNames(join(dir, "node_modules"))) {
		if (dirent.name.startsWith("@")) count += (await listNames(join(dir, "node_modules", dirent.name))).length;
		else count++;
	}
	return count;
}

async function countGitPackages(dir: string, depth = 0): Promise<number> {
	if (depth > 4) return 0;
	let count = 0;
	for (const dirent of await listNames(dir)) {
		if (!dirent.isDirectory() || dirent.name === "node_modules") continue;
		const child = join(dir, dirent.name);
		const isPackage =
			(await lstat(join(child, ".git")).then(() => true, () => false)) ||
			(depth >= 2 && (await lstat(join(child, "package.json")).then(() => true, () => false)));
		count += isPackage ? 1 : await countGitPackages(child, depth + 1);
	}
	return count;
}

async function countPrompts(dir: string): Promise<number> {
	let count = 0;
	for (const dirent of await listNames(dir)) {
		if (dirent.isDirectory()) count += await countPrompts(join(dir, dirent.name));
		else if (dirent.name.endsWith(".md")) count++;
	}
	return count;
}

async function itemDetail(key: SyncItemKey, base: string, presentPaths: string[]): Promise<string | undefined> {
	switch (key) {
		case "settings": {
			const settings = await readJson(join(base, "settings.json"));
			return settings ? `${Object.keys(settings).length} 个设置项` : undefined;
		}
		case "models": {
			const models = await readJson(join(base, "models.json"));
			const providers = models && isPlainObject(models.providers) ? Object.values(models.providers) : [];
			const modelCount = providers.reduce<number>(
				(sum, p) => sum + (isPlainObject(p) && Array.isArray(p.models) ? p.models.length : 0),
				0,
			);
			return models ? `${providers.length} 个 provider · ${modelCount} 个模型` : undefined;
		}
		case "auth": {
			const auth = await readJson(join(base, "auth.json"));
			if (!auth) return undefined;
			let apiKeys = 0;
			let oauth = 0;
			for (const credential of Object.values(auth)) {
				if (!isPlainObject(credential)) continue;
				if (credential.type === "oauth") oauth++;
				else if (credential.type === "api_key") apiKeys++;
			}
			return `${apiKeys} 个 API Key · ${oauth} 个 OAuth`;
		}
		case "mcp": {
			const mcp = await readJson(join(base, "mcp.json"));
			return mcp ? `${isPlainObject(mcp.mcpServers) ? Object.keys(mcp.mcpServers).length : 0} 个服务器` : undefined;
		}
		case "instructions":
			return presentPaths.length > 0 ? presentPaths.join("、") : undefined;
		case "extensions":
		case "skills":
		case "themes":
		case "agentsSkills":
			return presentPaths.length > 0 ? `${(await listNames(base)).length} 个` : undefined;
		case "prompts":
			return presentPaths.length > 0 ? `${await countPrompts(base)} 个` : undefined;
		case "npm":
			return presentPaths.length > 0 ? `${await countNpmPackages(base)} 个包` : undefined;
		case "git":
			return presentPaths.length > 0 ? `${await countGitPackages(base)} 个包` : undefined;
		default:
			return undefined;
	}
}

export async function scanInventory(hostAgentDir: string, agentsSkillsDir: string, now = Date.now()): Promise<HostInventory> {
	const items: HostInventoryItem[] = [];
	for (const def of SYNC_ITEMS) {
		const tally: Tally = { files: 0, bytes: 0 };
		const presentPaths: string[] = [];
		const absPaths = def.key === "agentsSkills" ? [agentsSkillsDir] : def.paths.map((p) => join(hostAgentDir, p));
		for (let i = 0; i < absPaths.length; i++) {
			const exists = await stat(absPaths[i]).then(() => true, () => false);
			if (!exists) continue;
			presentPaths.push(def.key === "agentsSkills" ? def.paths[0] : def.paths[i]);
			await tallyTree(absPaths[i], tally);
		}
		const detailBase =
			def.key === "agentsSkills" ? agentsSkillsDir : def.paths.length === 1 && !def.paths[0].includes(".") ? join(hostAgentDir, def.paths[0]) : hostAgentDir;
		const item: HostInventoryItem = {
			key: def.key,
			label: def.label,
			present: presentPaths.length > 0,
			fileCount: tally.files,
			bytes: tally.bytes,
		};
		const detail = item.present ? await itemDetail(def.key, detailBase, presentPaths) : undefined;
		if (detail) item.detail = detail;
		items.push(item);
	}
	return { agentDir: hostAgentDir, items, scannedAt: now };
}
