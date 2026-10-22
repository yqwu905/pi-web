/** Content transforms applied to host files before they are synced to a server. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deepMerge, isPlainObject, SYNC_EXCLUDES, type ServerConfig } from "@pi-web/shared";
import { AGENTS_SKILLS_REMOTE, EXTERNAL_ROOT, itemForPath, MANAGED_REFRESH_PLACEHOLDER } from "./items.js";
import { isWithin } from "./walk.js";

/** Removes proxy variables from every bash tool command when only LLM traffic may use the tunnel. */
export const UNSET_PROXY_PREFIX = "unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy";

/** Settings that only make sense on the host. */
const HOST_ONLY_SETTINGS = ["npmCommand", "shellPath", "httpProxy"] as const;
/** Settings arrays whose local paths are rewritten (packages additionally accept {source} objects). */
const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
const REMOTE_SOURCE_PREFIXES = ["npm:", "git:", "github:", "http:", "https:", "ssh:", "builtin:"];

export interface ExternalRef {
	/** Absolute host path (file or directory). */
	abs: string;
	/** Relative remote path: external/<sha1(abs)[0,12]>-<basename>. */
	remote: string;
}

export interface SettingsTransformOptions {
	hostAgentDir: string;
	homeDir: string;
	server: Pick<ServerConfig, "proxy" | "sync">;
	/** Host ~/.agents/skills when the agentsSkills item is enabled and the directory exists. */
	agentsSkillsDir?: string;
	exists?: (abs: string) => boolean;
}

export interface SettingsTransformResult {
	settings: Record<string, unknown>;
	externals: ExternalRef[];
	warnings: string[];
}

export function externalRemotePath(abs: string): string {
	const hash = createHash("sha1").update(abs).digest("hex").slice(0, 12);
	return `${EXTERNAL_ROOT}/${hash}-${basename(abs) || "root"}`;
}

/** True for entries pi treats as local paths (not npm:/git:/URLs/builtin:). */
export function isLocalSource(value: string): boolean {
	const trimmed = value.trim();
	return !REMOTE_SOURCE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function hasGlob(value: string): boolean {
	return /[*?[\]{}]/.test(value);
}

function expandPath(value: string, baseDir: string, homeDir: string): string {
	let p = value.trim();
	if (p.startsWith("file://")) {
		try {
			p = fileURLToPath(p);
		} catch {
			// keep as-is
		}
	} else if (p.startsWith("file:")) {
		p = p.slice("file:".length);
	}
	if (p === "~") return homeDir;
	if (p.startsWith("~/")) return join(homeDir, p.slice(2));
	return resolve(baseDir, p);
}

class PathRewriter {
	readonly externals = new Map<string, ExternalRef>();
	readonly warnings: string[] = [];
	private readonly exists: (abs: string) => boolean;

	constructor(private readonly options: SettingsTransformOptions) {
		this.exists = options.exists ?? existsSync;
	}

	/** Rewrites one local path (without +/- prefix). Returns the replacement. */
	rewritePath(value: string): string {
		if (!isLocalSource(value) || value.trim() === "") return value;
		const { hostAgentDir, homeDir, agentsSkillsDir } = this.options;
		const abs = expandPath(value, hostAgentDir, homeDir);
		if (isWithin(hostAgentDir, abs)) {
			const rel = relative(hostAgentDir, abs).split(sep).join("/");
			const coverage = this.coverage(rel);
			if (coverage === "synced") {
				if (!isAbsolute(value.trim()) && !value.trim().startsWith("~") && !value.trim().startsWith("file:")) return value;
				return rel || ".";
			}
			if (coverage !== "external") {
				this.warnings.push(
					coverage === "disabled"
						? `settings.json 引用的 ${rel} 所属的同步项未启用，服务器上需要自行提供该路径`
						: `settings.json 引用的 ${rel} 不会被同步（被同步规则排除），服务器上需要自行提供该路径`,
				);
				return value;
			}
			// Inside the agent dir but outside every sync item (e.g. "./local/my-pkg"): copy it like a path outside.
		}
		if (agentsSkillsDir && abs === agentsSkillsDir) return AGENTS_SKILLS_REMOTE;
		if (hasGlob(value)) {
			this.warnings.push(`settings.json 中的通配路径 ${value} 指向 agent 目录之外，无法同步到服务器`);
			return value;
		}
		if (!this.exists(abs)) {
			this.warnings.push(`settings.json 引用的本地路径不存在，未同步：${abs}`);
			return value;
		}
		let ref = this.externals.get(abs);
		if (!ref) {
			ref = { abs, remote: externalRemotePath(abs) };
			this.externals.set(abs, ref);
		}
		return ref.remote;
	}

	/** Whether a path inside the host agent dir reaches the server through an enabled sync item. */
	private coverage(rel: string): "synced" | "disabled" | "excluded" | "external" {
		if (rel === "" || rel === ".") return "synced";
		const top = rel.split("/")[0];
		if (SYNC_EXCLUDES.some((pattern) => !pattern.startsWith("*.") && pattern === top)) return "excluded";
		const item = itemForPath(rel);
		if (!item || top === EXTERNAL_ROOT || top === AGENTS_SKILLS_REMOTE) return "external";
		return this.options.server.sync.items?.[item] === true ? "synced" : "disabled";
	}

	/** Resource array entries may carry "+"/"-" (exact include/exclude) or "!" (glob exclusion) prefixes. */
	rewriteResourceEntry(entry: unknown): unknown {
		if (typeof entry !== "string") return entry;
		if (entry.startsWith("!")) return entry;
		if (entry.startsWith("+") || entry.startsWith("-")) return entry[0] + this.rewritePath(entry.slice(1));
		return this.rewritePath(entry);
	}

	rewritePackage(entry: unknown): unknown {
		if (typeof entry === "string") return this.rewritePath(entry);
		if (isPlainObject(entry) && typeof entry.source === "string") return { ...entry, source: this.rewritePath(entry.source) };
		return entry;
	}
}

/**
 * settings.json transform (in this order): rewrite local resource paths, add agents-skills,
 * drop host-only settings, inject proxy settings, deep-merge the server override.
 */
export function transformSettings(input: Record<string, unknown>, options: SettingsTransformOptions): SettingsTransformResult {
	const out: Record<string, unknown> = { ...input };
	const rewriter = new PathRewriter(options);

	if (Array.isArray(out.packages)) out.packages = out.packages.map((entry) => rewriter.rewritePackage(entry));
	for (const key of RESOURCE_KEYS) {
		const value = out[key];
		if (Array.isArray(value)) out[key] = value.map((entry) => rewriter.rewriteResourceEntry(entry));
	}
	if (options.agentsSkillsDir) {
		const skills = Array.isArray(out.skills) ? [...out.skills] : [];
		if (!skills.includes(AGENTS_SKILLS_REMOTE)) skills.push(AGENTS_SKILLS_REMOTE);
		out.skills = skills;
	}

	for (const key of HOST_ONLY_SETTINGS) delete out[key];
	if (typeof out.sessionDir === "string" && (isAbsolute(out.sessionDir) || out.sessionDir.startsWith("~"))) {
		delete out.sessionDir;
	}

	const proxy = options.server.proxy;
	if (proxy.mode === "tunnel") {
		out.transport = "sse";
		if (proxy.scope === "llm") out.shellCommandPrefix = mergeShellPrefix(out.shellCommandPrefix);
	}

	const override = options.server.sync.settingsOverride;
	const settings = isPlainObject(override) && Object.keys(override).length > 0 ? deepMerge(out, override) : out;
	return { settings, externals: [...rewriter.externals.values()], warnings: rewriter.warnings };
}

export function mergeShellPrefix(existing: unknown): string {
	if (typeof existing !== "string" || existing.trim() === "") return UNSET_PROXY_PREFIX;
	if (existing.split("\n").some((line) => line.trim() === UNSET_PROXY_PREFIX)) return existing;
	return `${UNSET_PROXY_PREFIX}\n${existing}`;
}

/** auth.json transform: OAuth entries keep every field except the refresh token. */
export function transformAuth(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [provider, credential] of Object.entries(input)) {
		out[provider] =
			isPlainObject(credential) && credential.type === "oauth"
				? { ...credential, refresh: MANAGED_REFRESH_PLACEHOLDER }
				: credential;
	}
	return out;
}

/** Serialized form of generated JSON files. */
export function toJsonFile(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
