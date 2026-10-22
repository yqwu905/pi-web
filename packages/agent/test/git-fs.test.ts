import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fsList, fsMkdir, fsRead, fsRealpath, fsStat } from "../src/daemon/handlers/fs.js";
import { gitDiff, gitLog, gitStatus } from "../src/daemon/handlers/git.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

let repo: string;

function git(...args: string[]): string {
	return execFileSync("git", args, {
		cwd: repo,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Tester",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "Tester",
			GIT_COMMITTER_EMAIL: "t@example.com",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	}).toString();
}

beforeAll(async () => {
	repo = await tempDir("pwa-git-");
	git("init", "-q", "-b", "main");
	await writeFile(join(repo, "a.txt"), "one\ntwo\n");
	await writeFile(join(repo, "old name.txt"), "rename me\n");
	await writeFile(join(repo, ".gitignore"), "build/\n*.tmp\n");
	await writeFile(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
	git("add", ".");
	git("commit", "-q", "-m", "initial commit");
	await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
	git("commit", "-q", "-am", "second");
	git("tag", "v1");
	// working tree changes
	await writeFile(join(repo, "a.txt"), "one\n2\nthree\n");
	git("mv", "old name.txt", "new name.txt");
	await writeFile(join(repo, "staged.txt"), "s\n");
	git("add", "staged.txt");
	await writeFile(join(repo, "bin.dat"), Buffer.from([0, 9, 9]));
	await mkdir(join(repo, "sub"), { recursive: true });
	await writeFile(join(repo, "sub", "untracked é.txt"), "u1\nu2\n");
	await mkdir(join(repo, "build"), { recursive: true });
	await writeFile(join(repo, "build", "out.js"), "x");
	await writeFile(join(repo, "x.tmp"), "x");
	await writeFile(join(repo, ".hidden"), "h");
	await symlink("a.txt", join(repo, "link-to-a"));
	await symlink("missing", join(repo, "dangling"));
});

afterAll(cleanupTempDirs);

describe("git handlers", () => {
	it("parses porcelain v2 status with numstat", async () => {
		const status = await gitStatus({ cwd: join(repo, "sub") });
		expect(status).toMatchObject({ isRepo: true, root: repo, branch: "main", ahead: 0, behind: 0 });
		expect(status.headShort).toMatch(/^[0-9a-f]{7}$/);
		const find = (path: string, area: string) => status.files.find((f) => f.path === path && f.area === area);
		expect(find("a.txt", "unstaged")).toMatchObject({ code: "M", additions: 1, deletions: 1 });
		expect(find("new name.txt", "staged")).toMatchObject({ code: "R", origPath: "old name.txt" });
		expect(find("staged.txt", "staged")).toMatchObject({ code: "A", additions: 1, deletions: 0 });
		expect(find("bin.dat", "unstaged")).toMatchObject({ code: "M", binary: true });
		expect(find("sub/untracked é.txt", "untracked")).toMatchObject({ code: "?" });
		expect(status.files.some((f) => f.path.startsWith("build/"))).toBe(false);
		expect(await gitStatus({ cwd: await tempDir("pwa-norepo-") })).toEqual({ isRepo: false, ahead: 0, behind: 0, files: [] });
	});

	it("produces diffs for each area", async () => {
		const unstaged = await gitDiff({ cwd: repo, area: "unstaged", path: "a.txt" });
		expect(unstaged.diff).toContain("-two");
		expect(unstaged.diff).toContain("+2");
		expect(unstaged.truncated).toBe(false);
		const staged = await gitDiff({ cwd: repo, area: "staged" });
		expect(staged.diff).toContain("staged.txt");
		expect(staged.diff).toContain("rename to new name.txt");
		const untracked = await gitDiff({ cwd: join(repo, "sub"), area: "untracked", path: "sub/untracked é.txt" });
		expect(untracked.diff).toContain("+u1");
		expect(untracked.diff).toContain("+u2");
		const allUntracked = await gitDiff({ cwd: repo, area: "untracked", contextLines: 0 });
		expect(allUntracked.diff).toContain("untracked é.txt");
		expect(allUntracked.diff).not.toContain("out.js");
	});

	it("lists commits with refs", async () => {
		const log = await gitLog({ cwd: repo, limit: 10 });
		expect(log.commits.map((c) => c.subject)).toEqual(["second", "initial commit"]);
		expect(log.commits[0]).toMatchObject({ author: "Tester", email: "t@example.com" });
		expect(log.commits[0].refs).toContain("tag: v1");
		expect(log.commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
		expect(log.commits[0].dateMs).toBeGreaterThan(0);
		expect((await gitLog({ cwd: repo, limit: 1 })).commits).toHaveLength(1);
		expect(await gitLog({ cwd: await tempDir("pwa-norepo-") })).toEqual({ commits: [] });
	});
});

describe("fs handlers", () => {
	it("lists directories first, hides dotfiles and marks ignored entries", async () => {
		const plain = await fsList({ path: repo });
		const names = plain.entries.map((e) => e.name);
		expect(names.slice(0, 2)).toEqual(["build", "sub"]);
		expect(names).not.toContain(".hidden");
		expect(names).not.toContain(".git");
		expect(plain.parent).toBe(join(repo, ".."));
		const link = plain.entries.find((e) => e.name === "link-to-a");
		expect(link).toMatchObject({ type: "symlink", targetType: "file" });
		expect(plain.entries.find((e) => e.name === "dangling")?.targetType).toBeUndefined();

		const marked = await fsList({ path: repo, showHidden: true, respectGitignore: true });
		expect(marked.entries.some((e) => e.name === ".hidden")).toBe(true);
		expect(marked.entries.find((e) => e.name === "build")?.ignored).toBe(true);
		expect(marked.entries.find((e) => e.name === "x.tmp")?.ignored).toBe(true);
		expect(marked.entries.find((e) => e.name === "a.txt")?.ignored).toBeUndefined();
		const hidden = await fsList({ path: repo, respectGitignore: true, hideIgnored: true });
		expect(hidden.entries.map((e) => e.name)).not.toContain("build");

		const outside = await fsList({ path: await tempDir("pwa-plain-"), respectGitignore: true });
		expect(outside.entries).toEqual([]);
		await expect(fsList({ path: join(repo, "nope") })).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fsList({ path: "~" })).path).toBe(homedir());
	});

	it("reads text, binary and truncated files", async () => {
		const text = await fsRead({ path: join(repo, "a.txt") });
		expect(text).toMatchObject({ encoding: "utf8", content: "one\n2\nthree\n", binary: false, truncated: false });
		const bin = await fsRead({ path: join(repo, "bin.dat") });
		expect(bin).toMatchObject({ encoding: "base64", binary: true, content: Buffer.from([0, 9, 9]).toString("base64") });
		const cut = await fsRead({ path: join(repo, "sub", "untracked é.txt"), maxBytes: 3 });
		expect(cut).toMatchObject({ content: "u1\n", truncated: true, size: 6 });
		await writeFile(join(repo, "utf.txt"), "aé");
		expect((await fsRead({ path: join(repo, "utf.txt"), maxBytes: 2 })).content).toBe("a");
		await expect(fsRead({ path: repo })).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("stats, creates directories and resolves real paths", async () => {
		expect(await fsStat({ path: join(repo, "a.txt") })).toMatchObject({ exists: true, type: "file", size: 12 });
		expect(await fsStat({ path: join(repo, "dangling") })).toMatchObject({ exists: true, type: "symlink" });
		expect(await fsStat({ path: join(repo, "none") })).toEqual({ path: join(repo, "none"), exists: false });
		const dir = join(repo, "made", "deep");
		expect(await fsMkdir({ path: dir })).toEqual({ ok: true });
		expect((await fsStat({ path: dir })).type).toBe("dir");
		await expect(fsMkdir({ path: dir, recursive: false })).rejects.toMatchObject({ code: "EEXIST" });
		expect(await fsRealpath({ path: join(repo, "link-to-a") })).toEqual({ path: join(repo, "a.txt") });
	});
});
