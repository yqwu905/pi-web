/** Checks that produce SyncPlan.warnings (user-visible, Simplified Chinese). */
import { isIP } from "node:net";
import { basename } from "node:path";
import { isPlainObject } from "@pi-web/shared";
import type { NativeKind } from "./hash-cache.js";
import { matchesNoProxy } from "../proxy/no-proxy.js";

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_NAME_LIKE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const OFFLINE_RUNNERS = new Set(["npx", "uvx", "bunx", "pnpx"]);

function envRefs(value: string): string[] {
	const names = new Set<string>();
	for (const match of value.replace(/\$\$/g, "").matchAll(ENV_REF_RE)) names.add(match[1] ?? match[2]);
	return [...names];
}

/** Describes why a credential value may not resolve on the server (never echoes the value itself). */
function keyValueWarning(where: string, value: string): string | undefined {
	if (value.startsWith("!")) return `${where}是 shell 命令（以 ! 开头），会在服务器上执行，服务器上可能没有对应的命令或凭据`;
	const refs = envRefs(value);
	if (refs.length > 0) return `${where}引用了环境变量 ${refs.join("、")}，服务器上需要设置相同的环境变量`;
	if (ENV_NAME_LIKE_RE.test(value)) return `${where}形似环境变量名（${value}），如果它是想引用环境变量，服务器上也需要设置该变量`;
	return undefined;
}

export function authWarnings(auth: Record<string, unknown>): string[] {
	const warnings: string[] = [];
	for (const [provider, credential] of Object.entries(auth)) {
		if (!isPlainObject(credential) || credential.type !== "api_key" || typeof credential.key !== "string") continue;
		const warning = keyValueWarning(`auth.json 中 “${provider}” 的 key `, credential.key);
		if (warning) warnings.push(warning);
	}
	return warnings;
}

function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (isIP(h) === 4) return h.startsWith("127.");
	return h === "::1" || h === "0:0:0:0:0:0:0:1";
}

export function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase();
	const v = isIP(h);
	if (v === 4) {
		const [a, b] = h.split(".").map(Number);
		return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
	}
	if (v === 6) return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
	if (!h.includes(".")) return true;
	return [".local", ".lan", ".internal", ".intranet", ".corp", ".home", ".home.arpa"].some((suffix) => h.endsWith(suffix));
}

function hostOf(url: unknown): string | undefined {
	if (typeof url !== "string" || url.includes("{")) return undefined;
	try {
		return new URL(url).hostname.replace(/^\[|\]$/g, "");
	} catch {
		return undefined;
	}
}

export interface ModelsWarningOptions {
	tunnel: boolean;
	noProxy: readonly string[];
}

export function modelsWarnings(models: Record<string, unknown>, options: ModelsWarningOptions): string[] {
	const warnings: string[] = [];
	const providers = isPlainObject(models.providers) ? models.providers : {};
	for (const [id, provider] of Object.entries(providers)) {
		if (!isPlainObject(provider)) continue;
		const hosts = new Set<string>();
		const providerHost = hostOf(provider.baseUrl);
		if (providerHost) hosts.add(providerHost);
		if (Array.isArray(provider.models)) {
			for (const model of provider.models) {
				const host = isPlainObject(model) ? hostOf(model.baseUrl) : undefined;
				if (host) hosts.add(host);
			}
		}
		for (const host of hosts) {
			if (isLoopbackHost(host)) {
				warnings.push(`models.json 中 provider “${id}” 的 baseUrl 指向本机地址 ${host}，在服务器上会访问服务器自身`);
			} else if (options.tunnel && isPrivateHost(host) && !matchesNoProxy(host, 0, options.noProxy)) {
				warnings.push(
					`models.json 中 provider “${id}” 的 baseUrl 指向内网地址 ${host}，请求会经隧道从 Host 发出；如果服务器可以直接访问它，请把它加入该服务器的 NO_PROXY`,
				);
			}
		}
		if (typeof provider.apiKey === "string") {
			const warning = keyValueWarning(`models.json 中 provider “${id}” 的 apiKey `, provider.apiKey);
			if (warning) warnings.push(warning);
		}
	}
	return warnings;
}

export function mcpWarnings(mcp: Record<string, unknown>): string[] {
	const warnings: string[] = [];
	const servers = isPlainObject(mcp.mcpServers) ? mcp.mcpServers : {};
	for (const [name, server] of Object.entries(servers)) {
		if (!isPlainObject(server) || typeof server.command !== "string" || server.enabled === false) continue;
		const command = basename(server.command.trim());
		if (OFFLINE_RUNNERS.has(command)) {
			warnings.push(`mcp.json 中的 MCP 服务器 “${name}” 使用 ${command} 启动，服务器不能上网时可能无法运行`);
		}
	}
	return warnings;
}

/** Package a native addon belongs to: the path through its last node_modules/<name> (or @scope/name). */
export function nativePackageKey(rel: string): string {
	const parts = rel.split("/");
	let end = -1;
	for (let i = 0; i < parts.length - 1; i++) {
		if (parts[i] !== "node_modules") continue;
		end = parts[i + 1].startsWith("@") && i + 2 < parts.length - 1 ? i + 2 : i + 1;
	}
	if (end >= 0) return parts.slice(0, end + 1).join("/");
	const depth = parts[0] === "git" ? 4 : 2;
	return parts.slice(0, Math.min(depth, parts.length - 1)).join("/") || rel;
}

/** Warn for packages whose native addons include no build loadable on the server. */
export function nativeWarnings(files: Array<{ rel: string; native: NativeKind }>, arch: string | undefined): string[] {
	const byPackage = new Map<string, NativeKind[]>();
	for (const file of files) {
		const key = nativePackageKey(file.rel);
		const list = byPackage.get(key) ?? [];
		list.push(file.native);
		byPackage.set(key, list);
	}
	const wanted: NativeKind | undefined = arch === "x64" ? "linux-x64" : arch === "arm64" ? "linux-arm64" : undefined;
	const warnings: string[] = [];
	for (const [pkg, kinds] of byPackage) {
		const usable = wanted ? kinds.includes(wanted) : kinds.some((kind) => kind.startsWith("linux"));
		if (usable) continue;
		const platforms = [...new Set(kinds)].join("、");
		warnings.push(`插件包 ${pkg} 含原生模块（*.node：${platforms}），没有 linux${wanted ? `-${arch}` : ""} 版本，服务器上可能无法加载`);
	}
	return warnings;
}
