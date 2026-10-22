/**
 * Local OpenSSH server for integration tests: user "pitest" on 127.0.0.1:2222.
 * A lock directory serializes test files that need it (vitest runs files in parallel).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostKeyFingerprint, parsePublicKeyLine } from "../../../src/ssh/hostkey.js";

export const SSHD_PORT = 2222;
export const TEST_USER = "pitest";
export const TEST_HOME = `/home/${TEST_USER}`;
const LOCK_DIR = "/tmp/pitest-sshd.lock";
const PID_FILE = "/tmp/pitest-sshd.pid";

export interface SshdFixture {
	port: number;
	user: string;
	home: string;
	password: string;
	/** Unencrypted ed25519 private key accepted for the user. */
	keyPath: string;
	/** Passphrase-protected ed25519 key and its passphrase. */
	encryptedKeyPath: string;
	passphrase: string;
	/** SHA256 fingerprints of every host key the server may present. */
	hostFingerprints: string[];
	workDir: string;
	/** Kills the user's ssh sessions (simulates a dropped connection). */
	dropSessions(): void;
	stop(): Promise<void>;
}

export function integrationSkipReason(): string | null {
	if (process.env.PI_WEB_SKIP_INTEGRATION) return "PI_WEB_SKIP_INTEGRATION is set";
	if (process.platform !== "linux" || process.getuid?.() !== 0) return "requires root on Linux";
	if (!existsSync("/usr/sbin/sshd") || !existsSync("/usr/bin/ssh-keygen")) return "OpenSSH server not installed";
	return null;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function acquireLock(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await mkdir(LOCK_DIR);
			await writeFile(path.join(LOCK_DIR, "pid"), String(process.pid));
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		const owner = Number(await readFile(path.join(LOCK_DIR, "pid"), "utf8").catch(() => "0"));
		if (!owner || !processAlive(owner)) {
			// Stale lock (owner died); give a just-created lock a moment to get its pid file.
			await new Promise((r) => setTimeout(r, 300));
			const again = Number(await readFile(path.join(LOCK_DIR, "pid"), "utf8").catch(() => "0"));
			if (!again || !processAlive(again)) await rm(LOCK_DIR, { recursive: true, force: true });
			continue;
		}
		if (Date.now() > deadline) throw new Error("timed out waiting for the sshd test lock");
		await new Promise((r) => setTimeout(r, 500));
	}
}

function sh(command: string): string {
	return execFileSync("sh", ["-c", command], { encoding: "utf8" });
}

function killUserProcesses(): void {
	spawnSync("pkill", ["-KILL", "-u", TEST_USER]);
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const ok = await new Promise<boolean>((resolve) => {
			const socket = net.connect(port, "127.0.0.1");
			socket.once("data", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		});
		if (ok) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`sshd did not start on port ${port}`);
}

export async function startSshd(): Promise<SshdFixture> {
	await acquireLock(30 * 60_000);
	let child: ChildProcess | undefined;
	const workDir = await mkdtemp(path.join(tmpdir(), "pitest-ssh-"));
	try {
		if (spawnSync("id", ["-u", TEST_USER]).status !== 0) {
			execFileSync("useradd", ["-m", "-s", "/bin/bash", TEST_USER]);
		}
		const password = `Pw-${randomBytes(9).toString("base64url")}`;
		execFileSync("chpasswd", { input: `${TEST_USER}:${password}\n` });

		const keyPath = path.join(workDir, "id_ed25519");
		const encryptedKeyPath = path.join(workDir, "id_encrypted");
		const passphrase = `pp-${randomBytes(6).toString("hex")}`;
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "pitest", "-f", keyPath]);
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "pitest-enc", "-f", encryptedKeyPath]);
		const sshDir = path.join(TEST_HOME, ".ssh");
		await mkdir(sshDir, { recursive: true });
		const authorized = [await readFile(`${keyPath}.pub`, "utf8"), await readFile(`${encryptedKeyPath}.pub`, "utf8")].join("");
		await writeFile(path.join(sshDir, "authorized_keys"), authorized);
		sh(`chown -R ${TEST_USER}:${TEST_USER} ${sshDir} && chmod 700 ${sshDir} && chmod 600 ${sshDir}/authorized_keys`);

		if (!readdirSync("/etc/ssh").some((f) => /^ssh_host_.*_key$/.test(f))) execFileSync("ssh-keygen", ["-A"]);
		await mkdir("/run/sshd", { recursive: true, mode: 0o755 });
		const hostFingerprints = readdirSync("/etc/ssh")
			.filter((f) => /^ssh_host_.*_key\.pub$/.test(f))
			.map((f) => parsePublicKeyLine(readFileSync(path.join("/etc/ssh", f), "utf8")))
			.filter((blob): blob is Buffer => blob !== null)
			.map(hostKeyFingerprint);

		if (existsSync(PID_FILE)) {
			const old = Number(readFileSync(PID_FILE, "utf8"));
			if (old && processAlive(old)) process.kill(old, "SIGTERM");
			await rm(PID_FILE, { force: true });
		}
		child = spawn(
			"/usr/sbin/sshd",
			[
				"-D",
				"-e",
				"-p",
				String(SSHD_PORT),
				"-o",
				`PidFile=${PID_FILE}`,
				"-o",
				"AuthorizedKeysFile=.ssh/authorized_keys",
				"-o",
				"ListenAddress=127.0.0.1",
				"-o",
				"PasswordAuthentication=yes",
				"-o",
				"AllowTcpForwarding=yes",
				"-o",
				"LogLevel=ERROR",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr?.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-4000);
		});
		await waitForPort(SSHD_PORT, 10_000).catch((err) => {
			throw new Error(`${(err as Error).message}: ${stderr}`);
		});

		const running = child;
		return {
			port: SSHD_PORT,
			user: TEST_USER,
			home: TEST_HOME,
			password,
			keyPath,
			encryptedKeyPath,
			passphrase,
			hostFingerprints,
			workDir,
			dropSessions: () => {
				spawnSync("pkill", ["-KILL", "-f", `^sshd: ${TEST_USER}`]);
			},
			stop: async () => {
				running.kill("SIGTERM");
				await new Promise((r) => setTimeout(r, 200));
				killUserProcesses();
				await rm(workDir, { recursive: true, force: true });
				await rm(LOCK_DIR, { recursive: true, force: true });
			},
		};
	} catch (err) {
		child?.kill("SIGTERM");
		await rm(workDir, { recursive: true, force: true });
		await rm(LOCK_DIR, { recursive: true, force: true });
		throw err;
	}
}

/** Runs a command as the test user (via su, no SSH) — for assertions about remote state. */
export function runAsTestUser(command: string): { stdout: string; status: number | null } {
	const result = spawnSync("su", ["-s", "/bin/sh", TEST_USER, "-c", command], { encoding: "utf8" });
	return { stdout: result.stdout, status: result.status };
}
