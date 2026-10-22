import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostSettings } from "@pi-web/shared";
import type { HostPaths } from "./types.js";

export interface HostPathsOptions {
	/** --data-dir; falls back to $PI_WEB_DATA_DIR, then ~/.pi-web-host. */
	dataDir?: string;
	/**
	 * Host settings (only hostAgentDir is used). Pass a getter to make `hostAgentDir`
	 * follow later settings changes.
	 */
	settings?: Partial<HostSettings> | (() => Partial<HostSettings> | undefined);
	/** Overrides for tests / unusual layouts. */
	agentDistDir?: string;
	webDistDir?: string | null;
	env?: NodeJS.ProcessEnv;
}

/** Expands a leading "~" / "~/" to the local home directory. */
export function expandHome(p: string, home: string = homedir()): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return path.join(home, p.slice(2));
	return p;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.PI_WEB_DATA_DIR?.trim();
	return path.resolve(expandHome(fromEnv || "~/.pi-web-host"));
}

export function resolveHostAgentDir(settings: Partial<HostSettings> | undefined, env: NodeJS.ProcessEnv = process.env): string {
	const configured = settings?.hostAgentDir?.trim() || env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent";
	return path.resolve(expandHome(configured));
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function packageDir(name: string): string | null {
	try {
		const require = createRequire(import.meta.url);
		return path.dirname(require.resolve(`${name}/package.json`));
	} catch {
		return null;
	}
}

/**
 * Directory holding the built remote agent. When the server is bundled
 * (dist/cli.mjs) the agent lives next to it in dist/agent; in development it is
 * packages/agent/dist. Detection is by the presence of VERSION.
 */
export function resolveAgentDistDir(): string {
	const candidates = [path.join(moduleDir, "agent")];
	const pkg = packageDir("@pi-web/agent");
	if (pkg) candidates.push(path.join(pkg, "dist"));
	const devDir = path.resolve(moduleDir, "../../../agent/dist");
	candidates.push(devDir);
	for (const dir of candidates) {
		if (existsSync(path.join(dir, "VERSION"))) return dir;
	}
	return pkg ? path.join(pkg, "dist") : devDir;
}

/** Built SPA directory (bundled: dist/web, dev: packages/web/dist), or null when not built. */
export function resolveWebDistDir(): string | null {
	const candidates = [path.join(moduleDir, "web")];
	const pkg = packageDir("@pi-web/web");
	if (pkg) candidates.push(path.join(pkg, "dist"));
	candidates.push(path.resolve(moduleDir, "../../../web/dist"));
	for (const dir of candidates) {
		if (existsSync(path.join(dir, "index.html"))) return dir;
	}
	return null;
}

export function createHostPaths(options: HostPathsOptions = {}): HostPaths {
	const env = options.env ?? process.env;
	const dataDir = options.dataDir ? path.resolve(expandHome(options.dataDir)) : defaultDataDir(env);
	const cacheDir = path.join(dataDir, "cache");
	const settings = options.settings;
	const agentDistDir = options.agentDistDir ?? resolveAgentDistDir();
	const webDistDir = options.webDistDir !== undefined ? options.webDistDir : resolveWebDistDir();
	return {
		dataDir,
		cacheDir,
		tmpDir: path.join(cacheDir, "tmp"),
		logsDir: path.join(dataDir, "logs"),
		get hostAgentDir(): string {
			return resolveHostAgentDir(typeof settings === "function" ? settings() : settings, env);
		},
		agentDistDir,
		webDistDir,
	};
}

/** Creates the data directory tree with owner-only permissions. */
export function ensureHostDirs(paths: HostPaths): void {
	const dirs = [
		paths.dataDir,
		paths.cacheDir,
		paths.tmpDir,
		paths.logsDir,
		path.join(paths.cacheDir, "node"),
		path.join(paths.cacheDir, "pi"),
		path.join(paths.cacheDir, "agent"),
	];
	for (const dir of dirs) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	try {
		chmodSync(paths.dataDir, 0o700);
	} catch {
		// best effort (e.g. data dir owned by another user)
	}
}
