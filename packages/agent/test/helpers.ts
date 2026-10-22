import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "@pi-web/shared";

export const testDir = dirname(fileURLToPath(import.meta.url));
export const packageDir = join(testDir, "..");
export const distDir = join(packageDir, "dist");
export const fakePi = join(testDir, "fixtures", "fake-pi.mjs");

const cleanups: string[] = [];

/** Creates a temp dir under the OS tmpdir (short path, unix sockets fit). */
export async function tempDir(prefix = "pwa-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(dir);
	return dir;
}

export async function cleanupTempDirs(): Promise<void> {
	while (cleanups.length > 0) {
		const dir = cleanups.pop() as string;
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Two connected in-memory duplexes, like a socketpair. */
export function socketPair(): [Duplex, Duplex] {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	const a = Duplex.from({ readable: bToA, writable: aToB });
	const b = Duplex.from({ readable: aToB, writable: bToA });
	return [a, b];
}

export function makeConfig(root: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		remoteRoot: root,
		agentDir: join(root, "agent"),
		nodePath: process.execPath,
		piCliPath: fakePi,
		piPackageDir: join(root, "pi"),
		piVersion: "1.4.0",
		companionExtPath: join(distDir, "pi-web-ext.mjs"),
		proxy: { enabled: false, port: 0, token: "", scope: "llm", noProxy: [] },
		idleTimeoutMin: 0,
		extraEnv: {},
		...overrides,
	};
}

export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 5000, intervalMs = 10): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = fn();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

export const silentLog = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};
