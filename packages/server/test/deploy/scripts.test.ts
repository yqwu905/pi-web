import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	compareVersions,
	installScript,
	mapArch,
	parseKeyValues,
	parseProbeOutput,
	piWrapperScript,
	probeScript,
	proxyCheckCommand,
	toProbeResult,
	uninstallScript,
	waitPidScript,
} from "../../src/deploy/scripts.js";

let dir: string;
let home: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-web-scripts-"));
	home = path.join(dir, "home");
	await mkdir(home, { recursive: true });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function sh(script: string, env: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync("sh", ["-s"], {
		input: script,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env },
	});
	return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function sha256(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("probe", () => {
	it("runs on this machine and parses", () => {
		const result = sh(`echo "login banner noise"\n${probeScript("~/.pi-web")}`);
		expect(result.status).toBe(0);
		const probe = parseProbeOutput(result.stdout, true);
		expect(probe.os).toBe("Linux");
		expect(probe.home).toBe(home);
		expect(probe.remoteRoot).toBe(path.join(home, ".pi-web"));
		expect(probe.supportedArch).toBe(true);
		expect(probe.glibcOk).toBe(true);
		expect(probe.hasTar && probe.hasGzip).toBe(true);
		expect(probe.diskFreeBytes).toBeGreaterThan(0);
		expect(probe.issues).toEqual([]);
		expect(probe.existing).toBeUndefined();
		expect(probe.installed).toEqual({ pi: [], node: [] });
		expect(Object.keys(toProbeResult(probe))).not.toContain("installed");
	}, 20_000);

	it("reports existing installations", async () => {
		const R = path.join(home, ".pi-web");
		await mkdir(path.join(R, "daemon"), { recursive: true });
		await mkdir(path.join(R, "pi", "1.4.0"), { recursive: true });
		await mkdir(path.join(R, "pi", "1.3.0"), { recursive: true });
		await mkdir(path.join(R, "runtime", "node-v22.20.0-linux-x64"), { recursive: true });
		await writeFile(path.join(R, "daemon", "VERSION"), "0.1.0\n");
		execFileSync("ln", ["-s", "1.4.0", path.join(R, "pi", "current")]);
		execFileSync("ln", ["-s", "node-v22.20.0-linux-x64", path.join(R, "runtime", "current")]);
		const probe = parseProbeOutput(sh(probeScript("~/.pi-web")).stdout, false);
		expect(probe.existing).toEqual({ agentVersion: "0.1.0", piVersion: "1.4.0", nodeVersion: "22.20.0" });
		expect(probe.installed.pi.sort()).toEqual(["1.3.0", "1.4.0"]);
		expect(probe.installed.node).toEqual(["node-v22.20.0-linux-x64"]);
		expect(probe.warnings.some((w) => w.includes("SFTP"))).toBe(true);
	}, 20_000);

	it("flags unsupported systems", () => {
		const out = ["@@os=Linux", "@@arch=armv7l", "@@glibc=2.17", "@@tar=1", "@@gzip=0", "@@home=/h", "@@df_kb=1000", "@@done=1"].join("\n");
		const probe = parseProbeOutput(out, true);
		expect(probe.supportedArch).toBe(false);
		expect(probe.glibcOk).toBe(false);
		expect(probe.issues).toHaveLength(3);
		expect(probe.warnings.some((w) => w.includes("500 MB"))).toBe(true);
		expect(parseProbeOutput("@@os=Linux\n@@arch=x86_64\n@@home=/h\n@@tar=1\n@@gzip=1\n@@done=1", true).issues).toEqual([
			"未检测到 glibc（可能是 musl 系统），无法运行官方 Node.js",
		]);
		expect(() => parseProbeOutput("garbage", true)).toThrow();
	});

	it("maps archs and compares versions", () => {
		expect(mapArch("x86_64")).toBe("x64");
		expect(mapArch("aarch64")).toBe("arm64");
		expect(mapArch("ppc64le")).toBeNull();
		expect(compareVersions("2.28", "2.31")).toBeLessThan(0);
		expect(compareVersions("2.35", "2.28")).toBeGreaterThan(0);
		expect(compareVersions("22.19.0", "v22.19")).toBe(0);
		expect(parseKeyValues("x\n@@a=1=2\n@@b=\n")).toEqual({ a: "1=2", b: "" });
	});
});

async function fakeBundles(root: string) {
	const nodeDir = "node-v22.99.0-linux-x64";
	const nodeSrc = path.join(root, "src-node");
	await mkdir(path.join(nodeSrc, nodeDir, "bin"), { recursive: true });
	// A fake "node" that prints its arguments.
	await writeFile(path.join(nodeSrc, nodeDir, "bin", "node"), '#!/bin/sh\necho "fake-node $*"\necho "AGENT=$PI_CODING_AGENT_DIR OFFLINE=$PI_OFFLINE PROXY=$HTTPS_PROXY"\n');
	await chmod(path.join(nodeSrc, nodeDir, "bin", "node"), 0o755);
	const nodeTar = path.join(root, "node.tar.gz");
	execFileSync("tar", ["-czf", nodeTar, "-C", nodeSrc, nodeDir]);

	const piSrc = path.join(root, "src-pi");
	const cli = path.join(piSrc, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
	await mkdir(cli, { recursive: true });
	await writeFile(path.join(cli, "cli.js"), "console.log('pi');\n");
	await writeFile(path.join(piSrc, "package.json"), "{}\n");
	const piTar = path.join(root, "pi.tar.gz");
	execFileSync("tar", ["-czf", piTar, "-C", piSrc, "node_modules", "package.json"]);

	const agentSrc = path.join(root, "src-agent");
	await mkdir(agentSrc, { recursive: true });
	for (const f of ["pi-web-agent.mjs", "bridge.mjs", "pi-web-ext.mjs"]) await writeFile(path.join(agentSrc, f), `// ${f}\n`);
	await writeFile(path.join(agentSrc, "VERSION"), "9.9.9\n");
	const agentTar = path.join(root, "agent.tar.gz");
	execFileSync("tar", ["-czf", agentTar, "-C", agentSrc, "pi-web-agent.mjs", "bridge.mjs", "pi-web-ext.mjs", "VERSION"]);
	return { nodeDir, nodeTar, piTar, agentTar };
}

describe("install", () => {
	it("installs, links, writes bin/pi and cleans up; then upgrades only what changed", async () => {
		const R = path.join(home, "pi web root");
		const upload = path.join(R, ".upload");
		await mkdir(upload, { recursive: true });
		const bundles = await fakeBundles(dir);
		for (const f of ["node.tar.gz", "pi.tar.gz", "agent.tar.gz"]) execFileSync("cp", [path.join(dir, f), path.join(upload, f)]);
		const params = {
			remoteRoot: R,
			agentDir: path.join(R, "agent"),
			nodeDir: bundles.nodeDir,
			piVersion: "1.4.0",
			node: { archive: path.join(upload, "node.tar.gz"), sha256: sha256(bundles.nodeTar) },
			pi: { archive: path.join(upload, "pi.tar.gz"), sha256: sha256(bundles.piTar) },
			agent: { archive: path.join(upload, "agent.tar.gz"), sha256: sha256(bundles.agentTar) },
			force: false,
		};
		const result = sh(installScript(params));
		expect(result.stderr).toBe("");
		expect(parseKeyValues(result.stdout).install).toBe("ok");
		expect(readlinkSync(path.join(R, "runtime", "current"))).toBe(bundles.nodeDir);
		expect(readlinkSync(path.join(R, "pi", "current"))).toBe("1.4.0");
		expect(readFileSync(path.join(R, "daemon", "VERSION"), "utf8").trim()).toBe("9.9.9");
		expect(existsSync(upload)).toBe(false);
		expect(existsSync(path.join(R, "daemon.tmp"))).toBe(false);
		expect((await readdir(path.join(R, "pi"))).sort()).toEqual(["1.4.0", "current"]);

		const run = spawnSync(path.join(R, "bin", "pi"), ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home } });
		expect(run.stdout).toContain(`fake-node ${R}/pi/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --version`);
		expect(run.stdout).toContain(`AGENT=${R}/agent OFFLINE=1 PROXY=`);

		// proxy.env is sourced when present
		await mkdir(path.join(R, "run"), { recursive: true });
		await writeFile(path.join(R, "run", "proxy.env"), "export HTTPS_PROXY=http://pw:t@127.0.0.1:1\n");
		const withProxy = spawnSync(path.join(R, "bin", "pi"), [], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: "/custom" } });
		expect(withProxy.stdout).toContain("AGENT=/custom OFFLINE=1 PROXY=http://pw:t@127.0.0.1:1");

		// Second run: only the agent is uploaded; existing versions are kept.
		await mkdir(upload, { recursive: true });
		execFileSync("cp", [bundles.agentTar, path.join(upload, "agent.tar.gz")]);
		await writeFile(path.join(R, "pi", "1.4.0", "marker"), "keep");
		const again = sh(installScript({ ...params, node: undefined, pi: undefined }));
		expect(parseKeyValues(again.stdout).install).toBe("ok");
		expect(existsSync(path.join(R, "pi", "1.4.0", "marker"))).toBe(true);
	}, 30_000);

	it("rejects a corrupted upload", async () => {
		const R = path.join(home, ".pi-web");
		await mkdir(path.join(R, ".upload"), { recursive: true });
		const bundles = await fakeBundles(dir);
		execFileSync("cp", [bundles.nodeTar, path.join(R, ".upload", "node.tar.gz")]);
		const result = sh(
			installScript({
				remoteRoot: R,
				agentDir: path.join(R, "agent"),
				nodeDir: bundles.nodeDir,
				piVersion: "1.4.0",
				node: { archive: path.join(R, ".upload", "node.tar.gz"), sha256: "0".repeat(64) },
				force: false,
			}),
		);
		expect(result.status).not.toBe(0);
		expect(parseKeyValues(result.stdout).error).toContain("checksum mismatch");
		expect(existsSync(path.join(R, "runtime", bundles.nodeDir))).toBe(false);
	}, 30_000);

	it("fails when a component is missing", async () => {
		const R = path.join(home, ".pi-web");
		const result = sh(installScript({ remoteRoot: R, agentDir: `${R}/agent`, nodeDir: "node-v1.0.0-linux-x64", piVersion: "1.4.0", force: false }));
		expect(result.status).not.toBe(0);
		expect(parseKeyValues(result.stdout).error).toContain("not installed");
	});

	it("escapes the wrapper", () => {
		const text = piWrapperScript({ remoteRoot: '/home/a"b', agentDir: "/home/$x/agent" });
		expect(text).toContain('PI_CODING_AGENT_DIR:-/home/\\$x/agent}');
		expect(text).toContain('exec "/home/a\\"b/runtime/current/bin/node"');
	});
});

describe("uninstall", () => {
	it("backs up sessions and removes the root", async () => {
		const R = path.join(home, ".pi-web");
		await mkdir(path.join(R, "agent", "sessions", "--x--"), { recursive: true });
		await writeFile(path.join(R, "agent", "sessions", "--x--", "s.jsonl"), "{}\n");
		const result = sh(uninstallScript({ remoteRoot: "~/.pi-web", keepSessions: true, timestamp: "20260101-000000" }));
		const kv = parseKeyValues(result.stdout);
		expect(kv.uninstall).toBe("ok");
		expect(kv.backup).toBe(path.join(home, "pi-web-sessions-backup-20260101-000000"));
		expect(existsSync(path.join(kv.backup, "--x--", "s.jsonl"))).toBe(true);
		expect(existsSync(R)).toBe(false);
	});

	it("refuses to delete the home directory", () => {
		const result = sh(uninstallScript({ remoteRoot: "~", keepSessions: false, timestamp: "t" }));
		expect(result.status).toBe(3);
		expect(existsSync(home)).toBe(true);
	});
});

describe("helpers", () => {
	it("waits for a pid", () => {
		expect(parseKeyValues(sh(waitPidScript(999999, 1)).stdout).exited).toBe("1");
		expect(parseKeyValues(sh(waitPidScript(process.pid, 0.4)).stdout).exited).toBe("0");
	});

	it("builds a proxy check that reads the token from stdin", async () => {
		const net = await import("node:net");
		let received = "";
		const server = net.createServer((socket) => {
			socket.on("data", (d) => {
				received += d.toString();
				if (received.includes("\r\n\r\n")) socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as import("node:net").AddressInfo).port;
		const command = proxyCheckCommand(process.execPath, port);
		const { spawn } = await import("node:child_process");
		const stdout = await new Promise<string>((resolve) => {
			const child = spawn("sh", ["-c", command]);
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.on("close", () => resolve(out));
			child.stdin.end("secret-token\n");
		});
		server.close();
		expect(stdout.trim()).toBe("HTTP/1.1 200 Connection Established");
		expect(received).toContain("CONNECT api.anthropic.com:443 HTTP/1.1");
		expect(received).toContain(`Proxy-Authorization: Basic ${Buffer.from("pw:secret-token").toString("base64")}`);
		expect(command).not.toContain("secret-token");
	});
});
