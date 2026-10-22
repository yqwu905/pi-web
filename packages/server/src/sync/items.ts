/** Mapping between sync items and the paths they own on the host and on the server. */
import { SYNC_ITEM_KEYS, SYNC_ITEMS, type SyncConfig, type SyncItemDefinition, type SyncItemKey } from "@pi-web/shared";

/** Remote directory (under the remote agent dir) that receives the host's ~/.agents/skills. */
export const AGENTS_SKILLS_REMOTE = "agents-skills";
/** Remote directory holding copies of local paths outside the host agent dir referenced by settings.json. */
export const EXTERNAL_ROOT = "external";
/** Placeholder written instead of OAuth refresh tokens: the server can never rotate them. */
export const MANAGED_REFRESH_PLACEHOLDER = "pi-web-managed";

const DEFINITIONS = new Map<SyncItemKey, SyncItemDefinition>(SYNC_ITEMS.map((item) => [item.key, item]));

export function itemDefinition(key: SyncItemKey): SyncItemDefinition {
	const def = DEFINITIONS.get(key);
	if (!def) throw new Error(`unknown sync item: ${key}`);
	return def;
}

/** Top-level names under the remote agent dir owned by an item. */
export function itemRemoteRoots(key: SyncItemKey): string[] {
	if (key === "agentsSkills") return [AGENTS_SKILLS_REMOTE];
	return [...itemDefinition(key).paths];
}

/** Which item a relative remote path (or host path relative to the agent dir) belongs to. */
export function itemForPath(rel: string): SyncItemKey | undefined {
	const top = rel.split("/")[0];
	if (top === EXTERNAL_ROOT) return "settings";
	if (top === AGENTS_SKILLS_REMOTE) return "agentsSkills";
	for (const item of SYNC_ITEMS) {
		if (item.key !== "agentsSkills" && item.paths.includes(top)) return item.key;
	}
	return undefined;
}

export function enabledItems(config: SyncConfig): SyncItemKey[] {
	return SYNC_ITEM_KEYS.filter((key) => config.items[key] === true);
}

/**
 * Roots passed to sync.manifest: the remote top-level names of the given items, plus
 * "external" whenever settings are synced (so stale external copies get cleaned up).
 */
export function rootsForItems(items: readonly SyncItemKey[]): string[] {
	const roots = new Set<string>();
	for (const key of items) for (const root of itemRemoteRoots(key)) roots.add(root);
	if (items.includes("settings")) roots.add(EXTERNAL_ROOT);
	return [...roots];
}

export function isUnderRoots(rel: string, roots: readonly string[]): boolean {
	return roots.some((root) => rel === root || rel.startsWith(`${root}/`));
}

export function emptyItemRecord<T>(value: T): Record<SyncItemKey, T> {
	return Object.fromEntries(SYNC_ITEM_KEYS.map((key) => [key, value])) as Record<SyncItemKey, T>;
}
