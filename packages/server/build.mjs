// Bundles the host server into dist/cli.mjs and collects the agent and web builds next to it:
//   dist/cli.mjs   (src/cli.ts; npm dependencies stay external, @pi-web/shared is inlined)
//   dist/agent/    (copy of packages/agent/dist)
//   dist/web/      (copy of packages/web/dist)
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/** Workspace packages that are not published and must be bundled into cli.mjs. */
const BUNDLED = ["@pi-web/shared"];

/** Resolves bundled workspace packages to their sources so `packages: "external"` does not catch them. */
const bundleWorkspacePackages = {
	name: "bundle-workspace-packages",
	setup(b) {
		const escaped = BUNDLED.map((n) => n.replace(/[/\\^$*+?.()|[\]{}-]/g, "\\$&"));
		const filter = new RegExp(`^(${escaped.join("|")})(/.*)?$`);
		b.onResolve({ filter }, (args) => {
			try {
				return { path: fileURLToPath(import.meta.resolve(args.path)), external: false };
			} catch (err) {
				return { errors: [{ text: `cannot resolve ${args.path}: ${err.message}` }] };
			}
		});
	},
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
	entryPoints: [path.join(root, "src/cli.ts")],
	outfile: path.join(dist, "cli.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	plugins: [bundleWorkspacePackages],
	banner: { js: "#!/usr/bin/env node" },
	sourcemap: true,
	legalComments: "none",
	logLevel: "info",
});
chmodSync(path.join(dist, "cli.mjs"), 0o755);

function copyBuild(from, to, label) {
	if (!existsSync(from)) {
		console.warn(`[build] ${label} not built (${path.relative(root, from)} missing); skipping`);
		return;
	}
	cpSync(from, to, { recursive: true });
	console.log(`[build] copied ${label} → ${path.relative(root, to)}`);
}

copyBuild(path.join(root, "../agent/dist"), path.join(dist, "agent"), "agent");
copyBuild(path.join(root, "../web/dist"), path.join(dist, "web"), "web");
