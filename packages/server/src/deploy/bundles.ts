import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, type Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { CacheEntry, HostSettings } from "@pi-web/shared";
import { fetch, type Dispatcher, type Response } from "undici";
import { ApiError, badRequest, errorMessage } from "../core/errors.js";
import { HostProxyDispatcher } from "../core/http.js";
import type { HostPaths, Logger } from "../core/types.js";
import { AGENT_FILES, PI_PACKAGE, compareVersions } from "./scripts.js";

export type NodeArch = "x64" | "arm64";

export interface BundleFile {
	path: string;
	name: string;
	bytes: number;
	sha256: string;
}
export interface NodeBundle extends BundleFile {
	version: string;
	arch: NodeArch;
	/** Top-level directory inside the tarball, e.g. node-v22.20.0-linux-x64 */
	dirName: string;
}
export interface PiBundle extends BundleFile {
	version: string;
}
export interface AgentBundle extends BundleFile {
	version: string;
}

export interface BundleProgress {
	/** Short log line for the deploy log. */
	log?: (line: string) => void;
	/** Download progress of the current file. */
	progress?: (done: number, total: number) => void;
	signal?: AbortSignal;
}

interface NodeIndexEntry {
	version: string;
	files: string[];
}

const MIN_NODE = "22.19.0";
const NODE_NAME_RE = /^node-v(\d+\.\d+\.\d+)-linux-(x64|arm64)\.tar\.(gz|xz)$/;
const PI_NAME_RE = /^pi-(.+)-linux\.tar\.gz$/;
const AGENT_NAME_RE = /^pi-web-agent-(.+)\.tar\.gz$/;
const INDEX_TTL_MS = 10 * 60_000;

export function nodeBaseUrl(settings: Pick<HostSettings, "nodeSource" | "nodeCustomBaseUrl">): string {
	let base: string;
	switch (settings.nodeSource) {
		case "npmmirror":
			base = "https://npmmirror.com/mirrors/node/";
			break;
		case "custom":
			if (!settings.nodeCustomBaseUrl) throw badRequest("未配置自定义 Node 下载地址");
			base = settings.nodeCustomBaseUrl;
			break;
		default:
			base = "https://nodejs.org/dist/";
	}
	return base.endsWith("/") ? base : `${base}/`;
}

/** Picks the newest v22 release ≥ 22.19 that ships a tarball for `arch` (or any supported arch). */
export function pickLatestNode22(index: NodeIndexEntry[], arch?: NodeArch): string | undefined {
	const archs = arch ? [`linux-${arch}`] : ["linux-x64", "linux-arm64"];
	const candidates = index
		.filter((entry) => /^v22\.\d+\.\d+$/.test(entry.version))
		.map((entry) => ({ version: entry.version.slice(1), files: entry.files ?? [] }))
		.filter((entry) => compareVersions(entry.version, MIN_NODE) >= 0)
		.filter((entry) => archs.some((a) => entry.files.includes(a)))
		.sort((a, b) => compareVersions(b.version, a.version));
	return candidates[0]?.version;
}

/** Finds the sha256 for `fileName` in a SHASUMS256.txt body. */
export function parseShasums(text: string, fileName: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
		if (match && match[2].trim() === fileName) return match[1].toLowerCase();
	}
	return undefined;
}

export function prebuildDirPattern(): RegExp {
	return /(^|\/)(prebuilds\/(darwin|win32)-[^/]*|native\/(darwin|win32))$/;
}

async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(file), hash);
	return hash.digest("hex");
}

function run(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			signal: options.signal,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout = (stdout + d.toString("utf8")).slice(-64 * 1024);
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString("utf8")).slice(-64 * 1024);
		});
		const timer = options.timeoutMs
			? setTimeout(() => {
					child.kill("SIGTERM");
				}, options.timeoutMs)
			: undefined;
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			reject(options.signal?.aborted ? new ApiError(499, "CANCELLED", "操作已取消") : err);
		});
		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			if (code === 0) resolve({ stdout, stderr });
			else {
				const err = new Error(`${path.basename(command)} ${args[0] ?? ""} failed (${code ?? signal}): ${stderr.trim().slice(-2000)}`);
				reject(err);
			}
		});
	});
}

/** Locates npm: next to the running node binary first, then PATH. */
export function findNpm(): string {
	const local = path.join(path.dirname(process.execPath), "npm");
	return existsSync(local) ? local : "npm";
}

export interface BundleCacheOptions {
	paths: Pick<HostPaths, "cacheDir" | "tmpDir">;
	getSettings: () => HostSettings;
	log: Logger;
	/** Testing hook: custom dispatcher for downloads. */
	dispatcher?: Dispatcher;
}

/**
 * Offline bundles for deployment, cached under cacheDir:
 *   node/node-v<ver>-linux-<arch>.tar.gz  pi/pi-<ver>-linux.tar.gz  agent/pi-web-agent-<ver>.tar.gz
 */
export class BundleCache {
	private readonly inflight = new Map<string, Promise<unknown>>();
	private index?: { at: number; base: string; entries: NodeIndexEntry[] };
	private proxyDispatcher?: HostProxyDispatcher;

	constructor(private readonly options: BundleCacheOptions) {}

	get cacheDir(): string {
		return this.options.paths.cacheDir;
	}

	private dir(kind: "node" | "pi" | "agent"): string {
		return path.join(this.cacheDir, kind);
	}

	/** settings.upstreamProxy or HTTP(S)_PROXY, honouring NO_PROXY; one agent shared by every download. */
	private dispatcher(): Dispatcher {
		if (this.options.dispatcher) return this.options.dispatcher;
		this.proxyDispatcher ??= new HostProxyDispatcher(() => this.options.getSettings().upstreamProxy);
		return this.proxyDispatcher;
	}

	private once<T>(key: string, task: () => Promise<T>): Promise<T> {
		const existing = this.inflight.get(key) as Promise<T> | undefined;
		if (existing) return existing;
		const promise = task().finally(() => this.inflight.delete(key));
		this.inflight.set(key, promise);
		return promise;
	}

	private async fetchOk(url: string, signal?: AbortSignal): Promise<Response> {
		let response: Response;
		try {
			response = await fetch(url, { dispatcher: this.dispatcher(), signal });
		} catch (err) {
			if (signal?.aborted) throw new ApiError(499, "CANCELLED", "操作已取消");
			const cause = (err as { cause?: unknown }).cause;
			throw new ApiError(502, "DOWNLOAD_FAILED", `下载失败：${url}：${errorMessage(cause ?? err)}`);
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new ApiError(502, "DOWNLOAD_FAILED", `下载失败：${url}（HTTP ${response.status}）`);
		}
		return response;
	}

	// ---- node ----

	/** "latest-22" → newest matching v22 from the index; exact versions are returned normalized. */
	async resolveNodeVersion(spec: string, arch?: NodeArch, signal?: AbortSignal): Promise<string> {
		const value = spec.trim().replace(/^v/, "");
		if (/^\d+\.\d+\.\d+$/.test(value)) return value;
		if (value !== "latest-22") throw badRequest(`无法识别的 Node 版本：${spec}`);
		const base = nodeBaseUrl(this.options.getSettings());
		try {
			const entries = await this.nodeIndex(base, signal);
			const picked = pickLatestNode22(entries, arch);
			if (picked) return picked;
		} catch (err) {
			if (signal?.aborted) throw err;
			this.options.log.warn("node index unavailable; using cached runtimes", { error: errorMessage(err) });
		}
		// Offline: fall back to the newest cached v22 runtime.
		const cached = (await this.listNode())
			.filter((entry) => (!arch || entry.arch === arch) && entry.version.startsWith("22."))
			.sort((a, b) => compareVersions(b.version, a.version));
		if (cached[0]) return cached[0].version;
		throw new ApiError(502, "NODE_INDEX_UNAVAILABLE", `无法获取 Node 版本列表（${base}index.json），且缓存中没有可用的 Node 22`);
	}

	private async nodeIndex(base: string, signal?: AbortSignal): Promise<NodeIndexEntry[]> {
		if (this.index && this.index.base === base && Date.now() - this.index.at < INDEX_TTL_MS) return this.index.entries;
		const cacheFile = path.join(this.dir("node"), "index.json");
		try {
			const response = await this.fetchOk(`${base}index.json`, signal);
			const text = await response.text();
			const entries = JSON.parse(text) as NodeIndexEntry[];
			this.index = { at: Date.now(), base, entries };
			await mkdir(this.dir("node"), { recursive: true });
			await writeFile(cacheFile, JSON.stringify({ base, entries }));
			return entries;
		} catch (err) {
			const cached = await readFile(cacheFile, "utf8")
				.then((t) => JSON.parse(t) as { base: string; entries: NodeIndexEntry[] })
				.catch(() => null);
			if (cached && cached.base === base) return cached.entries;
			throw err;
		}
	}

	nodeFileName(version: string, arch: NodeArch): string {
		return `node-v${version}-linux-${arch}.tar.gz`;
	}

	nodeCachePath(version: string, arch: NodeArch): string {
		return path.join(this.dir("node"), this.nodeFileName(version, arch));
	}

	async ensureNode(version: string, arch: NodeArch, progress: BundleProgress = {}): Promise<NodeBundle> {
		const file = this.nodeCachePath(version, arch);
		if (existsSync(file)) return this.describeNode(file, version, arch);
		return this.once(`node:${version}:${arch}`, async () => {
			if (existsSync(file)) return this.describeNode(file, version, arch);
			await this.downloadNode(version, arch, progress);
			return this.describeNode(file, version, arch);
		});
	}

	private async describeNode(file: string, version: string, arch: NodeArch): Promise<NodeBundle> {
		const info = await stat(file);
		return {
			path: file,
			name: path.basename(file),
			bytes: info.size,
			sha256: await this.cachedSha256(file, info.size, info.mtimeMs),
			version,
			arch,
			dirName: `node-v${version}-linux-${arch}`,
		};
	}

	private async downloadNode(version: string, arch: NodeArch, progress: BundleProgress): Promise<void> {
		const base = nodeBaseUrl(this.options.getSettings());
		const xzName = `node-v${version}-linux-${arch}.tar.xz`;
		const url = `${base}v${version}/${xzName}`;
		progress.log?.(`下载 Node.js ${version}（${arch}）：${url}`);
		const sums = await (await this.fetchOk(`${base}v${version}/SHASUMS256.txt`, progress.signal)).text();
		const expected = parseShasums(sums, xzName);
		if (!expected) throw new ApiError(502, "CHECKSUM_MISSING", `SHASUMS256.txt 中没有 ${xzName}`);
		await mkdir(this.options.paths.tmpDir, { recursive: true });
		const tmpXz = path.join(this.options.paths.tmpDir, `${randomUUID()}-${xzName}`);
		try {
			const response = await this.fetchOk(url, progress.signal);
			const total = Number(response.headers.get("content-length") ?? 0);
			const hash = createHash("sha256");
			let done = 0;
			let lastReport = 0;
			const meter = new Transform({
				transform(chunk: Buffer, _enc, callback) {
					hash.update(chunk);
					done += chunk.length;
					const now = Date.now();
					if (now - lastReport > 200 || done === total) {
						lastReport = now;
						progress.progress?.(done, total);
					}
					callback(null, chunk);
				},
			});
			if (!response.body) throw new ApiError(502, "DOWNLOAD_FAILED", `下载失败：${url}（空响应）`);
			await pipeline(
				Readable.fromWeb(response.body as WebReadableStream),
				meter,
				createWriteStream(tmpXz),
				{ signal: progress.signal },
			);
			progress.progress?.(done, total || done);
			const actual = hash.digest("hex");
			if (actual !== expected) {
				throw new ApiError(502, "CHECKSUM_MISMATCH", `Node.js 安装包校验失败（${xzName}）：期望 ${expected}，实际 ${actual}`);
			}
			progress.log?.("校验通过，转换为 tar.gz");
			await this.repackNode(tmpXz, "xz", version, arch);
		} catch (err) {
			if (progress.signal?.aborted) throw new ApiError(499, "CANCELLED", "操作已取消");
			throw err;
		} finally {
			await rm(tmpXz, { force: true });
		}
	}

	/** Extracts a node tarball and re-packs it as gzip with the canonical top-level directory. */
	private async repackNode(source: string, compression: "xz" | "gz", version: string, arch: NodeArch): Promise<void> {
		const dirName = `node-v${version}-linux-${arch}`;
		await mkdir(this.options.paths.tmpDir, { recursive: true });
		const work = await mkdtemp(path.join(this.options.paths.tmpDir, "node-"));
		try {
			await run("tar", [compression === "xz" ? "-xJf" : "-xzf", source, "-C", work], { timeoutMs: 10 * 60_000 });
			const entries = (await readdir(work)).filter((name) => !name.startsWith("."));
			const top = entries.length === 1 ? entries[0] : entries.find((name) => name === dirName);
			if (!top || !existsSync(path.join(work, top, "bin", "node"))) {
				throw new ApiError(400, "NODE_TARBALL_INVALID", "Node.js 安装包结构不正确（缺少 bin/node）");
			}
			if (top !== dirName) await rename(path.join(work, top), path.join(work, dirName));
			await mkdir(this.dir("node"), { recursive: true });
			const tmpOut = path.join(this.options.paths.tmpDir, `${randomUUID()}.tar.gz`);
			await run("tar", ["-czf", tmpOut, "-C", work, dirName], { timeoutMs: 10 * 60_000 });
			await rename(tmpOut, this.nodeCachePath(version, arch));
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	}

	async importNode(fileName: string, data: Readable): Promise<CacheEntry> {
		const base = path.basename(fileName);
		const match = NODE_NAME_RE.exec(base);
		if (!match) throw badRequest("文件名必须形如 node-v22.20.0-linux-x64.tar.xz 或 .tar.gz");
		const [, version, arch, ext] = match;
		await mkdir(this.options.paths.tmpDir, { recursive: true });
		const tmp = path.join(this.options.paths.tmpDir, `${randomUUID()}-${base}`);
		try {
			await pipeline(data, createWriteStream(tmp));
			await this.repackNode(tmp, ext === "xz" ? "xz" : "gz", version, arch as NodeArch);
		} finally {
			await rm(tmp, { force: true });
		}
		const entry = (await this.list()).find((e) => e.name === this.nodeFileName(version, arch as NodeArch));
		if (!entry) throw new ApiError(500, "CACHE_ERROR", "导入后未找到缓存文件");
		return entry;
	}

	// ---- pi ----

	piFileName(version: string): string {
		return `pi-${version}-linux.tar.gz`;
	}

	piCachePath(version: string): string {
		return path.join(this.dir("pi"), this.piFileName(version));
	}

	async ensurePi(version: string, progress: BundleProgress = {}): Promise<PiBundle> {
		if (!/^[\w.+-]+$/.test(version)) throw badRequest(`无效的 pi 版本：${version}`);
		const exact = /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version);
		if (exact && existsSync(this.piCachePath(version))) return this.describePi(this.piCachePath(version), version);
		return this.once(`pi:${version}`, async () => {
			if (exact && existsSync(this.piCachePath(version))) return this.describePi(this.piCachePath(version), version);
			const installed = await this.buildPi(version, progress);
			return this.describePi(this.piCachePath(installed), installed);
		});
	}

	private async describePi(file: string, version: string): Promise<PiBundle> {
		const info = await stat(file);
		return {
			path: file,
			name: path.basename(file),
			bytes: info.size,
			sha256: await this.cachedSha256(file, info.size, info.mtimeMs),
			version,
		};
	}

	/** npm-installs pi into cache/tmp/pi-<ver>, prunes foreign prebuilds and packs it. Returns the installed version. */
	private async buildPi(version: string, progress: BundleProgress): Promise<string> {
		const settings = this.options.getSettings();
		const work = path.join(this.options.paths.tmpDir, `pi-${version.replace(/[^\w.-]/g, "_")}`);
		await rm(work, { recursive: true, force: true });
		await mkdir(work, { recursive: true });
		try {
			await writeFile(path.join(work, "package.json"), `${JSON.stringify({ name: "pi-web-pi-bundle", version: "0.0.0", private: true }, null, 2)}\n`);
			const args = [
				"install",
				"--prefix",
				".",
				"--no-audit",
				"--no-fund",
				"--omit=dev",
				"--no-update-notifier",
				`${PI_PACKAGE}@${version}`,
			];
			if (settings.npmRegistry) args.push("--registry", settings.npmRegistry);
			const env: NodeJS.ProcessEnv = { ...process.env };
			if (settings.upstreamProxy) {
				env.npm_config_proxy = settings.upstreamProxy;
				env.npm_config_https_proxy = settings.upstreamProxy;
			}
			progress.log?.(`npm install ${PI_PACKAGE}@${version}`);
			await run(findNpm(), args, { cwd: work, env, signal: progress.signal, timeoutMs: 15 * 60_000 });
			const pkgFile = path.join(work, "node_modules", PI_PACKAGE, "package.json");
			const installed = (JSON.parse(await readFile(pkgFile, "utf8")) as { version: string }).version;
			if (settings.prunePrebuilds) {
				const removed = await pruneForeignPrebuilds(path.join(work, "node_modules"));
				if (removed > 0) progress.log?.(`已删除 ${removed} 个非 Linux 预编译目录`);
			}
			await mkdir(this.dir("pi"), { recursive: true });
			const tmpOut = path.join(this.options.paths.tmpDir, `${randomUUID()}.tar.gz`);
			await run("tar", ["-czf", tmpOut, "-C", work, "node_modules", "package.json"], { timeoutMs: 10 * 60_000 });
			await rename(tmpOut, this.piCachePath(installed));
			progress.log?.(`pi ${installed} 打包完成`);
			return installed;
		} catch (err) {
			if (progress.signal?.aborted) throw new ApiError(499, "CANCELLED", "操作已取消");
			if (err instanceof ApiError) throw err;
			throw new ApiError(502, "PI_BUNDLE_FAILED", `构建 pi 离线包失败：${errorMessage(err)}`);
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	}

	// ---- agent ----

	/** Packs the built agent (agentDistDir) into cache/agent/pi-web-agent-<ver>.tar.gz (rebuilt on every call). */
	async ensureAgent(agentDistDir: string): Promise<AgentBundle> {
		for (const file of AGENT_FILES) {
			if (!existsSync(path.join(agentDistDir, file))) {
				throw new ApiError(500, "AGENT_BUNDLE_MISSING", `未找到 Remote Agent 构建产物 ${file}（${agentDistDir}），请先构建 @pi-web/agent`);
			}
		}
		const version = (await readFile(path.join(agentDistDir, "VERSION"), "utf8")).trim();
		return this.once(`agent:${version}`, async () => {
			await mkdir(this.dir("agent"), { recursive: true });
			await mkdir(this.options.paths.tmpDir, { recursive: true });
			const file = path.join(this.dir("agent"), `pi-web-agent-${version}.tar.gz`);
			const tmpOut = path.join(this.options.paths.tmpDir, `${randomUUID()}.tar.gz`);
			await run("tar", ["-czf", tmpOut, "-C", agentDistDir, ...AGENT_FILES]);
			await rename(tmpOut, file);
			const info = await stat(file);
			return { path: file, name: path.basename(file), bytes: info.size, sha256: await sha256File(file), version };
		});
	}

	// ---- listing ----

	private shaCache = new Map<string, { key: string; sha: string }>();

	private async cachedSha256(file: string, size: number, mtimeMs: number): Promise<string> {
		const key = `${size}:${mtimeMs}`;
		const hit = this.shaCache.get(file);
		if (hit?.key === key) return hit.sha;
		const sha = await sha256File(file);
		this.shaCache.set(file, { key, sha });
		return sha;
	}

	private async listNode(): Promise<CacheEntry[]> {
		return (await this.list()).filter((entry) => entry.kind === "node");
	}

	async list(): Promise<CacheEntry[]> {
		const entries: CacheEntry[] = [];
		const scan = async (kind: CacheEntry["kind"], re: RegExp, parse: (m: RegExpExecArray) => Pick<CacheEntry, "version" | "arch">) => {
			let names: string[];
			try {
				names = await readdir(this.dir(kind));
			} catch {
				return;
			}
			for (const name of names) {
				const match = re.exec(name);
				if (!match || !name.endsWith(".tar.gz")) continue;
				const info = await stat(path.join(this.dir(kind), name)).catch(() => null);
				if (!info?.isFile()) continue;
				entries.push({ name, kind, ...parse(match), bytes: info.size, createdAt: info.mtimeMs, usedBy: [] });
			}
		};
		await scan("node", NODE_NAME_RE, (m) => ({ version: m[1], arch: m[2] }));
		await scan("pi", PI_NAME_RE, (m) => ({ version: m[1] }));
		await scan("agent", AGENT_NAME_RE, (m) => ({ version: m[1] }));
		return entries.sort((a, b) => a.kind.localeCompare(b.kind) || compareVersions(b.version, a.version) || a.name.localeCompare(b.name));
	}

	async delete(name: string): Promise<void> {
		const base = path.basename(name);
		if (base !== name || !base.endsWith(".tar.gz")) throw badRequest("无效的缓存文件名");
		const kind = NODE_NAME_RE.test(base) ? "node" : PI_NAME_RE.test(base) ? "pi" : AGENT_NAME_RE.test(base) ? "agent" : null;
		if (!kind) throw badRequest("无效的缓存文件名");
		const file = path.join(this.dir(kind), base);
		if (!existsSync(file)) throw new ApiError(404, "NOT_FOUND", `缓存文件不存在：${base}`);
		await rm(file, { force: true });
		this.shaCache.delete(file);
	}
}

/** Removes prebuilds/(darwin|win32)-* and native/(darwin|win32) directories below `root`. Returns the count. */
export async function pruneForeignPrebuilds(root: string): Promise<number> {
	const pattern = prebuildDirPattern();
	let removed = 0;
	const walk = async (dir: string, rel: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			const childAbs = path.join(dir, entry.name);
			if (pattern.test(childRel)) {
				await rm(childAbs, { recursive: true, force: true });
				removed++;
				continue;
			}
			await walk(childAbs, childRel);
		}
	};
	await walk(root, "");
	return removed;
}
