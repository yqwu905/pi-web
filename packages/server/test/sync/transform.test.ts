import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { externalRemotePath, mergeShellPrefix, transformAuth, transformSettings, UNSET_PROXY_PREFIX } from "../../src/sync/transform.js";
import { authWarnings, mcpWarnings, modelsWarnings, nativePackageKey, nativeWarnings } from "../../src/sync/warnings.js";
import { classifyNative } from "../../src/sync/hash-cache.js";
import { makeServer } from "./fakes.js";

const AGENT = "/home/me/.pi/agent";
const HOME = "/home/me";

function settingsFor(input: Record<string, unknown>, server = makeServer(), extra: { agentsSkillsDir?: string; exists?: (p: string) => boolean } = {}) {
	return transformSettings(input, {
		hostAgentDir: AGENT,
		homeDir: HOME,
		server,
		agentsSkillsDir: extra.agentsSkillsDir,
		exists: extra.exists ?? (() => true),
	});
}

describe("transformSettings", () => {
	it("drops host-only settings and absolute sessionDir", () => {
		const { settings } = settingsFor({
			npmCommand: ["pnpm"],
			shellPath: "/bin/zsh",
			httpProxy: "http://corp:3128",
			sessionDir: "/data/sessions",
			defaultModel: "claude",
		});
		expect(settings).not.toHaveProperty("npmCommand");
		expect(settings).not.toHaveProperty("shellPath");
		expect(settings).not.toHaveProperty("httpProxy");
		expect(settings).not.toHaveProperty("sessionDir");
		expect(settings.defaultModel).toBe("claude");
		expect(settingsFor({ sessionDir: "~/sessions" }).settings).not.toHaveProperty("sessionDir");
		expect(settingsFor({ sessionDir: "local-sessions" }).settings.sessionDir).toBe("local-sessions");
	});

	it("injects transport and the unset prefix for tunnel + llm scope", () => {
		const { settings } = settingsFor({ shellCommandPrefix: "source ~/.venv/bin/activate", transport: "websocket" });
		expect(settings.transport).toBe("sse");
		expect(settings.shellCommandPrefix).toBe(`${UNSET_PROXY_PREFIX}\nsource ~/.venv/bin/activate`);
	});

	it("does not inject the prefix for tools scope, nor anything when the proxy is off", () => {
		const tools = makeServer();
		tools.proxy.scope = "tools";
		const t = settingsFor({}, tools).settings;
		expect(t.transport).toBe("sse");
		expect(t).not.toHaveProperty("shellCommandPrefix");

		const off = makeServer();
		off.proxy.mode = "off";
		const o = settingsFor({ transport: "websocket" }, off).settings;
		expect(o.transport).toBe("websocket");
		expect(o).not.toHaveProperty("shellCommandPrefix");
	});

	it("copies agent-dir paths that no enabled sync item covers, and warns about disabled items", () => {
		const server = makeServer();
		server.sync.items.prompts = false;
		const { settings, externals, warnings } = settingsFor(
			{
				packages: ["./local/my-pkg", `${AGENT}/local/other`, "./extensions/kept"],
				prompts: ["prompts/review.md"],
			},
			server,
		);
		const local = externalRemotePath(join(AGENT, "local/my-pkg"));
		expect(settings.packages).toEqual([local, externalRemotePath(join(AGENT, "local/other")), "./extensions/kept"]);
		expect(externals.map((e) => e.remote)).toEqual([local, externalRemotePath(join(AGENT, "local/other"))]);
		// prompts is disabled for this server: the path stays, with a warning.
		expect(settings.prompts).toEqual(["prompts/review.md"]);
		expect(warnings.join("\n")).toContain("prompts/review.md 所属的同步项未启用");
	});

	it("merges the prefix idempotently", () => {
		expect(mergeShellPrefix(undefined)).toBe(UNSET_PROXY_PREFIX);
		expect(mergeShellPrefix(`${UNSET_PROXY_PREFIX}\nfoo`)).toBe(`${UNSET_PROXY_PREFIX}\nfoo`);
	});

	it("deep-merges the server override last", () => {
		const server = makeServer();
		server.sync.settingsOverride = { transport: "auto", retry: { maxRetries: 9 }, theme: "light" };
		const { settings } = settingsFor({ retry: { enabled: true, maxRetries: 3 }, theme: "dark" }, server);
		expect(settings.transport).toBe("auto");
		expect(settings.retry).toEqual({ enabled: true, maxRetries: 9 });
		expect(settings.theme).toBe("light");
	});

	it("rewrites external local paths and leaves remote sources alone", () => {
		const { settings, externals, warnings } = settingsFor({
			packages: ["npm:@a/b@1.0.0", "git:github.com/x/y", "../shared-pkg", { source: "/opt/pi/pkg", skills: [] }],
			extensions: ["extensions/local.ts", `${AGENT}/extensions/abs.ts`, "~/dev/ext.ts", "+/opt/one.ts", "-builtin:mcp", "!**/*.test.ts"],
			skills: ["https://example.com/skill"],
		});
		const shared = join(HOME, ".pi", "shared-pkg");
		expect(settings.packages).toEqual([
			"npm:@a/b@1.0.0",
			"git:github.com/x/y",
			externalRemotePath(shared),
			{ source: externalRemotePath("/opt/pi/pkg"), skills: [] },
		]);
		expect(settings.extensions).toEqual([
			"extensions/local.ts",
			"extensions/abs.ts",
			externalRemotePath(join(HOME, "dev/ext.ts")),
			`+${externalRemotePath("/opt/one.ts")}`,
			"-builtin:mcp",
			"!**/*.test.ts",
		]);
		expect(settings.skills).toEqual(["https://example.com/skill"]);
		expect(externals.map((e) => e.abs).sort()).toEqual([join(HOME, "dev/ext.ts"), shared, "/opt/one.ts", "/opt/pi/pkg"].sort());
		expect(externalRemotePath("/opt/pi/pkg")).toMatch(/^external\/[0-9a-f]{12}-pkg$/);
		expect(warnings).toEqual([]);
	});

	it("warns about missing external paths and keeps them unchanged", () => {
		const { settings, externals, warnings } = settingsFor({ prompts: ["/nope/prompts"] }, makeServer(), { exists: () => false });
		expect(settings.prompts).toEqual(["/nope/prompts"]);
		expect(externals).toEqual([]);
		expect(warnings[0]).toContain("/nope/prompts");
	});

	it("maps ~/.agents/skills to agents-skills", () => {
		const dir = join(HOME, ".agents", "skills");
		const { settings, externals } = settingsFor({ skills: ["~/.agents/skills", "skills/extra"] }, makeServer(), { agentsSkillsDir: dir });
		expect(settings.skills).toEqual(["agents-skills", "skills/extra"]);
		expect(externals).toEqual([]);
		expect(settingsFor({}, makeServer(), { agentsSkillsDir: dir }).settings.skills).toEqual(["agents-skills"]);
	});
});

describe("transformAuth", () => {
	it("replaces only the OAuth refresh token", () => {
		const out = transformAuth({
			anthropic: { type: "oauth", access: "acc", refresh: "secret-refresh", expires: 123, accountId: "x" },
			openai: { type: "api_key", key: "sk-1" },
		});
		expect(out.anthropic).toEqual({ type: "oauth", access: "acc", refresh: "pi-web-managed", expires: 123, accountId: "x" });
		expect(out.openai).toEqual({ type: "api_key", key: "sk-1" });
		expect(JSON.stringify(out)).not.toContain("secret-refresh");
	});
});

describe("warnings", () => {
	it("flags command and env-var keys without echoing secrets", () => {
		const warnings = authWarnings({
			a: { type: "api_key", key: "!security find-generic-password -ws anthropic" },
			b: { type: "api_key", key: "${OPENAI_KEY}" },
			c: { type: "api_key", key: "ANTHROPIC_API_KEY" },
			d: { type: "api_key", key: "sk-live-secret" },
			e: { type: "oauth", access: "x", refresh: "y", expires: 1 },
		});
		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toContain("“a”");
		expect(warnings[0]).not.toContain("security");
		expect(warnings[1]).toContain("OPENAI_KEY");
		expect(warnings[2]).toContain("ANTHROPIC_API_KEY");
		expect(warnings.join("")).not.toContain("sk-live-secret");
	});

	it("flags intranet and loopback model endpoints", () => {
		const models = {
			providers: {
				local: { baseUrl: "http://localhost:11434/v1" },
				vllm: { baseUrl: "http://10.1.2.3:8000/v1" },
				covered: { baseUrl: "http://gpu.lan:8000/v1" },
				cloud: { baseUrl: "https://api.example.com/v1", models: [{ id: "m", baseUrl: "http://192.168.1.5/v1" }] },
			},
		};
		const warnings = modelsWarnings(models, { tunnel: true, noProxy: ["localhost", ".lan"] });
		expect(warnings).toHaveLength(3);
		expect(warnings.some((w) => w.includes("“local”") && w.includes("本机"))).toBe(true);
		expect(warnings.some((w) => w.includes("10.1.2.3") && w.includes("NO_PROXY"))).toBe(true);
		expect(warnings.some((w) => w.includes("192.168.1.5"))).toBe(true);
		expect(modelsWarnings(models, { tunnel: false, noProxy: [] })).toHaveLength(1);
	});

	it("flags npx/uvx MCP servers", () => {
		const warnings = mcpWarnings({
			mcpServers: {
				fs: { command: "npx", args: ["-y", "x"] },
				py: { command: "/usr/local/bin/uvx", args: ["tool"] },
				off: { command: "npx", enabled: false },
				web: { url: "https://example.com/mcp" },
			},
		});
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("fs");
		expect(warnings[1]).toContain("uvx");
	});

	it("classifies native addons and warns when no linux build matches", () => {
		const elf = Buffer.alloc(64);
		elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
		elf.writeUInt16LE(62, 18);
		expect(classifyNative(elf)).toBe("linux-x64");
		elf.writeUInt16LE(183, 18);
		expect(classifyNative(elf)).toBe("linux-arm64");
		expect(classifyNative(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))).toBe("darwin");
		expect(classifyNative(Buffer.from("MZ......"))).toBe("win32");

		expect(nativePackageKey("npm/node_modules/@scope/pkg/build/Release/a.node")).toBe("npm/node_modules/@scope/pkg");
		expect(nativePackageKey("git/github.com/o/r/node_modules/x/b.node")).toBe("git/github.com/o/r/node_modules/x");
		expect(nativePackageKey("git/github.com/o/r/build/b.node")).toBe("git/github.com/o/r");

		const warnings = nativeWarnings(
			[
				{ rel: "npm/node_modules/fsevents/fsevents.node", native: "darwin" },
				{ rel: "npm/node_modules/good/prebuilds/darwin-arm64/a.node", native: "darwin" },
				{ rel: "npm/node_modules/good/prebuilds/linux-x64/a.node", native: "linux-x64" },
				{ rel: "npm/node_modules/armonly/a.node", native: "linux-arm64" },
			],
			"x64",
		);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("fsevents");
		expect(warnings[1]).toContain("armonly");
	});
});
