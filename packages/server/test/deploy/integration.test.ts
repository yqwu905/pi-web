/**
 * Real deployment to a local sshd (127.0.0.1:2222, user pitest): Node.js from
 * nodejs.org (through the host's HTTPS_PROXY), pi from npm, the built agent from
 * packages/agent/dist. Downloads are cached in /tmp/pi-web-test-cache.
 *
 * Opt-in: PI_WEB_INTEGRATION=1 npm test -w pi-web -- test/deploy/integration.test.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PROTOCOL_VERSION, type DeployProgress, type SyncRecord } from "@pi-web/shared";
import type { LinkAgentClient } from "../../src/ssh/agent-client.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/log.js";
import { createHostPaths, resolveAgentDistDir } from "../../src/core/paths.js";
import { createSecrets } from "../../src/core/secrets.js";
import { createServerConfig, createStore } from "../../src/core/store.js";
import type { HostPaths } from "../../src/core/types.js";
import { createDeployer, type PiWebDeployer } from "../../src/deploy/deployer.js";
import { createConnectionManager, type SshConnectionManager } from "../../src/ssh/connection-manager.js";
import { integrationSkipReason, runAsTestUser, startSshd, type SshdFixture } from "../ssh/fixtures/sshd.js";

const CACHE_ROOT = "/tmp/pi-web-test-cache";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const skipReason =
	integrationSkipReason() ?? (process.env.PI_WEB_INTEGRATION === "1" ? null : "set PI_WEB_INTEGRATION=1 to run the deploy integration test");
if (skipReason) console.warn(`[deploy integration] skipped: ${skipReason}`);

function ensureAgentBuilt(): string | null {
	const dir = resolveAgentDistDir();
	if (existsSync(path.join(dir, "VERSION"))) return dir;
	try {
		execFileSync("npm", ["run", "build", "-w", "@pi-web/agent"], { cwd: repoRoot, stdio: "ignore" });
	} catch {
		return null;
	}
	return existsSync(path.join(dir, "VERSION")) ? dir : null;
}

function waitForJob(deployer: PiWebDeployer, serverId: string): Promise<DeployProgress> {
	return new Promise((resolve) => {
		const check = (progress: DeployProgress) => {
			if (progress.serverId !== serverId || progress.state === "running") return;
			deployer.off("progress", check);
			resolve(progress);
		};
		deployer.on("progress", check);
		const current = deployer.getJob(serverId);
		if (current && current.state !== "running") check(current);
	});
}

function describeJob(job: DeployProgress): string {
	return [`state=${job.state} error=${job.error ?? ""}`, ...job.steps.map((s) => `${s.id}: ${s.status} ${s.detail ?? ""}`), ...job.log].join("\n");
}

describe.skipIf(!!skipReason)("deploy integration (local sshd)", () => {
	let fx: SshdFixture;
	let dataDir: string;
	let agentDistDir: string | null;
	let manager: SshConnectionManager;
	let deployer: PiWebDeployer;
	let store: ReturnType<typeof createStore>;
	const serverId = "local-deploy";
	const syncCalls: Array<[string, string]> = [];
	const proxyOpens: unknown[] = [];

	beforeAll(async () => {
		fx = await startSshd();
		execFileSync("sh", ["-c", `rm -rf ${fx.home}/.pi-web ${fx.home}/pi-web-sessions-backup-*`]);
		agentDistDir = ensureAgentBuilt();
		dataDir = await mkdtemp(path.join(tmpdir(), "pi-web-deploy-it-"));
		await mkdir(path.join(CACHE_ROOT, "cache", "tmp"), { recursive: true });
		const base = createHostPaths({ dataDir, agentDistDir: agentDistDir ?? resolveAgentDistDir(), webDistDir: null });
		const paths: HostPaths = { ...base, cacheDir: path.join(CACHE_ROOT, "cache"), tmpDir: path.join(CACHE_ROOT, "cache", "tmp") };
		store = createStore(paths);
		const secrets = createSecrets(paths);
		const log = createLogger(paths, { console: false, level: "debug" });
		const syncer = {
			run: async (id: string, trigger: SyncRecord["trigger"]): Promise<SyncRecord> => {
				syncCalls.push([id, trigger]);
				return { id: "r", serverId: id, at: Date.now(), trigger, added: 2, updated: 0, deleted: 0, conflicts: 0, backedUp: [], status: "ok", durationMs: 1 };
			},
		};
		const ctx = { version: "test", paths, log, store, secrets, syncer } as Record<string, unknown>;
		manager = createConnectionManager(ctx as never, { minBackoffMs: 500, maxBackoffMs: 2000 });
		ctx.connections = manager;
		deployer = createDeployer(ctx as never);
		ctx.deployer = deployer;
		// Stand-in for the TunnelProxy: accept every proxy stream and close it.
		manager.on("agent-connected", (_id: string, client: LinkAgentClient) => {
			client.peer.onStreamOpen((meta, control) => {
				proxyOpens.push(meta);
				control.accept().end();
			});
		});

		const input = { host: "127.0.0.1", port: fx.port, username: fx.user, auth: { method: "key" as const, keyPath: fx.keyPath } };
		const server = createServerConfig({ name: "deploy-target", ...input }, { id: serverId });
		const test = await manager.testConnection(input);
		server.hostKey = { ...test.hostKey!, trustedAt: Date.now() };
		await store.saveServer(server);
	}, 30 * 60_000);

	afterAll(async () => {
		await manager?.shutdown();
		await fx?.stop();
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	it("probes the server", async () => {
		const probe = await deployer.probe(serverId);
		expect(probe).toMatchObject({ os: "Linux", supportedArch: true, glibcOk: true, home: fx.home, sftp: true, issues: [] });
		expect(probe.existing).toBeUndefined();
	}, 60_000);

	it("deploys Node.js, pi and the agent, links to the agent", async (ctx) => {
		if (!agentDistDir) ctx.skip();
		const started = deployer.deploy(serverId, {});
		expect(started.state).toBe("running");
		expect(manager.status(serverId).deployState).toBe("deploying");
		expect(() => deployer.deploy(serverId, {})).toThrow(/正在部署/);
		const job = await waitForJob(deployer, serverId);
		expect(job.state, describeJob(job)).toBe("done");
		expect(job.steps.map((s) => s.status)).toEqual(Array(9).fill("done"));
		expect(job.steps.find((s) => s.id === "selfcheck")?.detail).toContain("代理连通");
		expect(proxyOpens).toContainEqual(expect.objectContaining({ kind: "proxy", host: "api.anthropic.com", port: 443 }));
		expect(syncCalls).toEqual([[serverId, "deploy"]]);

		const piVersion = await deployer.targetPiVersion();
		const deployed = store.getServer(serverId)!.deployed!;
		expect(deployed).toMatchObject({
			piVersion,
			agentVersion: deployer.agentVersion,
			arch: process.arch === "arm64" ? "arm64" : "x64",
			home: fx.home,
			remoteRoot: `${fx.home}/.pi-web`,
			agentDir: `${fx.home}/.pi-web/agent`,
		});
		expect(job.result).toEqual(deployed);

		const version = runAsTestUser("~/.pi-web/bin/pi --version");
		expect(version.stdout.trim()).toBe(piVersion);
		expect(runAsTestUser("stat -c %a ~/.pi-web").stdout.trim()).toBe("700");

		const conn = manager.get(serverId);
		const client = conn.agentClient!;
		expect(client.hello.agentVersion).toBe(deployer.agentVersion);
		const hello = await client.call("hello", { hostVersion: "test", protocol: AGENT_PROTOCOL_VERSION });
		expect(hello.remoteRoot).toBe(`${fx.home}/.pi-web`);
		expect(hello.config?.proxy).toMatchObject({ enabled: true, port: store.getServer(serverId)!.proxy.port, scope: "llm" });
		expect(hello.config?.piCliPath).toBe(`${fx.home}/.pi-web/pi/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`);
		const status = await client.call("agent.status", {});
		expect(status.conversations).toEqual([]);
		expect(manager.status(serverId)).toMatchObject({ connection: "connected", deployState: "deployed", agent: { version: deployer.agentVersion } });
		const deadline = Date.now() + 5000;
		while (manager.status(serverId).latencyMs === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		expect(manager.status(serverId).latencyMs).toBeGreaterThanOrEqual(0);

		const cache = await deployer.listCache();
		const kinds = cache.entries.filter((e) => e.usedBy.includes(serverId)).map((e) => e.kind).sort();
		expect(kinds).toEqual(["agent", "node", "pi"]);
	}, 30 * 60_000);

	it("can be cancelled, and a redeploy reuses installed components", async (ctx) => {
		if (!agentDistDir) ctx.skip();
		const pid = manager.get(serverId).agentClient!.hello.pid;
		deployer.deploy(serverId, { force: true });
		deployer.cancel(serverId);
		const cancelled = await waitForJob(deployer, serverId);
		expect(cancelled.state, describeJob(cancelled)).toBe("cancelled");
		expect(cancelled.steps.some((s) => s.status === "done")).toBe(false);
		expect(cancelled.log.at(-1)).toContain("部署已取消");
		expect(manager.status(serverId).deployState).toBe("deployed");

		const job = deployer.deploy(serverId, { sync: false });
		const done = await waitForJob(deployer, job.serverId);
		expect(done.state, describeJob(done)).toBe("done");
		const statuses = Object.fromEntries(done.steps.map((s) => [s.id, s.status]));
		expect(statuses).toMatchObject({ upload_node: "skipped", upload_pi: "skipped", upload_agent: "done", sync: "skipped", selfcheck: "done" });
		// Same agent version: the running daemon is kept.
		expect(manager.get(serverId).agentClient!.hello.pid).toBe(pid);
	}, 10 * 60_000);

	it("restarts the agent", async (ctx) => {
		if (!agentDistDir) ctx.skip();
		const conn = manager.get(serverId);
		const before = conn.agentClient!.hello.pid;
		const events: string[] = [];
		manager.on("agent-disconnected", () => events.push("down"));
		manager.on("agent-connected", () => events.push("up"));
		await deployer.restartAgent(serverId);
		const after = conn.agentClient!.hello.pid;
		expect(after).not.toBe(before);
		expect(events).toEqual(["down", "up"]);
		expect(runAsTestUser(`kill -0 ${before} 2>/dev/null && echo alive || echo gone`).stdout.trim()).toBe("gone");
	}, 120_000);

	it("uninstalls, keeping sessions", async (ctx) => {
		if (!agentDistDir) ctx.skip();
		const conn = manager.get(serverId);
		await conn.exec("mkdir -p ~/.pi-web/agent/sessions/--w-- && echo '{}' > ~/.pi-web/agent/sessions/--w--/s.jsonl");
		await deployer.uninstall(serverId, { keepSessions: true });
		expect(runAsTestUser("test -e ~/.pi-web && echo yes || echo no").stdout.trim()).toBe("no");
		expect(runAsTestUser("ls ~/pi-web-sessions-backup-*/--w--/s.jsonl").status).toBe(0);
		expect(store.getServer(serverId)!.deployed).toBeUndefined();
		expect(manager.status(serverId).deployState).toBe("not_deployed");
		expect(conn.agentClient).toBeNull();
		runAsTestUser("rm -rf ~/pi-web-sessions-backup-*");
	}, 120_000);
});
