// Bundles the remote agent into three self-contained ESM files (no runtime dependencies):
//   dist/pi-web-agent.mjs  daemon
//   dist/bridge.mjs        stdio <-> unix socket bridge
//   dist/pi-web-ext.mjs    pi companion extension
// plus dist/VERSION (package.json version, also injected as __AGENT_VERSION__).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildAgent(outdir = join(here, "dist")) {
	const pkg = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
	const version = String(pkg.version);
	await mkdir(outdir, { recursive: true });
	const entries = [
		["src/daemon/main.ts", "pi-web-agent.mjs"],
		["src/bridge.ts", "bridge.mjs"],
		["src/companion-ext.ts", "pi-web-ext.mjs"],
	];
	await Promise.all(
		entries.map(([entry, out]) =>
			build({
				absWorkingDir: here,
				entryPoints: [join(here, entry)],
				outfile: join(outdir, out),
				bundle: true,
				platform: "node",
				target: "node22",
				format: "esm",
				sourcemap: false,
				minify: false,
				legalComments: "none",
				logLevel: "warning",
				define: { __AGENT_VERSION__: JSON.stringify(version) },
			}),
		),
	);
	await writeFile(join(outdir, "VERSION"), `${version}\n`);
	return { outdir, version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	buildAgent().then(
		({ outdir, version }) => console.log(`built @pi-web/agent ${version} -> ${outdir}`),
		(err) => {
			console.error(err);
			process.exit(1);
		},
	);
}
