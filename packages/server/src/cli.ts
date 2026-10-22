/**
 * pi-web [--host 127.0.0.1] [--port 7878] [--data-dir DIR] [--dev]
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildApp } from "./app.js";
import { createAppRuntime, readPackageVersion } from "./context.js";
import { installHostHttpDispatcher } from "./core/http.js";

const USAGE = `Usage: pi-web [options]

Options:
  --host <addr>      Listen address (default: settings.listenHost, 127.0.0.1)
  --port <port>      Listen port (default: settings.listenPort, 7878)
  --data-dir <dir>   Data directory (default: $PI_WEB_DATA_DIR or ~/.pi-web-host)
  --dev              Development mode (accept the Vite dev server origin)
  -v, --version      Print the version
  -h, --help         Show this help
`;

export interface CliOptions {
	host?: string;
	port?: number;
	dataDir?: string;
	dev: boolean;
	help: boolean;
	version: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			host: { type: "string" },
			port: { type: "string" },
			"data-dir": { type: "string" },
			dev: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
			version: { type: "boolean", short: "v", default: false },
		},
		strict: true,
		allowPositionals: false,
	});
	let port: number | undefined;
	if (values.port !== undefined) {
		port = Number(values.port);
		if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${values.port}`);
	}
	return {
		host: values.host?.trim() || undefined,
		port,
		dataDir: values["data-dir"],
		dev: values.dev === true,
		help: values.help === true,
		version: values.version === true,
	};
}

/** URL to show for a listen address (wildcards are shown as loopback). */
export function displayUrl(host: string, port: number): string {
	const shown = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
	const hostPart = shown.includes(":") && !shown.startsWith("[") ? `[${shown}]` : shown;
	return `http://${hostPart}:${port}/`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	let options: CliOptions;
	try {
		options = parseCliArgs(argv);
	} catch (err) {
		process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		process.stdout.write(USAGE);
		return;
	}
	if (options.version) {
		process.stdout.write(`${readPackageVersion()}\n`);
		return;
	}

	const runtime = await createAppRuntime({ dataDir: options.dataDir });
	const { ctx } = runtime;
	// Global fetch (pi-ai's OAuth refresh) must honour the host's proxy settings like pi's own CLI.
	installHostHttpDispatcher(() => ctx.store.getSettings().upstreamProxy);
	const settings = ctx.store.getSettings();
	const host = options.host ?? settings.listenHost ?? "127.0.0.1";
	const port = options.port ?? settings.listenPort ?? 7878;

	const app = await buildApp(ctx, {
		dev: options.dev,
		listenHost: host,
		hub: runtime.hub,
		auth: runtime.auth,
		sshConfigHosts: runtime.sshConfigHosts,
	});

	process.on("unhandledRejection", (reason) => {
		ctx.log.error("unhandled promise rejection", { error: reason instanceof Error ? reason.message : String(reason) });
	});

	let closing = false;
	const shutdown = async (signal: string) => {
		if (closing) {
			process.stderr.write("Forced exit\n");
			process.exit(1);
		}
		closing = true;
		ctx.log.info("shutting down", { signal });
		const force = setTimeout(() => process.exit(1), 10_000);
		force.unref();
		try {
			runtime.hub.close();
			await app.close();
		} catch (err) {
			ctx.log.warn("http close failed", { error: (err as Error).message });
		}
		await runtime.shutdown();
		clearTimeout(force);
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	try {
		await app.listen({ host, port });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		const reason = e.code === "EADDRINUSE" ? `address ${host}:${port} is already in use` : e.message;
		process.stderr.write(`pi-web: failed to listen: ${reason}\n`);
		await runtime.shutdown();
		process.exit(1);
	}

	const address = app.server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	ctx.proxy.protectLocalPort(actualPort);
	const url = displayUrl(host, actualPort);
	ctx.log.info("listening", { host, port: actualPort, version: ctx.version, dev: options.dev });
	process.stdout.write(`\nPi-Web ${ctx.version} is running at ${url}\n`);
	if (ctx.store.getSettings().accessTokenEnabled) {
		const token = await runtime.auth.ensureToken();
		process.stdout.write(`Open this URL to sign in: ${url}?token=${encodeURIComponent(token)}\n`);
	}
	if (options.dev) process.stdout.write("Development mode: the Vite dev server (port 5173) is accepted as origin.\n");
	process.stdout.write("\n");

	await runtime.start();
}

function isMainModule(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isMainModule()) {
	main().catch((err: unknown) => {
		process.stderr.write(`pi-web: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(1);
	});
}
