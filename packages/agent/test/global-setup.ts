import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Builds dist/ once so the e2e and real-pi tests run the bundled daemon, bridge and extension. */
export default function setup(): void {
	const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
	execFileSync(process.execPath, [join(pkgDir, "build.mjs")], { cwd: pkgDir, stdio: "inherit" });
}
