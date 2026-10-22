import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SshConfigHost } from "@pi-web/shared";

interface Block {
	positive: string[];
	negative: string[];
	/** Match blocks are never applied (their criteria cannot be evaluated statically). */
	never: boolean;
	options: Array<[string, string[]]>;
}

/** Splits an ssh_config argument string, honouring double/single quotes. */
export function tokenizeArgs(text: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	let has = false;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (has || current) out.push(current);
			current = "";
			has = false;
			continue;
		}
		current += ch;
		has = true;
	}
	if (has || current) out.push(current);
	return out;
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function isWildcard(pattern: string): boolean {
	return /[*?]/.test(pattern);
}

function blockMatches(block: Block, alias: string): boolean {
	if (block.never) return false;
	if (block.negative.some((p) => globToRegExp(p).test(alias))) return false;
	return block.positive.some((p) => globToRegExp(p).test(alias));
}

interface ParseContext {
	baseDir: string;
	home: string;
	depth: number;
	readFile: (file: string) => string | null;
	listDir: (dir: string) => string[];
}

function expandTilde(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return path.join(home, p.slice(2));
	return p;
}

function resolveInclude(pattern: string, ctx: ParseContext): string[] {
	let p = expandTilde(pattern, ctx.home);
	if (!path.isAbsolute(p)) p = path.join(ctx.baseDir, p);
	const dir = path.dirname(p);
	const base = path.basename(p);
	if (!isWildcard(base)) return [p];
	const re = globToRegExp(base);
	return ctx
		.listDir(dir)
		.filter((name) => re.test(name))
		.sort()
		.map((name) => path.join(dir, name));
}

function collectBlocks(text: string, ctx: ParseContext, blocks: Block[]): void {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
		if (!match) continue;
		const keyword = match[1].toLowerCase();
		const args = tokenizeArgs(match[2]);
		if (keyword === "host") {
			const positive: string[] = [];
			const negative: string[] = [];
			for (const pattern of args) {
				if (pattern.startsWith("!")) negative.push(pattern.slice(1));
				else if (pattern) positive.push(pattern);
			}
			blocks.push({ positive, negative, never: false, options: [] });
			continue;
		}
		if (keyword === "match") {
			const all = args.length === 1 && args[0].toLowerCase() === "all";
			blocks.push({ positive: ["*"], negative: [], never: !all, options: [] });
			continue;
		}
		if (keyword === "include") {
			if (ctx.depth >= 16) continue;
			for (const pattern of args) {
				for (const file of resolveInclude(pattern, ctx)) {
					const content = ctx.readFile(file);
					if (content !== null) collectBlocks(content, { ...ctx, depth: ctx.depth + 1 }, blocks);
				}
			}
			continue;
		}
		blocks[blocks.length - 1].options.push([keyword, args]);
	}
}

function firstValue(blocks: Block[], alias: string, keyword: string): string | undefined {
	for (const block of blocks) {
		if (!blockMatches(block, alias)) continue;
		for (const [key, args] of block.options) {
			if (key === keyword && args.length > 0) return args.join(" ");
		}
	}
	return undefined;
}

export interface ParseSshConfigOptions {
	/** Directory relative Include paths resolve against (default ~/.ssh). */
	baseDir?: string;
	home?: string;
	readFile?: (file: string) => string | null;
	listDir?: (dir: string) => string[];
}

/**
 * Parses an OpenSSH client config into importable hosts. Every concrete alias of a
 * `Host` line becomes one entry (wildcard and negated patterns are skipped); options
 * are resolved like ssh does: first obtained value wins, `Host *` blocks act as defaults.
 */
export function parseSshConfig(text: string, options: ParseSshConfigOptions = {}): SshConfigHost[] {
	const home = options.home ?? homedir();
	const ctx: ParseContext = {
		baseDir: options.baseDir ?? path.join(home, ".ssh"),
		home,
		depth: 0,
		readFile:
			options.readFile ??
			((file) => {
				try {
					return readFileSync(file, "utf8");
				} catch {
					return null;
				}
			}),
		listDir:
			options.listDir ??
			((dir) => {
				try {
					return readdirSync(dir);
				} catch {
					return [];
				}
			}),
	};
	// Options before the first Host line apply to every host.
	const blocks: Block[] = [{ positive: ["*"], negative: [], never: false, options: [] }];
	collectBlocks(text, ctx, blocks);

	const aliases: string[] = [];
	for (const block of blocks) {
		if (block.never) continue;
		for (const pattern of block.positive) {
			if (!isWildcard(pattern) && !aliases.includes(pattern)) aliases.push(pattern);
		}
	}

	return aliases.map((alias) => {
		const host: SshConfigHost = { alias };
		const hostName = firstValue(blocks, alias, "hostname");
		if (hostName) host.hostName = hostName.replace(/%h/g, alias).replace(/%%/g, "%");
		const user = firstValue(blocks, alias, "user");
		if (user) host.user = user;
		const port = Number(firstValue(blocks, alias, "port"));
		if (Number.isInteger(port) && port > 0 && port <= 65535) host.port = port;
		const identityFile = firstValue(blocks, alias, "identityfile");
		if (identityFile && identityFile.toLowerCase() !== "none") host.identityFile = identityFile;
		const proxyJump = firstValue(blocks, alias, "proxyjump");
		if (proxyJump && proxyJump.toLowerCase() !== "none") host.proxyJump = proxyJump;
		return host;
	});
}

/** Reads and parses ~/.ssh/config (or `file`); a missing file yields []. */
export function readSshConfig(file?: string, options: ParseSshConfigOptions = {}): SshConfigHost[] {
	const home = options.home ?? homedir();
	const configFile = file ?? path.join(home, ".ssh", "config");
	if (!existsSync(configFile)) return [];
	let text: string;
	try {
		text = readFileSync(configFile, "utf8");
	} catch {
		return [];
	}
	return parseSshConfig(text, { ...options, home, baseDir: options.baseDir ?? path.dirname(configFile) });
}

/** Parses one ProxyJump hop: "[user@]host[:port]" (IPv6 in brackets allowed). */
export function parseJumpSpec(spec: string): { user?: string; host: string; port?: number } {
	let rest = spec.trim().replace(/^ssh:\/\//, "");
	let user: string | undefined;
	const at = rest.lastIndexOf("@");
	if (at >= 0) {
		user = rest.slice(0, at);
		rest = rest.slice(at + 1);
	}
	let host = rest;
	let port: number | undefined;
	const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
	if (bracket) {
		host = bracket[1];
		if (bracket[2]) port = Number(bracket[2]);
	} else {
		const colon = rest.lastIndexOf(":");
		if (colon > 0 && rest.indexOf(":") === colon) {
			host = rest.slice(0, colon);
			port = Number(rest.slice(colon + 1)) || undefined;
		}
	}
	return { ...(user ? { user } : {}), host, ...(port ? { port } : {}) };
}
