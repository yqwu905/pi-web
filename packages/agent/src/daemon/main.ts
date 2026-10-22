import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Daemon } from "./daemon.js";
import { errnoCode, errorMessage } from "./errors.js";
import { resolveUserPath } from "./fsutil.js";
import { remotePaths } from "./paths.js";

function parseRoot(argv: string[]): string | null {
	const index = argv.indexOf("--root");
	const value = index >= 0 ? argv[index + 1] : undefined;
	return value ? resolve(resolveUserPath(value)) : null;
}

/** True when `pid` is a live pi-web-agent of this user (a process of another user cannot be ours). */
function isAgentProcess(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pi-web-agent");
	} catch {
		return true;
	}
}

/**
 * Takes the single-instance lock (run/agent.pid, O_EXCL). Returns false when another
 * live daemon holds it; stale locks are taken over.
 */
function acquireLock(lockFile: string): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockFile, "wx", 0o600);
			writeSync(fd, `${process.pid}\n`);
			closeSync(fd);
			return true;
		} catch (err) {
			if (errnoCode(err) !== "EEXIST") throw err;
			const pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
			if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAgentProcess(pid)) return false;
			try {
				unlinkSync(lockFile);
			} catch {
				// raced with another starter; retry
			}
		}
	}
	return false;
}

function releaseLock(lockFile: string): void {
	try {
		if (readFileSync(lockFile, "utf8").trim() === String(process.pid)) unlinkSync(lockFile);
	} catch {
		// already gone
	}
}

async function main(): Promise<void> {
	const root = parseRoot(process.argv.slice(2));
	if (!root) {
		process.stderr.write("usage: pi-web-agent --root <dir>\n");
		process.exit(2);
	}
	process.title = "pi-web-agent";
	process.on("SIGHUP", () => {});
	const paths = remotePaths(root);
	await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
	if (!acquireLock(paths.lockFile)) {
		process.stderr.write("pi-web-agent: another instance is running\n");
		process.exit(0);
	}
	const daemon = new Daemon({
		root,
		onStopAccepting: () => releaseLock(paths.lockFile),
		onShutdown: () => {
			releaseLock(paths.lockFile);
			process.exit(0);
		},
	});
	process.on("SIGTERM", () => void daemon.shutdown("SIGTERM"));
	process.on("SIGINT", () => void daemon.shutdown("SIGINT"));
	process.on("uncaughtException", (err) => daemon.log.error("uncaught exception", { error: err.stack ?? err.message }));
	process.on("unhandledRejection", (reason) => daemon.log.error("unhandled rejection", { error: errorMessage(reason) }));
	process.on("exit", () => releaseLock(paths.lockFile));
	let outcome;
	try {
		outcome = await daemon.start();
	} catch (err) {
		daemon.log.error("startup failed", { error: errorMessage(err) });
		process.stderr.write(`pi-web-agent: startup failed: ${errorMessage(err)}\n`);
		releaseLock(paths.lockFile);
		process.exit(1);
	}
	if (outcome === "already-running") {
		releaseLock(paths.lockFile);
		process.stderr.write("pi-web-agent: another instance is listening\n");
		process.exit(0);
	}
}

void main();
