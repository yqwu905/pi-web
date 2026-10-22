import type { ServerConfig } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import {
	affectsConnection,
	affectsSync,
	buildServerUpdate,
	dirtyCount,
	dirtyFields,
	dirtySections,
	formFromServer,
	idleTimeoutOptions,
	validateServerSettings,
} from "./server-settings-form";

const config: ServerConfig = {
	id: "s1",
	name: "gpu-01",
	group: "训练集群",
	host: "10.0.3.21",
	port: 22,
	username: "dev",
	auth: { method: "key", keyPath: "~/.ssh/id_ed25519", hasSecret: false },
	jumpServerIds: ["bastion"],
	remoteRoot: "~/.pi-web",
	agentDirMode: "isolated",
	proxy: { mode: "tunnel", port: 38412, scope: "llm", toolsPolicy: "allowlist", extraDomains: ["huggingface.co"], noProxy: ["10.0.0.0/8"] },
	sync: {
		items: {
			settings: true,
			models: true,
			auth: true,
			mcp: true,
			instructions: true,
			extensions: true,
			skills: true,
			prompts: true,
			themes: true,
			npm: true,
			git: true,
			agentsSkills: false,
			keybindings: false,
		},
		auto: true,
		settingsOverride: { defaultThinkingLevel: "medium" },
	},
	idleTimeoutMin: 30,
	defaultTrust: "approve",
	createdAt: 1,
	updatedAt: 1,
};

describe("server settings form", () => {
	it("round-trips a config without dirty fields", () => {
		const base = formFromServer(config);
		expect(base.noProxyText).toBe("10.0.0.0/8");
		expect(base.overrideText).toContain('"defaultThinkingLevel": "medium"');
		expect(dirtyFields(base, { ...base })).toEqual([]);
		expect(buildServerUpdate(base, { ...base })).toEqual({});
	});

	it("ignores formatting-only differences", () => {
		const base = formFromServer(config);
		const form = { ...base, overrideText: '{"defaultThinkingLevel":"medium"}', noProxyText: " 10.0.0.0/8, ", port: "022", name: "gpu-01 " };
		expect(dirtyFields(base, form)).toEqual([]);
	});

	it("tracks dirty fields, counts and sections", () => {
		const base = formFromServer(config);
		const form = {
			...base,
			agentDirMode: "shared" as const,
			extraDomains: ["huggingface.co", "cdn-lfs.huggingface.co"],
			syncItems: { ...base.syncItems, agentsSkills: true, keybindings: true },
		};
		const fields = dirtyFields(base, form);
		expect(fields).toEqual(["agentDirMode", "extraDomains", "syncItems"]);
		expect(dirtyCount(base, form)).toBe(4);
		expect([...dirtySections(fields)].sort()).toEqual(["deploy", "proxy", "sync"]);
		expect(affectsSync(fields)).toBe(true);
		expect(affectsConnection(fields)).toBe(false);
		expect(affectsConnection(["host"])).toBe(true);
		expect(affectsConnection(["name"])).toBe(false);
	});

	it("builds a minimal update", () => {
		const base = formFromServer(config);
		const form = {
			...base,
			proxyScope: "tools" as const,
			noProxyText: "10.0.0.0/8,vllm.internal",
			syncItems: { ...base.syncItems, mcp: false },
			overrideText: "{}",
			idleTimeoutMin: 0,
		};
		expect(buildServerUpdate(base, form)).toEqual({
			proxy: { scope: "tools", noProxy: ["10.0.0.0/8", "vllm.internal"] },
			sync: { items: { mcp: false }, settingsOverride: {} },
			idleTimeoutMin: 0,
		});
	});

	it("builds auth changes", () => {
		const base = formFromServer(config);
		expect(buildServerUpdate(base, { ...base, authMethod: "agent" }).auth).toEqual({ method: "agent", secret: null });
		expect(buildServerUpdate(base, { ...base, secret: "pp" }).auth).toEqual({ method: "key", keyPath: "~/.ssh/id_ed25519", secret: "pp" });
		expect(buildServerUpdate(base, { ...base, authMethod: "password", secret: "pw" }).auth).toEqual({ method: "password", secret: "pw" });
		const pwBase = { ...base, authMethod: "password" as const };
		expect(buildServerUpdate(pwBase, { ...pwBase, authMethod: "key" }).auth).toEqual({ method: "key", keyPath: "~/.ssh/id_ed25519", secret: null });
		// keyPath edits do not count while another method is selected
		expect(dirtyFields(pwBase, { ...pwBase, keyPath: "x" })).toEqual([]);
	});

	it("validates", () => {
		const base = formFromServer(config);
		expect(validateServerSettings(base, base, { hasSecret: false })).toEqual({});
		const errors = validateServerSettings({ ...base, proxyPort: "80", overrideText: "[1]", authMethod: "password" }, base, { hasSecret: false });
		expect(errors.proxyPort).toBeTruthy();
		expect(errors.overrideText).toBeTruthy();
		expect(errors.secret).toBe("请填写密码");
		const off = validateServerSettings({ ...base, proxyMode: "off", proxyPort: "" }, base, { hasSecret: false });
		expect(off.proxyPort).toBeUndefined();
		const pwBase = { ...base, authMethod: "password" as const };
		expect(validateServerSettings(pwBase, pwBase, { hasSecret: true }).secret).toBeUndefined();
	});

	it("keeps custom idle timeouts selectable", () => {
		expect(idleTimeoutOptions(30).map((o) => o.value)).toEqual([15, 30, 60, 120, 0]);
		expect(idleTimeoutOptions(45).map((o) => o.value)).toEqual([15, 30, 45, 60, 120, 0]);
	});
});
