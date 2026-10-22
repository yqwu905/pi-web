/**
 * Real SSH against a local sshd (127.0.0.1:2222, user pitest). Requires root; set
 * PI_WEB_SKIP_INTEGRATION=1 to skip.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerConfig, ServerRuntimeStatus } from "@pi-web/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNullLogger } from "../../src/core/log.js";
import { createSecrets } from "../../src/core/secrets.js";
import { createServerConfig, createStore, type JsonStore } from "../../src/core/store.js";
import { createConnectionManager, type SshConnectionManager } from "../../src/ssh/connection-manager.js";
import { integrationSkipReason, runAsTestUser, startSshd, type SshdFixture } from "./fixtures/sshd.js";

const skipReason = integrationSkipReason();
if (skipReason) console.warn(`[ssh integration] skipped: ${skipReason}`);

describe.skipIf(!!skipReason)("ssh integration (local sshd)", () => {
	let fx: SshdFixture;
	let dataDir: string;
	let store: JsonStore;
	let secrets: ReturnType<typeof createSecrets>;
	let manager: SshConnectionManager;
	let server: ServerConfig;

	const base = () => ({ host: "127.0.0.1", port: fx.port, username: fx.user });

	beforeAll(async () => {
		fx = await startSshd();
		dataDir = await mkdtemp(path.join(tmpdir(), "pi-web-ssh-it-"));
		store = createStore({ dataDir });
		secrets = createSecrets({ dataDir });
		manager = createConnectionManager(
			{ version: "test", log: createNullLogger(), store, secrets },
			{ minBackoffMs: 200, maxBackoffMs: 1000 },
		);
	}, 30 * 60_000);

	afterAll(async () => {
		await manager?.shutdown();
		if (fx) runAsTestUser("rm -rf ~/up");
		await fx?.stop();
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	it("testConnection: unknown host key → trust → ok", async () => {
		const input = { ...base(), auth: { method: "key" as const, keyPath: fx.keyPath } };
		const first = await manager.testConnection(input);
		expect(first.ok).toBe(false);
		expect(first.hostKeyStatus).toBe("unknown");
		expect(first.hostKey?.algorithm).toMatch(/^(ssh-|ecdsa-)/);
		expect(fx.hostFingerprints).toContain(first.hostKey?.fingerprint);
		expect(first.error).toContain("主机指纹尚未确认");

		server = createServerConfig({ name: "local", ...input }, { id: "local" });
		await store.saveServer(server);
		await manager.trustHostKey(server.id, first.hostKey!);
		expect(store.getServer(server.id)?.hostKey?.fingerprint).toBe(first.hostKey!.fingerprint);

		const second = await manager.testConnection({ ...input, serverId: server.id });
		expect(second).toMatchObject({ ok: true, hostKeyStatus: "trusted", hostKey: first.hostKey });
		expect(second.latencyMs).toBeGreaterThanOrEqual(0);
	}, 60_000);

	it("rejects a changed host key", async () => {
		const bad = createServerConfig(
			{ name: "bad", ...base(), auth: { method: "key", keyPath: fx.keyPath } },
			{ id: "bad" },
		);
		bad.hostKey = { algorithm: "ssh-ed25519", fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", trustedAt: 1 };
		await store.saveServer(bad);
		const result = await manager.testConnection({ ...base(), auth: bad.auth, serverId: bad.id });
		expect(result).toMatchObject({ ok: false, hostKeyStatus: "mismatch" });
		await expect(manager.connect(bad.id)).rejects.toMatchObject({ code: "HOSTKEY_MISMATCH" });
		expect(manager.status(bad.id)).toMatchObject({ connection: "error", deployState: "not_deployed" });
		await manager.remove(bad.id);
		await store.deleteServer(bad.id);
	}, 60_000);

	it("authenticates with password, keyboard-interactive fallback and key passphrase", async () => {
		const trusted = store.getServer("local")!.hostKey!;
		const pw = await manager.testConnection({ ...base(), auth: { method: "password", secret: fx.password }, serverId: "local" });
		expect(pw.ok).toBe(true);
		const wrong = await manager.testConnection({ ...base(), auth: { method: "password", secret: "nope" }, serverId: "local" });
		expect(wrong.ok).toBe(false);
		expect(wrong.error).toContain("认证失败");
		const enc = await manager.testConnection({
			...base(),
			auth: { method: "key", keyPath: fx.encryptedKeyPath, secret: fx.passphrase },
			serverId: "local",
		});
		expect(enc.ok).toBe(true);
		const noPass = await manager.testConnection({ ...base(), auth: { method: "key", keyPath: fx.encryptedKeyPath, secret: null }, serverId: "local" });
		expect(noPass.ok).toBe(false);
		expect(noPass.error).toMatch(/私钥|passphrase/);

		// Stored secret is used when the request leaves it undefined.
		const pwServer = createServerConfig({ name: "pw", ...base(), auth: { method: "password", secret: fx.password } }, { id: "pw" });
		pwServer.hostKey = trusted;
		await store.saveServer(pwServer);
		await secrets.set("server:pw:secret", fx.password);
		const conn = manager.get("pw");
		const result = await conn.exec("whoami");
		expect(result.stdout.trim()).toBe(fx.user);
		await manager.remove("pw");
	}, 60_000);

	it("re-opens the session once when the saved settings or the stored secret change", async () => {
		const until = async (cond: () => boolean, timeoutMs = 15_000) => {
			const start = Date.now();
			while (!cond()) {
				if (Date.now() - start > timeoutMs) throw new Error("timed out");
				await new Promise((r) => setTimeout(r, 50));
			}
		};
		const pw = createServerConfig({ name: "pw2", ...base(), auth: { method: "password", secret: fx.password } }, { id: "pw2" });
		pw.hostKey = store.getServer("local")!.hostKey;
		await secrets.set("server:pw2:secret", fx.password);
		await store.saveServer(pw);
		await manager.connect("pw2");
		const states: string[] = [];
		const onStatus = (s: ServerRuntimeStatus) => {
			if (s.serverId === "pw2") states.push(s.connection);
		};
		manager.on("status", onStatus);
		try {
			// Unrelated changes keep the session.
			await store.saveServer({ ...store.getServer("pw2")!, name: "renamed" });
			await new Promise((r) => setTimeout(r, 300));
			expect(states).not.toContain("connecting");

			// A new password with the same auth method is a connection change too.
			await secrets.set("server:pw2:secret", "wrong-password");
			await store.saveServer({ ...store.getServer("pw2")! });
			await until(() => manager.status("pw2").connection === "error");
			expect(states.filter((s) => s === "connecting")).toHaveLength(1);

			await secrets.set("server:pw2:secret", fx.password);
			await manager.connect("pw2");
			expect(manager.status("pw2").connection).toBe("connected");
			expect((await manager.get("pw2").exec("whoami")).stdout.trim()).toBe(fx.user);
		} finally {
			manager.off("status", onStatus);
			await manager.remove("pw2");
			await store.deleteServer("pw2");
		}
	}, 60_000);

	it("exec: stdout/stderr/exit code, stdin, timeout and output cap", async () => {
		const conn = manager.get("local");
		const statuses: ServerRuntimeStatus[] = [];
		manager.on("status", (s: ServerRuntimeStatus) => statuses.push(s));
		await manager.connect("local");
		expect(manager.status("local")).toMatchObject({ connection: "connected", deployState: "not_deployed" });
		expect(statuses.some((s) => s.serverId === "local" && s.connection === "connected")).toBe(true);

		const r = await conn.exec("echo out; echo err >&2; exit 3");
		expect(r).toMatchObject({ stdout: "out\n", stderr: "err\n", code: 3 });
		const piped = await conn.exec("tr a-z A-Z", { stdin: "hello" });
		expect(piped.stdout).toBe("HELLO");
		await expect(conn.exec("sleep 10", { timeoutMs: 300 })).rejects.toMatchObject({ code: "TIMEOUT" });
		const capped = await conn.exec("head -c 100000 /dev/zero", { maxOutputBytes: 1000 });
		expect(capped.stdout.length).toBe(1000);
		const parallel = await Promise.all(Array.from({ length: 15 }, (_, i) => conn.exec(`echo ${i}`)));
		expect(parallel.map((p) => p.stdout.trim())).toEqual(Array.from({ length: 15 }, (_, i) => String(i)));
	}, 60_000);

	it("exec keeps the exit status when it arrives before the listeners are attached", async () => {
		const conn = manager.get("local");
		await manager.connect("local");
		type ExecFn = (command: string, ...rest: unknown[]) => boolean;
		const client = (conn as unknown as { clients: { exec: ExecFn }[] }).clients.at(-1);
		if (!client) throw new Error("no ssh client");
		const original = client.exec;
		// Deliver the exec callback late, so exit-status and close are processed first (as when
		// the reply, the output and the exit status arrive in one read).
		client.exec = function (this: unknown, command: string, ...rest: unknown[]) {
			const callback = rest.pop() as (err: Error | undefined, channel: unknown) => void;
			return original.call(this, command, ...rest, (err: Error | undefined, channel: unknown) => setTimeout(() => callback(err, channel), 150));
		};
		try {
			expect(await conn.exec("echo late; exit 7")).toMatchObject({ stdout: "late\n", code: 7 });
			await expect(conn.execChecked("mkdir -p ~/up-late && echo ok")).resolves.toMatchObject({ code: 0, stdout: "ok\n" });
		} finally {
			client.exec = original;
			runAsTestUser("rm -rf ~/up-late");
		}
	}, 30_000);

	it("upload with progress (SFTP and exec fallback), writeFile, readFile, createReadStream", async () => {
		const conn = manager.get("local");
		const local = path.join(fx.workDir, "blob.bin");
		const data = randomBytes(3 * 1024 * 1024 + 17);
		await writeFile(local, data);
		const sha = createHash("sha256").update(data).digest("hex");

		const progress: Array<[number, number]> = [];
		await conn.upload(local, "~/up/sftp/blob.bin", { mode: 0o640, onProgress: (d, t) => progress.push([d, t]) });
		expect(progress.at(-1)).toEqual([data.length, data.length]);
		expect(progress.length).toBeGreaterThan(2);
		const check = await conn.exec("sha256sum ~/up/sftp/blob.bin | cut -d' ' -f1; stat -c %a ~/up/sftp/blob.bin");
		expect(check.stdout.split("\n").slice(0, 2)).toEqual([sha, "640"]);

		const fallback = createConnectionManager({ version: "test", log: createNullLogger(), store, secrets }, { disableSftp: true });
		const fconn = fallback.get("local");
		const fprogress: number[] = [];
		await fconn.upload(local, `${fx.home}/up/exec dir/blob.bin`, { mode: 0o600, onProgress: (d) => fprogress.push(d) });
		expect(fprogress.at(-1)).toBe(data.length);
		const fcheck = await fconn.exec(`sha256sum ${"'"}${fx.home}/up/exec dir/blob.bin${"'"} | cut -d' ' -f1`);
		expect(fcheck.stdout.trim()).toBe(sha);
		const streamed = await fconn.createReadStream(`${fx.home}/up/exec dir/blob.bin`);
		expect(streamed.size).toBe(data.length);
		const chunks: Buffer[] = [];
		for await (const chunk of streamed.stream) chunks.push(chunk as Buffer);
		expect(Buffer.concat(chunks).equals(data)).toBe(true);
		const fcontroller = new AbortController();
		const fabort = fconn.upload(local, "~/up/exec-abort.bin", {
			signal: fcontroller.signal,
			onProgress: (d) => {
				if (d > 0) fcontroller.abort();
			},
		});
		await expect(fabort).rejects.toMatchObject({ code: "CANCELLED" });
		await new Promise((r) => setTimeout(r, 500));
		expect((await fconn.exec("ls ~/up")).stdout).not.toContain("exec-abort.bin\n");
		await fallback.shutdown();

		const controller = new AbortController();
		const aborted = conn.upload(local, "~/up/abort.bin", {
			signal: controller.signal,
			onProgress: (d) => {
				if (d > 0) controller.abort();
			},
		});
		await expect(aborted).rejects.toMatchObject({ code: "CANCELLED" });

		await conn.writeFile("~/up/text file.txt", "héllo\n", { mode: 0o600 });
		expect((await conn.readFile("~/up/text file.txt")).toString()).toBe("héllo\n");
		await conn.writeFile("~/up/abc.txt", "abcdef");
		expect((await conn.readFile("~/up/abc.txt", { maxBytes: 3 })).toString()).toBe("abc");
		await expect(conn.readFile("~/does-not-exist")).rejects.toMatchObject({ status: 404 });

		const viaSftp = await conn.createReadStream("~/up/sftp/blob.bin");
		expect(viaSftp.size).toBe(data.length);
		const hash = createHash("sha256");
		for await (const chunk of viaSftp.stream) hash.update(chunk as Buffer);
		expect(hash.digest("hex")).toBe(sha);
		expect(runAsTestUser("stat -c %U ~/up/sftp/blob.bin").stdout.trim()).toBe(fx.user);
	}, 120_000);

	it("opens a pty", async () => {
		const conn = manager.get("local");
		const channel = await conn.openPty({ command: "tty; echo $TERM; exit 0", cols: 100, rows: 30 });
		let out = "";
		channel.on("data", (d: Buffer) => (out += d.toString()));
		await new Promise((resolve) => channel.on("close", resolve));
		expect(out).toMatch(/\/dev\/pts\//);
		expect(out).toContain("xterm-256color");
	}, 30_000);

	it("connects through a jump host (localhost:2222 → localhost:2222)", async () => {
		const target = createServerConfig(
			{ name: "via-jump", ...base(), auth: { method: "key", keyPath: fx.keyPath }, jumpServerIds: ["local"] },
			{ id: "via-jump" },
		);
		const test1 = await manager.testConnection({ ...base(), auth: target.auth, jumpServerIds: ["local"] });
		expect(test1).toMatchObject({ ok: false, hostKeyStatus: "unknown" });
		target.hostKey = { ...test1.hostKey!, trustedAt: Date.now() };
		await store.saveServer(target);
		const test2 = await manager.testConnection({ ...base(), auth: target.auth, serverId: target.id });
		expect(test2).toMatchObject({ ok: true, hostKeyStatus: "trusted" });

		await manager.connect(target.id);
		const r = await manager.get(target.id).exec("echo $SSH_CONNECTION");
		// The final hop's client is the jump host's forwarded connection from 127.0.0.1.
		expect(r.stdout.trim()).toMatch(/^127\.0\.0\.1 \d+ 127\.0\.0\.1 2222$/);

		const untrustedJump = createServerConfig({ name: "j2", ...base(), auth: { method: "key", keyPath: fx.keyPath } }, { id: "j2" });
		await store.saveServer(untrustedJump);
		const viaUntrusted = await manager.testConnection({ ...base(), auth: target.auth, jumpServerIds: ["j2"] });
		expect(viaUntrusted.ok).toBe(false);
		expect(viaUntrusted.error).toContain("跳板机 j2");
		await manager.remove(target.id);
	}, 60_000);

	it("reconnects automatically after the connection drops", async () => {
		await manager.connect("local");
		const conn = manager.get("local");
		const states: string[] = [];
		conn.on("state", (s: string) => states.push(s));
		fx.dropSessions();
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline && !(states.includes("disconnected") && conn.state === "connected")) {
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(states).toContain("disconnected");
		expect(conn.state).toBe("connected");
		expect((await conn.exec("echo back")).stdout).toBe("back\n");

		// Changing the saved auth settings re-opens the session with the new settings.
		const before = conn.connectedAt;
		await secrets.set("server:local:secret", fx.password);
		const updated = store.getServer("local")!;
		updated.auth = { method: "password", hasSecret: true };
		await store.saveServer(updated);
		const until = Date.now() + 10_000;
		while (Date.now() < until && !(conn.state === "connected" && conn.connectedAt !== before)) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(conn.connectedAt).not.toBe(before);
		expect((await conn.exec("echo pw")).stdout).toBe("pw\n");

		await manager.disconnect("local");
		expect(manager.status("local").connection).toBe("disconnected");
		fx.dropSessions();
		await new Promise((r) => setTimeout(r, 500));
		expect(conn.state).toBe("disconnected");
	}, 60_000);

	it("rejects agent() before deployment", async () => {
		await expect(manager.get("local").agent()).rejects.toMatchObject({ code: "NOT_DEPLOYED" });
	});
});
