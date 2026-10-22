import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_HOST_SETTINGS, type HostSettings } from "@pi-web/shared";
import { Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNullLogger } from "../../src/core/log.js";
import { BundleCache, nodeBaseUrl, parseShasums, pickLatestNode22, pruneForeignPrebuilds } from "../../src/deploy/bundles.js";

let dir: string;
let server: http.Server;
let baseUrl: string;
let requests: string[] = [];
let tarXz: Buffer;
let corrupt = false;

const VERSION = "22.99.1";

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-web-bundles-"));
	const src = path.join(dir, "src");
	const top = `node-v${VERSION}-linux-x64`;
	await mkdir(path.join(src, top, "bin"), { recursive: true });
	await writeFile(path.join(src, top, "bin", "node"), "#!/bin/sh\necho v22.99.1\n");
	await chmod(path.join(src, top, "bin", "node"), 0o755);
	execFileSync("tar", ["-cJf", path.join(dir, `${top}.tar.xz`), "-C", src, top]);
	tarXz = readFileSync(path.join(dir, `${top}.tar.xz`));
	const sha = createHash("sha256").update(tarXz).digest("hex");
	const index = [
		{ version: "v24.1.0", files: ["linux-x64"] },
		{ version: `v${VERSION}`, files: ["linux-x64", "linux-arm64"] },
		{ version: "v22.18.0", files: ["linux-x64"] },
	];
	server = http.createServer((req, res) => {
		requests.push(req.url ?? "");
		if (req.url === "/dist/index.json") {
			res.end(JSON.stringify(index));
		} else if (req.url === `/dist/v${VERSION}/SHASUMS256.txt`) {
			res.end(`${"a".repeat(64)}  node-v${VERSION}-darwin-x64.tar.gz\n${sha}  ${top}.tar.xz\n`);
		} else if (req.url === `/dist/v${VERSION}/${top}.tar.xz`) {
			const body = corrupt ? Buffer.concat([tarXz, Buffer.from("x")]) : tarXz;
			res.setHeader("content-length", body.length);
			res.end(body);
		} else {
			res.statusCode = 404;
			res.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dist`;
});

afterAll(async () => {
	server.close();
	await rm(dir, { recursive: true, force: true });
});

function cache(name: string, settings: Partial<HostSettings> = {}) {
	const cacheDir = path.join(dir, name);
	return new BundleCache({
		paths: { cacheDir, tmpDir: path.join(cacheDir, "tmp") },
		getSettings: () => ({ ...DEFAULT_HOST_SETTINGS, nodeSource: "custom", nodeCustomBaseUrl: baseUrl, ...settings }),
		log: createNullLogger(),
		dispatcher: new Agent(),
	});
}

describe("helpers", () => {
	it("picks the newest node 22 ≥ 22.19 for the arch", () => {
		const index = [
			{ version: "v23.0.0", files: ["linux-x64"] },
			{ version: "v22.21.0", files: ["linux-arm64"] },
			{ version: "v22.20.0", files: ["linux-x64", "linux-arm64"] },
			{ version: "v22.18.0", files: ["linux-x64"] },
		];
		expect(pickLatestNode22(index, "x64")).toBe("22.20.0");
		expect(pickLatestNode22(index, "arm64")).toBe("22.21.0");
		expect(pickLatestNode22(index)).toBe("22.21.0");
		expect(pickLatestNode22([{ version: "v22.18.0", files: ["linux-x64"] }], "x64")).toBeUndefined();
	});

	it("parses SHASUMS256", () => {
		const text = `${"b".repeat(64)}  node-v1-linux-x64.tar.xz\n${"c".repeat(64)} *other.tar.gz\n`;
		expect(parseShasums(text, "node-v1-linux-x64.tar.xz")).toBe("b".repeat(64));
		expect(parseShasums(text, "other.tar.gz")).toBe("c".repeat(64));
		expect(parseShasums(text, "missing")).toBeUndefined();
	});

	it("builds base urls", () => {
		expect(nodeBaseUrl({ nodeSource: "official" })).toBe("https://nodejs.org/dist/");
		expect(nodeBaseUrl({ nodeSource: "npmmirror" })).toBe("https://npmmirror.com/mirrors/node/");
		expect(nodeBaseUrl({ nodeSource: "custom", nodeCustomBaseUrl: "http://x/y" })).toBe("http://x/y/");
	});

	it("prunes foreign prebuilds only", async () => {
		const root = path.join(dir, "prune", "node_modules");
		for (const p of [
			"a/prebuilds/darwin-arm64",
			"a/prebuilds/win32-x64",
			"a/prebuilds/linux-x64",
			"@s/b/native/darwin/prebuilds",
			"@s/b/native/linux/prebuilds",
			"@s/b/native/win32",
			"c/lib/darwin",
		]) {
			await mkdir(path.join(root, p), { recursive: true });
		}
		expect(await pruneForeignPrebuilds(root)).toBe(4);
		expect(await readdir(path.join(root, "a/prebuilds"))).toEqual(["linux-x64"]);
		expect(await readdir(path.join(root, "@s/b/native"))).toEqual(["linux"]);
		expect(existsSync(path.join(root, "c/lib/darwin"))).toBe(true);
	});
});

describe("BundleCache", () => {
	it("downloads, verifies and repacks node; second call hits the cache", async () => {
		const bundles = cache("c1");
		requests = [];
		const version = await bundles.resolveNodeVersion("latest-22", "x64");
		expect(version).toBe(VERSION);
		const progress: number[] = [];
		const node = await bundles.ensureNode(version, "x64", { progress: (done) => progress.push(done) });
		expect(node.name).toBe(`node-v${VERSION}-linux-x64.tar.gz`);
		expect(node.dirName).toBe(`node-v${VERSION}-linux-x64`);
		expect(progress.at(-1)).toBe(tarXz.length);
		const listing = execFileSync("tar", ["-tzf", node.path], { encoding: "utf8" });
		expect(listing).toContain(`node-v${VERSION}-linux-x64/bin/node`);
		const again = await bundles.ensureNode(version, "x64");
		expect(again.sha256).toBe(node.sha256);
		expect(requests.filter((r) => r.endsWith(".tar.xz"))).toHaveLength(1);
		expect(await bundles.resolveNodeVersion("v22.20.0")).toBe("22.20.0");

		const entries = await bundles.list();
		expect(entries).toEqual([
			expect.objectContaining({ name: node.name, kind: "node", version: VERSION, arch: "x64", bytes: node.bytes }),
		]);
		await bundles.delete(node.name);
		expect(await bundles.list()).toEqual([]);
		await expect(bundles.delete("../x.tar.gz")).rejects.toMatchObject({ status: 400 });
	});

	it("rejects a corrupted download", async () => {
		const bundles = cache("c2");
		corrupt = true;
		try {
			await expect(bundles.ensureNode(VERSION, "x64")).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
		} finally {
			corrupt = false;
		}
		expect(await bundles.list()).toEqual([]);
	});

	it("dedupes concurrent downloads", async () => {
		const bundles = cache("c3");
		requests = [];
		const [a, b] = await Promise.all([bundles.ensureNode(VERSION, "x64"), bundles.ensureNode(VERSION, "x64")]);
		expect(a.path).toBe(b.path);
		expect(requests.filter((r) => r.endsWith(".tar.xz"))).toHaveLength(1);
	});

	it("falls back to the cached index and runtimes when offline", async () => {
		const bundles = cache("c4");
		await bundles.ensureNode(await bundles.resolveNodeVersion("latest-22", "x64"), "x64");
		const offline = cache("c4", { nodeCustomBaseUrl: "http://127.0.0.1:1/dist" });
		expect(await offline.resolveNodeVersion("latest-22", "x64")).toBe(VERSION);
		await expect(offline.resolveNodeVersion("latest-22", "arm64")).rejects.toMatchObject({ code: "NODE_INDEX_UNAVAILABLE" });
	});

	it("imports a local tarball", async () => {
		const bundles = cache("c5");
		const entry = await bundles.importNode(`node-v${VERSION}-linux-x64.tar.xz`, createReadStream(path.join(dir, `node-v${VERSION}-linux-x64.tar.xz`)));
		expect(entry).toMatchObject({ kind: "node", version: VERSION, arch: "x64" });
		await expect(bundles.importNode("evil.tar.gz", createReadStream(path.join(dir, `node-v${VERSION}-linux-x64.tar.xz`)))).rejects.toMatchObject({
			status: 400,
		});
	});

	it("packs the agent dist", async () => {
		const bundles = cache("c6");
		const dist = path.join(dir, "agent-dist");
		await mkdir(dist, { recursive: true });
		await expect(bundles.ensureAgent(dist)).rejects.toMatchObject({ code: "AGENT_BUNDLE_MISSING" });
		for (const f of ["pi-web-agent.mjs", "bridge.mjs", "pi-web-ext.mjs"]) await writeFile(path.join(dist, f), "//\n");
		await writeFile(path.join(dist, "VERSION"), "1.2.3\n");
		const agent = await bundles.ensureAgent(dist);
		expect(agent).toMatchObject({ name: "pi-web-agent-1.2.3.tar.gz", version: "1.2.3" });
		expect(execFileSync("tar", ["-tzf", agent.path], { encoding: "utf8" }).trim().split("\n").sort()).toEqual([
			"VERSION",
			"bridge.mjs",
			"pi-web-agent.mjs",
			"pi-web-ext.mjs",
		]);
		expect((await bundles.list()).map((e) => e.kind)).toEqual(["agent"]);
	});
});
