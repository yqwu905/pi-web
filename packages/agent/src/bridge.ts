/**
 * stdio <-> unix socket bridge, exec'd by the host over SSH:
 *   node R/daemon/bridge.mjs --root R
 * Connects to R/run/agent.sock (starting the daemon when needed), writes LINK_PREAMBLE
 * and then relays raw bytes in both directions. Nothing else may be written to stdout.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_PREAMBLE } from "@pi-web/shared/link";

const CONNECT_RETRY_MS = 100;
const START_TIMEOUT_MS = 15_000;

function fail(message: string): never {
	process.stderr.write(`pi-web bridge: ${message}\n`);
	process.exit(1);
}

function parseRoot(argv: string[]): string {
	const index = argv.indexOf("--root");
	let value = index >= 0 ? argv[index + 1] : undefined;
	if (!value) fail("usage: bridge.mjs --root <dir>");
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
	return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function connect(path: string): Promise<Socket> {
	return new Promise((resolvePromise, reject) => {
		const socket = createConnection(path);
		const onError = (err: Error) => {
			socket.destroy();
			reject(err);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			socket.off("error", onError);
			resolvePromise(socket);
		});
	});
}

function startDaemon(root: string): void {
	const daemonScript = fileURLToPath(new URL("./pi-web-agent.mjs", import.meta.url));
	const logsDir = join(root, "logs");
	mkdirSync(logsDir, { recursive: true, mode: 0o700 });
	const out = openSync(join(logsDir, "daemon.out"), "a", 0o600);
	try {
		const child = spawn(process.execPath, [daemonScript, "--root", root], {
			detached: true,
			stdio: ["ignore", out, out],
			cwd: root,
		});
		child.on("error", (err) => fail(`cannot start daemon: ${err.message}`));
		child.unref();
	} finally {
		closeSync(out);
	}
}

async function connectOrStart(root: string): Promise<Socket> {
	const socketPath = join(root, "run", "agent.sock");
	try {
		return await connect(socketPath);
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "ENOENT" && code !== "ECONNREFUSED") throw err;
	}
	startDaemon(root);
	const deadline = Date.now() + START_TIMEOUT_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
		try {
			return await connect(socketPath);
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(`daemon did not start within ${START_TIMEOUT_MS / 1000}s (${(lastError as Error)?.message ?? "unknown"}); see ${join(root, "logs", "daemon.out")}`);
}

async function main(): Promise<void> {
	const root = parseRoot(process.argv.slice(2));
	let socket: Socket;
	try {
		socket = await connectOrStart(root);
	} catch (err) {
		fail((err as Error).message);
	}
	const exit = (code: number) => {
		process.stdout.write("", () => process.exit(code));
	};
	process.stdout.on("error", () => process.exit(0));
	process.stdin.on("error", () => process.exit(0));
	socket.on("error", (err) => {
		process.stderr.write(`pi-web bridge: socket error: ${err.message}\n`);
		exit(1);
	});
	socket.on("close", () => exit(0));
	process.stdin.on("end", () => socket.end());
	process.stdin.on("close", () => socket.end());
	process.stdout.write(LINK_PREAMBLE);
	socket.pipe(process.stdout, { end: false });
	process.stdin.pipe(socket, { end: false });
}

void main();
