import type { ProbeResult } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { probeChecks, probeSummary, recommendedProxyMode } from "./probe-checks";

const good: ProbeResult = {
	os: "Linux",
	arch: "x86_64",
	supportedArch: true,
	kernel: "5.15.0",
	glibc: "2.35",
	glibcOk: true,
	home: "/home/dev",
	shell: "/bin/bash",
	diskFreeBytes: 118 * 1024 ** 3,
	hasTar: true,
	hasGzip: true,
	sftp: true,
	internet: { reachable: false, detail: "timeout" },
	issues: [],
	warnings: [],
};

describe("probeChecks", () => {
	it("passes a healthy offline server with an internet hint", () => {
		const checks = probeChecks(good);
		expect(checks.map((c) => c.key)).toEqual(["system", "glibc", "home", "tar", "sftp", "internet", "existing", "shell"]);
		const internet = checks.find((c) => c.key === "internet");
		expect(internet?.status).toBe("warn");
		expect(internet?.suggestion).toContain("隧道代理");
		expect(checks.find((c) => c.key === "home")?.hint).toContain("118 GB");
		expect(checks.find((c) => c.key === "existing")?.value).toBe("未发现 ~/.pi-web");
		const summary = probeSummary(good, checks);
		expect(summary).toEqual({ pass: 7, warn: 1, fail: 0, blocking: false });
	});

	it("fails unsupported systems and missing tools", () => {
		const bad: ProbeResult = { ...good, arch: "ppc64le", supportedArch: false, glibc: "2.17", glibcOk: false, hasGzip: false, sftp: false };
		const checks = probeChecks(bad);
		expect(checks.find((c) => c.key === "system")?.status).toBe("fail");
		expect(checks.find((c) => c.key === "glibc")?.status).toBe("fail");
		expect(checks.find((c) => c.key === "tar")?.value).toBe("缺少 gzip");
		expect(checks.find((c) => c.key === "sftp")?.status).toBe("warn");
		expect(probeSummary(bad).blocking).toBe(true);
	});

	it("blocks on host-reported issues and counts host warnings", () => {
		const summary = probeSummary({ ...good, internet: { reachable: true }, issues: ["x"], warnings: ["w1", "w2"] });
		expect(summary.blocking).toBe(true);
		expect(summary.fail).toBe(1);
		expect(summary.warn).toBe(2);
	});

	it("warns on low disk and describes existing installs", () => {
		const checks = probeChecks({ ...good, diskFreeBytes: 100 * 1024 * 1024, existing: { piVersion: "1.3.0", agentVersion: "0.1.0" } });
		expect(checks.find((c) => c.key === "home")?.status).toBe("warn");
		expect(checks.find((c) => c.key === "existing")?.value).toBe("已安装 pi 1.3.0 · agent 0.1.0");
	});

	it("recommends the tunnel unless the server is online", () => {
		expect(recommendedProxyMode(good)).toBe("tunnel");
		expect(recommendedProxyMode({ ...good, internet: { reachable: true } })).toBe("off");
		expect(recommendedProxyMode(undefined)).toBe("tunnel");
	});
});
