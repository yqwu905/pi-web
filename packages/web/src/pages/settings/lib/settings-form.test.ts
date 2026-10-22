import { DEFAULT_HOST_SETTINGS, type HostSettings } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import {
	buildSettingsPatch,
	compareVersions,
	defaultForm,
	formFromSettings,
	isLoopback,
	needsRestart,
	nodeVersionOptions,
	parseNoProxy,
	validateSettingsForm,
} from "./settings-form";

const settings: HostSettings = {
	...DEFAULT_HOST_SETTINGS,
	nodeSource: "npmmirror",
	nodeVersion: "22.20.0",
	npmRegistry: "https://registry.npmmirror.com",
	upstreamProxy: "http://proxy.corp.local:3128",
	hostAgentDir: "/opt/pi/agent",
};

describe("settings form", () => {
	it("round-trips without changes", () => {
		const base = formFromSettings(settings);
		expect(base.archX64 && base.archArm64).toBe(true);
		expect(base.portFrom).toBe("30000");
		expect(validateSettingsForm(base)).toEqual({});
		expect(buildSettingsPatch(base, { ...base })).toEqual({});
	});

	it("builds a patch of changed keys, clearing optional strings with empty text", () => {
		const base = formFromSettings(settings);
		const form = {
			...base,
			nodeVersion: "v22.21.0",
			archArm64: false,
			upstreamProxy: " ",
			portTo: "39000",
			defaultNoProxyText: "localhost, 127.0.0.1 ::1 , 10.0.0.0/8",
			listenPort: "8080",
			piVersionPolicy: "pinned" as const,
			piPinnedVersion: "v1.4.2",
		};
		const patch = buildSettingsPatch(base, form);
		expect(patch).toEqual({
			nodeVersion: "22.21.0",
			targetArchs: ["x64"],
			upstreamProxy: "",
			proxyPortRange: [30000, 39000],
			defaultNoProxy: ["localhost", "127.0.0.1", "::1", "10.0.0.0/8"],
			listenPort: 8080,
			piVersionPolicy: "pinned",
			piPinnedVersion: "1.4.2",
		});
		expect(needsRestart(patch)).toBe(true);
		expect(needsRestart({ nodeVersion: "x" })).toBe(false);
	});

	it("validates every section", () => {
		const base = formFromSettings(settings);
		const e = validateSettingsForm({
			...base,
			nodeSource: "custom",
			nodeCustomBaseUrl: "",
			nodeVersion: "20.1.0",
			archX64: false,
			archArm64: false,
			piVersionPolicy: "pinned",
			piPinnedVersion: "",
			npmRegistry: "ftp://x",
			upstreamProxy: "proxy:3128",
			portFrom: "40000",
			portTo: "30000",
			listenHost: "",
			listenPort: "0",
			hostAgentDir: "relative/dir",
		});
		expect(Object.keys(e).sort()).toEqual(
			["archX64", "hostAgentDir", "listenHost", "listenPort", "nodeCustomBaseUrl", "nodeVersion", "npmRegistry", "piPinnedVersion", "portTo", "upstreamProxy"].sort(),
		);
		expect(e.nodeVersion).toContain("22.19.0");
		expect(validateSettingsForm({ ...base, nodeVersion: "latest-22" }).nodeVersion).toBeUndefined();
		expect(validateSettingsForm({ ...base, portFrom: "80" }).portFrom).toBeTruthy();
	});

	it("restores defaults but keeps the host agent dir", () => {
		const base = formFromSettings(settings);
		const d = defaultForm(base);
		expect(d.nodeSource).toBe("official");
		expect(d.nodeVersion).toBe("latest-22");
		expect(d.hostAgentDir).toBe("/opt/pi/agent");
	});
});

describe("helpers", () => {
	it("compares versions", () => {
		expect(compareVersions("22.20.0", "22.19.0")).toBe(1);
		expect(compareVersions("v22.19.0", "22.19.0")).toBe(0);
		expect(compareVersions("22.9.0", "22.19.0")).toBe(-1);
		expect(compareVersions("24.0.0-rc.1", "24.0.0")).toBe(0);
	});
	it("parses NO_PROXY and detects loopback", () => {
		expect(parseNoProxy("a,b  a\nc")).toEqual(["a", "b", "c"]);
		expect(isLoopback("127.0.0.1")).toBe(true);
		expect(isLoopback("localhost")).toBe(true);
		expect(isLoopback("0.0.0.0")).toBe(false);
	});
	it("lists node versions newest first", () => {
		expect(nodeVersionOptions("22.18.5", ["22.19.0", "22.20.0", "22.19.0"])).toEqual(["latest-22", "22.20.0", "22.19.0", "22.18.5"]);
		expect(nodeVersionOptions("latest-22", [])).toEqual(["latest-22"]);
	});
});
