import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readlink, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncApplyParams } from "@pi-web/shared";
import { ensureRemoteDirs, type RemotePaths, remotePaths } from "../src/daemon/paths.js";
import { extractTarGz, isExcluded, SyncHandler } from "../src/daemon/handlers/sync.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let root: string;
let agentDir: string;
let paths: RemotePaths;
let sync: SyncHandler;

async function put(rel: string, content: string): Promise<void> {
	const file = join(agentDir, rel);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, content);
}

/** Builds a tar.gz with the given files (relative paths) the way the host does. */
async function archive(files: Record<string, string | { link: string }>, options?: { mtime?: Date }): Promise<string> {
	const src = await tempDir("pwa-src-");
	for (const [rel, content] of Object.entries(files)) {
		const file = join(src, rel);
		await mkdir(dirname(file), { recursive: true });
		if (typeof content === "string") {
			await writeFile(file, content);
			if (options?.mtime) await utimes(file, options.mtime, options.mtime);
		} else await symlink(content.link, file);
	}
	const out = join(paths.incomingDir, `${Math.random().toString(16).slice(2)}.tar.gz`);
	execFileSync("tar", ["-czf", out, "-C", src, ...Object.keys(files)]);
	return out;
}

beforeEach(async () => {
	root = await tempDir();
	paths = remotePaths(root);
	await ensureRemoteDirs(paths);
	agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	sync = new SyncHandler({ paths, getAgentDir: () => agentDir });
});

afterEach(cleanupTempDirs);

describe("isExcluded", () => {
	it("skips top-level excludes and logs anywhere", () => {
		expect(isExcluded("sessions/a.jsonl")).toBe(true);
		expect(isExcluded("trust.json")).toBe(true);
		expect(isExcluded("extensions/x/debug.log")).toBe(true);
		expect(isExcluded("extensions/sessions/a.ts")).toBe(false);
		expect(isExcluded("settings.json")).toBe(false);
	});
});

describe("sync.manifest", () => {
	it("hashes files, records symlinks and caches hashes", async () => {
		await put("settings.json", "{}");
		await put("extensions/a/index.ts", "export {}");
		await put("extensions/a/.git/HEAD", "ref");
		await put("extensions/a/x.log", "log");
		await put("sessions/s.jsonl", "{}");
		await symlink("a/index.ts", join(agentDir, "extensions", "link.ts"));
		const m = await sync.manifest({ roots: ["settings.json", "extensions", "sessions", "missing"] });
		expect(Object.keys(m.files).sort()).toEqual(["extensions/a/index.ts", "extensions/link.ts", "settings.json"]);
		expect(m.files["settings.json"].sha256).toBe(sha("{}"));
		expect(m.files["extensions/link.ts"]).toMatchObject({ link: "a/index.ts", sha256: sha("symlink:a/index.ts") });
		expect(m.managed).toEqual({});
		expect(m.agentDir).toBe(agentDir);
		const cache = JSON.parse(await readFile(paths.hashCache, "utf8"));
		expect(cache["settings.json"].sha256).toBe(sha("{}"));

		// A cached hash is reused while size and mtime are unchanged.
		const st = await stat(join(agentDir, "settings.json"));
		cache["settings.json"].sha256 = "cached";
		await writeFile(paths.hashCache, JSON.stringify(cache));
		expect((await sync.manifest({ roots: ["settings.json"] })).files["settings.json"].sha256).toBe("cached");
		expect(st.size).toBe(2);
	});

	it("rejects roots escaping the agent dir", async () => {
		await expect(sync.manifest({ roots: ["../etc"] })).rejects.toMatchObject({ code: "BAD_PATH" });
		await expect(sync.manifest({ roots: ["/etc"] })).rejects.toMatchObject({ code: "BAD_PATH" });
	});
});

describe("sync.apply", () => {
	it("writes files and symlinks, then tracks them as managed", async () => {
		const archivePath = await archive({ "settings.json": '{"a":1}', "extensions/x/index.ts": "x", "extensions/l.ts": { link: "x/index.ts" } });
		const result = await sync.apply({
			archivePath,
			writes: [
				{ path: "settings.json", sha256: sha('{"a":1}'), mode: 0o600 },
				{ path: "extensions/x/index.ts", sha256: sha("x") },
				{ path: "extensions/l.ts", sha256: sha("symlink:x/index.ts"), link: "x/index.ts" },
			],
			deletes: [],
			backupLabel: "b1",
		});
		expect(result).toMatchObject({ written: 3, deleted: 0, backedUp: [], errors: [] });
		expect(result.backupDir).toBeUndefined();
		expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe('{"a":1}');
		expect((await stat(join(agentDir, "settings.json"))).mode & 0o777).toBe(0o600);
		expect(await readlink(join(agentDir, "extensions/l.ts"))).toBe("x/index.ts");
		const manifest = await sync.manifest({ roots: ["settings.json", "extensions"] });
		expect(manifest.managed).toEqual({
			"settings.json": sha('{"a":1}'),
			"extensions/x/index.ts": sha("x"),
			"extensions/l.ts": sha("symlink:x/index.ts"),
		});
		// staging and the uploaded archive are cleaned up
		await expect(stat(archivePath)).rejects.toThrow();
		await expect(stat(join(paths.incomingDir, "b1"))).rejects.toThrow();
	});

	it("backs up conflicting files before overwrite and delete", async () => {
		// First sync writes two managed files.
		await sync.apply({
			archivePath: await archive({ "a.md": "v1", "skills/s/SKILL.md": "s1" }),
			writes: [
				{ path: "a.md", sha256: sha("v1") },
				{ path: "skills/s/SKILL.md", sha256: sha("s1") },
			],
			deletes: [],
			backupLabel: "first",
		});
		// Server-side edits and an unmanaged local file.
		await put("a.md", "local edit");
		await put("skills/s/SKILL.md", "local skill edit");
		await put("prompts/p.md", "unmanaged");

		const result = await sync.apply({
			archivePath: await archive({ "a.md": "v2", "prompts/p.md": "from host" }),
			writes: [
				{ path: "a.md", sha256: sha("v2") },
				{ path: "prompts/p.md", sha256: sha("from host") },
			],
			deletes: ["skills/s/SKILL.md"],
			backupLabel: "second",
		});
		expect(result.errors).toEqual([]);
		expect(result.written).toBe(2);
		expect(result.deleted).toBe(1);
		expect(result.backedUp.sort()).toEqual(["a.md", "prompts/p.md", "skills/s/SKILL.md"]);
		expect(result.backupDir).toBe(join(paths.backupDir, "second"));
		expect(await readFile(join(paths.backupDir, "second", "a.md"), "utf8")).toBe("local edit");
		expect(await readFile(join(paths.backupDir, "second", "prompts/p.md"), "utf8")).toBe("unmanaged");
		expect(await readFile(join(paths.backupDir, "second", "skills/s/SKILL.md"), "utf8")).toBe("local skill edit");
		expect(await readFile(join(agentDir, "a.md"), "utf8")).toBe("v2");
		// empty parent directories of deleted files are removed
		await expect(stat(join(agentDir, "skills"))).rejects.toThrow();
		const managed = (await sync.manifest({ roots: [] })).managed;
		expect(Object.keys(managed).sort()).toEqual(["a.md", "prompts/p.md"]);
	});

	it("does not back up unchanged managed files or identical content", async () => {
		await put("same.md", "same");
		const result = await sync.apply({
			archivePath: await archive({ "same.md": "same" }),
			writes: [{ path: "same.md", sha256: sha("same") }],
			deletes: [],
			backupLabel: "x",
		});
		expect(result.backedUp).toEqual([]);
		const again = await sync.apply({ archivePath: null, writes: [], deletes: ["same.md"], backupLabel: "y" });
		expect(again).toMatchObject({ deleted: 1, backedUp: [], errors: [] });
	});

	it("rejects path traversal and reports checksum mismatches per file", async () => {
		const bad: SyncApplyParams[] = [
			{ archivePath: null, writes: [{ path: "../evil", sha256: "x" }], deletes: [], backupLabel: "t" },
			{ archivePath: null, writes: [{ path: "/etc/passwd", sha256: "x" }], deletes: [], backupLabel: "t" },
			{ archivePath: null, writes: [], deletes: ["a/../../b"], backupLabel: "t" },
		];
		for (const params of bad) await expect(sync.apply(params)).rejects.toMatchObject({ code: "BAD_PATH" });

		const result = await sync.apply({
			archivePath: await archive({ "ok.md": "ok", "bad.md": "tampered" }),
			writes: [
				{ path: "ok.md", sha256: sha("ok") },
				{ path: "bad.md", sha256: sha("original") },
				{ path: "absent.md", sha256: sha("absent") },
			],
			deletes: [],
			backupLabel: "z",
		});
		expect(result.written).toBe(1);
		expect(result.errors.map((e) => e.path).sort()).toEqual(["absent.md", "bad.md"]);
		await expect(lstat(join(agentDir, "bad.md"))).rejects.toThrow();
	});

	it("refuses to write through symlinked directories pointing outside", async () => {
		const outside = await tempDir("pwa-out-");
		await symlink(outside, join(agentDir, "themes"));
		const result = await sync.apply({
			archivePath: await archive({ "themes/t.json": "{}" }),
			writes: [{ path: "themes/t.json", sha256: sha("{}") }],
			deletes: [],
			backupLabel: "sym",
		});
		expect(result.written).toBe(0);
		expect(result.errors[0]?.path).toBe("themes/t.json");
		await expect(stat(join(outside, "t.json"))).rejects.toThrow();
	});

	it("handles a directory replaced by a symlink (and back) without touching the link target", async () => {
		await sync.apply({
			archivePath: await archive({ "skills/foo/SKILL.md": "foo skill" }),
			writes: [{ path: "skills/foo/SKILL.md", sha256: sha("foo skill") }],
			deletes: [],
			backupLabel: "s1",
		});
		// Host: skills/foo renamed to skills/bar, compatibility link skills/foo -> bar.
		const swap = await sync.apply({
			archivePath: await archive({ "skills/bar/SKILL.md": "foo skill", "skills/foo": { link: "bar" } }),
			writes: [
				{ path: "skills/bar/SKILL.md", sha256: sha("foo skill") },
				{ path: "skills/foo", sha256: sha("symlink:bar"), link: "bar" },
			],
			deletes: ["skills/foo/SKILL.md"],
			backupLabel: "s2",
		});
		expect(swap).toMatchObject({ written: 2, deleted: 1, errors: [], backedUp: [] });
		expect(await readFile(join(agentDir, "skills/bar/SKILL.md"), "utf8")).toBe("foo skill");
		expect(await readlink(join(agentDir, "skills/foo"))).toBe("bar");
		expect(Object.keys((await sync.manifest({ roots: [] })).managed).sort()).toEqual(["skills/bar/SKILL.md", "skills/foo"]);

		// A stale delete below a path that is now a link only drops the manifest entry.
		const stale = await sync.apply({ archivePath: null, writes: [], deletes: ["skills/foo/SKILL.md"], backupLabel: "s3" });
		expect(stale).toMatchObject({ deleted: 0, errors: [] });
		expect(await readFile(join(agentDir, "skills/bar/SKILL.md"), "utf8")).toBe("foo skill");

		// Writes never go through a symlinked parent (they would land in the link target).
		const through = await sync.apply({
			archivePath: await archive({ "skills/foo/SKILL.md": "new foo" }),
			writes: [{ path: "skills/foo/SKILL.md", sha256: sha("new foo") }],
			deletes: [],
			backupLabel: "s4",
		});
		expect(through.written).toBe(0);
		expect(through.errors[0]?.error).toContain("符号链接");
		expect(await readFile(join(agentDir, "skills/bar/SKILL.md"), "utf8")).toBe("foo skill");

		// Reverse swap: the link becomes a real directory again.
		const back = await sync.apply({
			archivePath: await archive({ "skills/foo/SKILL.md": "new foo" }),
			writes: [{ path: "skills/foo/SKILL.md", sha256: sha("new foo") }],
			deletes: ["skills/foo"],
			backupLabel: "s5",
		});
		expect(back).toMatchObject({ written: 1, deleted: 1, errors: [] });
		expect((await lstat(join(agentDir, "skills/foo"))).isDirectory()).toBe(true);
		expect(await readFile(join(agentDir, "skills/bar/SKILL.md"), "utf8")).toBe("foo skill");
	});

	it("adopts identical files as managed without writing them", async () => {
		await put("prompts/p.md", "same");
		await put("prompts/q.md", "changed since the plan");
		const result = await sync.apply({
			archivePath: null,
			writes: [],
			deletes: [],
			adopt: [
				{ path: "prompts/p.md", sha256: sha("same") },
				{ path: "prompts/q.md", sha256: sha("planned") },
			],
			backupLabel: "a",
		});
		expect(result).toMatchObject({ written: 0, deleted: 0, errors: [] });
		expect((await sync.manifest({ roots: [] })).managed).toEqual({ "prompts/p.md": sha("same") });
	});

	it("keeps conflict backups of a shared agent dir outside the install root", async () => {
		const home = await tempDir("pwa-home-");
		const shared = join(home, ".pi", "agent");
		await mkdir(shared, { recursive: true });
		await writeFile(join(shared, "auth.json"), '{"real":"refresh"}');
		const handler = new SyncHandler({ paths, getAgentDir: () => shared });
		const result = await handler.apply({
			archivePath: await archive({ "auth.json": "{}" }),
			writes: [{ path: "auth.json", sha256: sha("{}") }],
			deletes: [],
			backupLabel: "shared",
		});
		expect(result.backedUp).toEqual(["auth.json"]);
		expect(result.backupDir).toBe(join(shared, ".pi-web-backup", "shared"));
		expect(await readFile(join(shared, ".pi-web-backup", "shared", "auth.json"), "utf8")).toBe('{"real":"refresh"}');
		await expect(stat(join(paths.backupDir, "shared"))).rejects.toThrow();
	});
});

describe("archive extraction", () => {
	it("applies archives whose mtimes are ahead of the server clock (host clock skew)", async () => {
		const future = new Date(Date.now() + 24 * 3600_000);
		const files: Record<string, string> = {};
		for (let i = 0; i < 50; i++) files[`extensions/skew/f${i}.ts`] = `export const v = ${i};\n`;
		const archivePath = await archive(files, { mtime: future });
		const result = await sync.apply({
			archivePath,
			writes: Object.entries(files).map(([path, content]) => ({ path, sha256: sha(content) })),
			deletes: [],
			backupLabel: "skew",
		});
		expect(result.errors).toEqual([]);
		expect(result.written).toBe(50);
		// Extraction time is used as mtime, not the host's future timestamp.
		expect((await stat(join(agentDir, "extensions/skew/f0.ts"))).mtimeMs).toBeLessThan(future.getTime() - 3600_000);
	});

	it("decides by tar's exit code, however much it writes to stderr", async () => {
		const dir = await tempDir("pwa-faketar-");
		const ok = join(dir, "tar-ok");
		const fail = join(dir, "tar-fail");
		// > 2 MiB of warnings, like GNU tar's per-file "time stamp ... in the future" lines.
		const noisy = 'i=0; while [ $i -lt 40000 ]; do echo "tar: some/file-$i: time stamp is 54 s in the future" >&2; i=$((i+1)); done';
		await writeFile(ok, `#!/bin/sh\n${noisy}\nexit 0\n`);
		await writeFile(fail, `#!/bin/sh\n${noisy}\necho "tar: Unexpected EOF in archive" >&2\nexit 2\n`);
		await chmod(ok, 0o755);
		await chmod(fail, 0o755);
		await expect(extractTarGz("/dev/null", dir, ok)).resolves.toBeUndefined();
		await expect(extractTarGz("/dev/null", dir, fail)).rejects.toMatchObject({
			code: "EXTRACT_FAILED",
			message: expect.stringContaining("Unexpected EOF in archive"),
		});
	});
});
