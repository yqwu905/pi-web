/**
 * Remote POSIX sh scripts used by the deployer. Scripts are fed to `sh -s` on stdin so
 * they do not depend on the user's login shell; every interpolated value is quoted.
 * Output lines meant for the host start with "@@key=value"; anything else (login
 * shell noise) is ignored by the parsers.
 */
import { shellQuote, type ProbeResult } from "@pi-web/shared";
import { dq } from "../ssh/remote-path.js";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const AGENT_FILES = ["pi-web-agent.mjs", "bridge.mjs", "pi-web-ext.mjs", "VERSION"] as const;
export const MIN_GLIBC = "2.28";
const MIN_DISK_BYTES = 500 * 1024 * 1024;

/** sh snippet that sets $R to the absolute remote root (expanding a leading "~"). */
function remoteRootSnippet(remoteRoot: string): string {
	return [
		`R_IN=${shellQuote(remoteRoot)}`,
		'case "$R_IN" in',
		'  "~") R="$HOME" ;;',
		'  "~/"*) R="$HOME/${R_IN#"~/"}" ;;',
		'  /*) R="$R_IN" ;;',
		'  *) R="$HOME/$R_IN" ;;',
		"esac",
		'R="${R%/}"',
	].join("\n");
}

export function probeScript(remoteRoot: string): string {
	return `${remoteRootSnippet(remoteRoot)}
p() { printf '@@%s=%s\\n' "$1" "$2"; }
has() { command -v "$1" >/dev/null 2>&1 && echo 1 || echo 0; }
p os "$(uname -s 2>/dev/null)"
p arch "$(uname -m 2>/dev/null)"
p kernel "$(uname -r 2>/dev/null)"
p home "$HOME"
p shell "\${SHELL:-}"
p root "$R"
G=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
if [ -z "$G" ]; then
  G=$(ldd --version 2>&1 | sed -n '1s/.* \\([0-9][0-9]*\\.[0-9][0-9]*\\).*/\\1/p')
fi
p glibc "$G"
p tar "$(has tar)"
p gzip "$(has gzip)"
p curl "$(has curl)"
p sha256sum "$(has sha256sum)"
p df_kb "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
p agent_version "$(cat "$R/daemon/VERSION" 2>/dev/null | head -n 1)"
p pi_current "$(readlink "$R/pi/current" 2>/dev/null)"
p node_current "$(readlink "$R/runtime/current" 2>/dev/null)"
p pi_versions "$(ls -1 "$R/pi" 2>/dev/null | grep -v -e '^current$' -e '\\.tmp$' | tr '\\n' ',')"
p node_versions "$(ls -1 "$R/runtime" 2>/dev/null | grep -v -e '^current$' -e '\\.tmp$' | tr '\\n' ',')"
if command -v curl >/dev/null 2>&1; then
  if OUT=$(curl -sS -m 5 -o /dev/null https://api.anthropic.com 2>&1); then
    p internet 1
  else
    p internet 0
    p internet_detail "$(printf '%s' "$OUT" | head -n 1)"
  fi
elif command -v timeout >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then
  if timeout 5 bash -c 'exec 3<>/dev/tcp/api.anthropic.com/443' >/dev/null 2>&1; then
    p internet 1
  else
    p internet 0
    p internet_detail "tcp connect to api.anthropic.com:443 failed"
  fi
else
  p internet 0
  p internet_detail "no curl or bash available to test"
fi
p done 1
`;
}

/** Parses "@@key=value" lines (later keys win; other lines ignored). */
export function parseKeyValues(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^@@([A-Za-z0-9_]+)=(.*)$/.exec(line);
		if (match) out[match[1]] = match[2];
	}
	return out;
}

export function mapArch(raw: string): "x64" | "arm64" | null {
	const value = raw.trim().toLowerCase();
	if (value === "x86_64" || value === "amd64") return "x64";
	if (value === "aarch64" || value === "arm64") return "arm64";
	return null;
}

/** Compares dotted numeric versions ("2.28" vs "2.31.1"). */
export function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Probe result plus details the deployer needs (absolute root, installed versions). */
export interface RemoteProbe extends ProbeResult {
	/** Absolute remote root ("~" expanded). */
	remoteRoot: string;
	/** Mapped arch when supported. */
	nodeArch: "x64" | "arm64" | null;
	installed: { pi: string[]; node: string[] };
	hasSha256sum: boolean;
	hasCurl: boolean;
}

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
}

/** "node-v22.20.0-linux-x64" → "22.20.0" */
export function nodeVersionFromDir(dir: string): string | undefined {
	return /^node-v(\d+\.\d+\.\d+)-linux-/.exec(dir.trim())?.[1];
}

export function parseProbeOutput(stdout: string, sftp: boolean): RemoteProbe {
	const kv = parseKeyValues(stdout);
	if (kv.done !== "1") {
		throw new Error(`probe output incomplete: ${stdout.slice(-500)}`);
	}
	const os = kv.os ?? "";
	const rawArch = kv.arch ?? "";
	const nodeArch = mapArch(rawArch);
	const glibc = kv.glibc?.trim() || undefined;
	const glibcOk = !!glibc && compareVersions(glibc, MIN_GLIBC) >= 0;
	const dfKb = Number.parseInt(kv.df_kb ?? "", 10);
	const diskFreeBytes = Number.isFinite(dfKb) ? dfKb * 1024 : undefined;
	const hasTar = kv.tar === "1";
	const hasGzip = kv.gzip === "1";
	const issues: string[] = [];
	const warnings: string[] = [];
	if (os !== "Linux") issues.push(`不支持的操作系统：${os || "未知"}（仅支持 Linux）`);
	if (!nodeArch) issues.push(`不支持的 CPU 架构：${rawArch || "未知"}（仅支持 x86_64 / aarch64）`);
	if (!glibc) issues.push("未检测到 glibc（可能是 musl 系统），无法运行官方 Node.js");
	else if (!glibcOk) issues.push(`glibc 版本过低：${glibc}（需要 ≥ ${MIN_GLIBC}）`);
	if (!hasTar) issues.push("服务器缺少 tar 命令");
	if (!hasGzip) issues.push("服务器缺少 gzip 命令");
	if (diskFreeBytes !== undefined && diskFreeBytes < MIN_DISK_BYTES) {
		warnings.push(`家目录所在磁盘可用空间不足 500 MB（剩余 ${Math.round(diskFreeBytes / 1024 / 1024)} MB）`);
	}
	if (!sftp) warnings.push("SFTP 不可用，将通过 exec 通道传输文件（速度较慢）");
	const existing: NonNullable<ProbeResult["existing"]> = {};
	if (kv.agent_version) existing.agentVersion = kv.agent_version.trim();
	if (kv.pi_current) existing.piVersion = kv.pi_current.trim();
	const nodeVersion = kv.node_current ? nodeVersionFromDir(kv.node_current) : undefined;
	if (nodeVersion) existing.nodeVersion = nodeVersion;
	const internet = { reachable: kv.internet === "1", ...(kv.internet_detail ? { detail: kv.internet_detail } : {}) };
	const result: RemoteProbe = {
		os,
		arch: nodeArch ?? rawArch,
		supportedArch: nodeArch !== null,
		...(kv.kernel ? { kernel: kv.kernel } : {}),
		...(glibc ? { glibc } : {}),
		glibcOk,
		home: kv.home ?? "",
		...(kv.shell ? { shell: kv.shell } : {}),
		...(diskFreeBytes !== undefined ? { diskFreeBytes } : {}),
		hasTar,
		hasGzip,
		sftp,
		internet,
		...(Object.keys(existing).length > 0 ? { existing } : {}),
		issues,
		warnings,
		remoteRoot: kv.root ?? "",
		nodeArch,
		installed: { pi: list(kv.pi_versions), node: list(kv.node_versions) },
		hasSha256sum: kv.sha256sum === "1",
		hasCurl: kv.curl === "1",
	};
	if (!result.home) result.issues.push("无法确定远程 $HOME");
	return result;
}

/** Strips the deployer-internal fields so only the API's ProbeResult is returned. */
export function toProbeResult(probe: RemoteProbe): ProbeResult {
	const { remoteRoot: _r, nodeArch: _a, installed: _i, hasSha256sum: _s, hasCurl: _c, ...rest } = probe;
	return rest;
}

// ---------------------------------------------------------------------------
// bin/pi wrapper
// ---------------------------------------------------------------------------

export function piCliRelative(): string {
	return `node_modules/${PI_PACKAGE}/dist/bundle/cli.js`;
}

export function piWrapperScript(params: { remoteRoot: string; agentDir: string }): string {
	const R = dq(params.remoteRoot);
	return `#!/bin/sh
export PI_CODING_AGENT_DIR="\${PI_CODING_AGENT_DIR:-${dq(params.agentDir)}}"
export PI_OFFLINE="\${PI_OFFLINE:-1}"
[ -f "${R}/run/proxy.env" ] && . "${R}/run/proxy.env"
exec "${R}/runtime/current/bin/node" "${R}/pi/current/${piCliRelative()}" "$@"
`;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export interface InstallComponent {
	/** Uploaded archive (absolute remote path). */
	archive: string;
	sha256: string;
}

export interface InstallParams {
	/** Absolute remote root. */
	remoteRoot: string;
	agentDir: string;
	/** e.g. "node-v22.20.0-linux-x64" (the tarball's top-level directory). */
	nodeDir: string;
	piVersion: string;
	node?: InstallComponent;
	pi?: InstallComponent;
	agent?: InstallComponent;
	/** Replace version directories even when they already exist. */
	force: boolean;
}

/**
 * Installs uploaded components: verifies checksums, extracts into "<dir>.tmp" then
 * renames, points the `current` symlinks, writes bin/pi and removes R/.upload.
 * Existing version directories are kept unless `force`.
 */
export function installScript(params: InstallParams): string {
	const verify = (file: string) => `verify ${shellQuote(file)}`;
	const lines: string[] = [
		"set -eu",
		"umask 077",
		`R=${shellQuote(params.remoteRoot)}`,
		`AGENT_DIR=${shellQuote(params.agentDir)}`,
		`NODE_DIR=${shellQuote(params.nodeDir)}`,
		`PI_VER=${shellQuote(params.piVersion)}`,
		`FORCE=${params.force ? 1 : 0}`,
		'U="$R/.upload"',
		'fail() { printf \'@@error=%s\\n\' "$1"; echo "$1" >&2; exit 1; }',
		"sum() {",
		'  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk \'{print $1}\';',
		'  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk \'{print $1}\';',
		"  else echo skip; fi",
		"}",
		"verify() {",
		'  ACTUAL=$(sum "$1")',
		'  if [ "$ACTUAL" != skip ] && [ "$ACTUAL" != "$2" ]; then fail "checksum mismatch for $1"; fi',
		"}",
		'for d in "$R" "$R/runtime" "$R/pi" "$R/daemon" "$R/bin" "$R/run" "$R/logs" "$R/state" "$R/trash" "$AGENT_DIR"; do',
		'  mkdir -p "$d"',
		"done",
		'chmod 700 "$R" "$R/runtime" "$R/pi" "$R/daemon" "$R/bin" "$R/run" "$R/logs" "$R/state" "$R/trash"',
	];
	if (params.node) {
		lines.push(
			`${verify(params.node.archive)} ${shellQuote(params.node.sha256)}`,
			'if [ "$FORCE" = 1 ] || [ ! -x "$R/runtime/$NODE_DIR/bin/node" ]; then',
			'  rm -rf "$R/runtime/$NODE_DIR.tmp"',
			'  mkdir -p "$R/runtime/$NODE_DIR.tmp"',
			`  tar -xzf ${shellQuote(params.node.archive)} -C "$R/runtime/$NODE_DIR.tmp" || fail "failed to extract node"`,
			'  [ -x "$R/runtime/$NODE_DIR.tmp/$NODE_DIR/bin/node" ] || fail "node archive has unexpected layout"',
			'  rm -rf "$R/runtime/$NODE_DIR"',
			'  mv "$R/runtime/$NODE_DIR.tmp/$NODE_DIR" "$R/runtime/$NODE_DIR"',
			'  rm -rf "$R/runtime/$NODE_DIR.tmp"',
			"fi",
		);
	}
	lines.push(
		'[ -x "$R/runtime/$NODE_DIR/bin/node" ] || fail "node runtime $NODE_DIR is not installed"',
		'ln -sfn "$NODE_DIR" "$R/runtime/current"',
	);
	if (params.pi) {
		lines.push(
			`${verify(params.pi.archive)} ${shellQuote(params.pi.sha256)}`,
			`if [ "$FORCE" = 1 ] || [ ! -f "$R/pi/$PI_VER/${piCliRelative()}" ]; then`,
			'  rm -rf "$R/pi/$PI_VER.tmp"',
			'  mkdir -p "$R/pi/$PI_VER.tmp"',
			`  tar -xzf ${shellQuote(params.pi.archive)} -C "$R/pi/$PI_VER.tmp" || fail "failed to extract pi"`,
			`  [ -f "$R/pi/$PI_VER.tmp/${piCliRelative()}" ] || fail "pi archive has unexpected layout"`,
			'  rm -rf "$R/pi/$PI_VER"',
			'  mv "$R/pi/$PI_VER.tmp" "$R/pi/$PI_VER"',
			"fi",
		);
	}
	lines.push(
		`[ -f "$R/pi/$PI_VER/${piCliRelative()}" ] || fail "pi $PI_VER is not installed"`,
		'ln -sfn "$PI_VER" "$R/pi/current"',
	);
	if (params.agent) {
		lines.push(
			`${verify(params.agent.archive)} ${shellQuote(params.agent.sha256)}`,
			'rm -rf "$R/daemon.tmp"',
			'mkdir -p "$R/daemon.tmp"',
			`tar -xzf ${shellQuote(params.agent.archive)} -C "$R/daemon.tmp" || fail "failed to extract agent"`,
			`for f in ${AGENT_FILES.join(" ")}; do`,
			'  [ -f "$R/daemon.tmp/$f" ] || fail "agent archive is missing $f"',
			"done",
			`for f in ${AGENT_FILES.join(" ")}; do`,
			'  mv -f "$R/daemon.tmp/$f" "$R/daemon/$f"',
			"done",
			'rm -rf "$R/daemon.tmp"',
		);
	}
	lines.push(
		'cat > "$R/bin/pi.tmp" <<\'PIWEB_WRAPPER_EOF\'',
		piWrapperScript({ remoteRoot: params.remoteRoot, agentDir: params.agentDir }).trimEnd(),
		"PIWEB_WRAPPER_EOF",
		'chmod 755 "$R/bin/pi.tmp"',
		'mv -f "$R/bin/pi.tmp" "$R/bin/pi"',
		'rm -rf "$U"',
		"printf '@@install=ok\\n'",
	);
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// uninstall / misc
// ---------------------------------------------------------------------------

export function uninstallScript(params: { remoteRoot: string; keepSessions: boolean; timestamp: string }): string {
	return `set -eu
${remoteRootSnippet(params.remoteRoot)}
case "$R" in
  ""|/|"$HOME"|"$HOME/") echo "refusing to remove $R" >&2; exit 3 ;;
esac
KEEP=${params.keepSessions ? 1 : 0}
TS=${shellQuote(params.timestamp)}
if [ "$KEEP" = 1 ] && [ -d "$R/agent/sessions" ]; then
  B="$HOME/pi-web-sessions-backup-$TS"
  mv "$R/agent/sessions" "$B"
  printf '@@backup=%s\\n' "$B"
fi
rm -rf "$R"
printf '@@uninstall=ok\\n'
`;
}

/**
 * Node one-liner run on the server: opens the agent's proxy listener and issues a
 * CONNECT for `target`, printing the status line. The token is read from stdin so it
 * never shows up in a process listing.
 */
export const PROXY_CHECK_SCRIPT = [
	'const net=require("net");let t="";',
	'process.stdin.on("data",d=>t+=d);',
	'process.stdin.on("end",()=>{',
	"const port=+process.argv[1],target=process.argv[2];",
	'const s=net.connect(port,"127.0.0.1",()=>{s.write("CONNECT "+target+" HTTP/1.1\\r\\nHost: "+target+"\\r\\nProxy-Authorization: Basic "+Buffer.from("pw:"+t.trim()).toString("base64")+"\\r\\n\\r\\n")});',
	'let b="";',
	's.on("data",d=>{b+=d;const i=b.indexOf("\\r\\n");if(i>=0){console.log(b.slice(0,i));s.destroy();process.exit(0)}});',
	's.on("error",e=>{console.log("ERROR "+e.message);process.exit(0)});',
	's.on("close",()=>{if(!b){console.log("ERROR connection closed");process.exit(0)}});',
	'setTimeout(()=>{console.log("ERROR timeout");process.exit(0)},15000).unref();',
	"});",
].join("");

export function proxyCheckCommand(nodePath: string, port: number, target = "api.anthropic.com:443"): string {
	return `${shellQuote(nodePath)} -e ${shellQuote(PROXY_CHECK_SCRIPT)} ${port} ${shellQuote(target)}`;
}

/** Waits (up to `timeoutSec`) for a pid to exit; prints @@exited=1|0. */
export function waitPidScript(pid: number, timeoutSec: number): string {
	const n = Math.max(1, Math.round(timeoutSec * 5));
	return `PID=${Math.floor(pid)}
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -ge ${n} ]; then printf '@@exited=0\\n'; exit 0; fi
  sleep 0.2
done
printf '@@exited=1\\n'
`;
}
