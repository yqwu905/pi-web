import { createHash } from "node:crypto";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDesiredTree } from "../../src/sync/desired.js";
import { HashCache, type HashCacheEntry } from "../../src/sync/hash-cache.js";
import { externalRemotePath } from "../../src/sync/transform.js";
import { scanInventory } from "../../src/sync/inventory.js";
import { makeServer, put, tempDir } from "./fakes.js";

function memoryCache(): { cache: HashCache; data: { value?: Record<string, HashCacheEntry> } } {
	const data: { value?: Record<string, HashCacheEntry> } = {};
	const cache = new HashCache({ load: () => data.value, save: async (d) => void (data.value = d) }, 10);
	return { cache, data };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function hostFixture() {
	const home = await tempDir("piweb-home-");
	const agentDir = join(home, ".pi", "agent");
	const outside = join(home, "outside");
	await put(join(agentDir, "settings.json"), JSON.stringify({ extensions: [join(outside, "ext.ts")], npmCommand: ["pnpm"] }));
	await put(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } }));
	await put(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:1234/v1" } } }));
	await put(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "npx" } } }));
	await put(join(agentDir, "AGENTS.md"), "# hi");
	await put(join(agentDir, "extensions", "a.ts"), "export default 1;");
	await put(join(agentDir, "extensions", "debug.log"), "noise");
	await put(join(agentDir, "extensions", ".DS_Store"), "noise");
	await put(join(agentDir, "extensions", "pkg", ".git", "HEAD"), "ref");
	await put(join(agentDir, "extensions", "pkg", "index.ts"), "x");
	await symlink("a.ts", join(agentDir, "extensions", "alias.ts"));
	await symlink(join(agentDir, "extensions", "pkg"), join(agentDir, "extensions", "abs-link"));
	await put(join(outside, "ext.ts"), "external");
	await put(join(outside, "skill", "SKILL.md"), "skill");
	await symlink(join(outside, "skill"), join(agentDir, "extensions", "linked-dir"));
	await symlink(join(outside, "missing"), join(agentDir, "extensions", "dangling"));
	await put(join(agentDir, "npm", "node_modules", "fsevents", "fsevents.node"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]));
	await put(join(agentDir, "sessions", "x.jsonl"), "{}");
	await put(join(home, ".agents", "skills", "s1", "SKILL.md"), "agent skill");
	return { home, agentDir, outside };
}

describe("buildDesiredTree", () => {
	it("builds the tree with transforms, links, externals, excludes and warnings", async () => {
		const { home, agentDir, outside } = await hostFixture();
		const { cache } = memoryCache();
		const server = makeServer();
		const tree = await buildDesiredTree({
			hostAgentDir: agentDir,
			homeDir: home,
			agentsSkillsDir: join(home, ".agents", "skills"),
			server,
			items: ["settings", "auth", "models", "mcp", "instructions", "extensions", "npm", "agentsSkills"],
			arch: "x64",
			noProxy: ["localhost"],
			hashCache: cache,
		});
		const paths = [...tree.entries.keys()].sort();
		const ext = externalRemotePath(join(outside, "ext.ts"));
		expect(paths).toEqual(
			[
				"AGENTS.md",
				"agents-skills/s1/SKILL.md",
				"auth.json",
				ext,
				"extensions/a.ts",
				"extensions/abs-link",
				"extensions/alias.ts",
				"extensions/linked-dir/SKILL.md",
				"extensions/pkg/index.ts",
				"mcp.json",
				"models.json",
				"npm/node_modules/fsevents/fsevents.node",
				"settings.json",
			].sort(),
		);
		expect(tree.roots).toEqual(expect.arrayContaining(["settings.json", "auth.json", "extensions", "npm", "agents-skills", "external", "AGENTS.md"]));
		expect(tree.roots).not.toContain("skills");

		const alias = tree.entries.get("extensions/alias.ts")!;
		expect(alias.link).toBe("a.ts");
		expect(alias.sha256).toBe(sha("symlink:a.ts"));
		expect(tree.entries.get("extensions/abs-link")!.link).toBe("pkg");
		expect(tree.entries.get("extensions/linked-dir/SKILL.md")!.source).toBe(join(outside, "skill", "SKILL.md"));

		const settings = JSON.parse(tree.entries.get("settings.json")!.content!.toString());
		expect(settings).toEqual({ extensions: [ext], skills: ["agents-skills"], transport: "sse", shellCommandPrefix: expect.stringContaining("unset HTTP_PROXY") });
		const auth = tree.entries.get("auth.json")!;
		expect(auth.mode).toBe(0o600);
		expect(JSON.parse(auth.content!.toString()).anthropic.refresh).toBe("pi-web-managed");
		expect(tree.entries.get("extensions/a.ts")!.sha256).toBe(sha("export default 1;"));
		expect(tree.externalPaths).toEqual(expect.arrayContaining([join(outside, "ext.ts"), join(home, ".agents", "skills")]));

		expect(tree.warnings.some((w) => w.includes("127.0.0.1"))).toBe(true);
		expect(tree.warnings.some((w) => w.includes("npx"))).toBe(true);
		expect(tree.warnings.some((w) => w.includes("fsevents"))).toBe(true);
	});

	it("skips invalid settings.json with a warning and never syncs a broken auth.json", async () => {
		const home = await tempDir();
		const agentDir = join(home, "agent");
		await put(join(agentDir, "settings.json"), "{ nope");
		await put(join(agentDir, "auth.json"), "{ also nope");
		const tree = await buildDesiredTree({
			hostAgentDir: agentDir,
			homeDir: home,
			agentsSkillsDir: join(home, "none"),
			server: makeServer(),
			items: ["settings", "auth"],
			noProxy: [],
			hashCache: memoryCache().cache,
		});
		expect(tree.entries.size).toBe(0);
		expect(tree.warnings).toHaveLength(2);
	});

	it("generates settings.json for proxy settings even without a host file", async () => {
		const home = await tempDir();
		const agentDir = join(home, "agent");
		await mkdir(agentDir, { recursive: true });
		const off = makeServer();
		off.proxy.mode = "off";
		const opts = { hostAgentDir: agentDir, homeDir: home, agentsSkillsDir: join(home, "none"), items: ["settings"] as const, noProxy: [], hashCache: memoryCache().cache };
		expect((await buildDesiredTree({ ...opts, items: [...opts.items], server: makeServer() })).entries.has("settings.json")).toBe(true);
		expect((await buildDesiredTree({ ...opts, items: [...opts.items], server: off })).entries.has("settings.json")).toBe(false);
	});

	it("reuses cached hashes for unchanged (size, mtime)", async () => {
		const home = await tempDir();
		const agentDir = join(home, "agent");
		const file = join(agentDir, "prompts", "p.md");
		await put(file, "aaaa");
		const when = new Date("2026-01-01T00:00:00Z");
		await utimes(file, when, when);
		const { cache, data } = memoryCache();
		const opts = { hostAgentDir: agentDir, homeDir: home, agentsSkillsDir: join(home, "none"), server: makeServer(), items: ["prompts" as const], noProxy: [], hashCache: cache };
		const first = await buildDesiredTree(opts);
		expect(first.entries.get("prompts/p.md")!.sha256).toBe(sha("aaaa"));
		await cache.flush();
		expect(data.value?.[file]?.sha256).toBe(sha("aaaa"));
		// Same size and mtime: the cached hash is trusted.
		await writeFile(file, "bbbb");
		await utimes(file, when, when);
		expect((await buildDesiredTree(opts)).entries.get("prompts/p.md")!.sha256).toBe(sha("aaaa"));
		await utimes(file, new Date(), new Date());
		expect((await buildDesiredTree(opts)).entries.get("prompts/p.md")!.sha256).toBe(sha("bbbb"));
	});
});

describe("scanInventory", () => {
	it("counts files and summarizes items without exposing secrets", async () => {
		const { home, agentDir } = await hostFixture();
		await put(
			join(agentDir, "auth.json"),
			JSON.stringify({
				a: { type: "api_key", key: "sk-secret-1" },
				b: { type: "api_key", key: "sk-secret-2" },
				c: { type: "oauth", access: "tok", refresh: "ref", expires: 1 },
			}),
		);
		await put(join(agentDir, "git", "github.com", "o", "r", ".git", "HEAD"), "x");
		await put(join(agentDir, "git", "github.com", "o", "r", "package.json"), "{}");
		const inventory = await scanInventory(agentDir, join(home, ".agents", "skills"));
		const byKey = Object.fromEntries(inventory.items.map((i) => [i.key, i]));
		expect(byKey.auth.detail).toBe("2 个 API Key · 1 个 OAuth");
		expect(JSON.stringify(inventory)).not.toContain("sk-secret");
		expect(byKey.auth.fileCount).toBe(1);
		expect(byKey.mcp.detail).toBe("1 个服务器");
		expect(byKey.models.detail).toBe("1 个 provider · 0 个模型");
		expect(byKey.instructions.detail).toBe("AGENTS.md");
		expect(byKey.extensions.present).toBe(true);
		expect(byKey.npm.detail).toBe("1 个包");
		expect(byKey.git.detail).toBe("1 个包");
		expect(byKey.agentsSkills.present).toBe(true);
		expect(byKey.skills.present).toBe(false);
		expect(byKey.keybindings.present).toBe(false);
		expect(byKey.settings.bytes).toBeGreaterThan(0);
	});
});
