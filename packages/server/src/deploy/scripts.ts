/**
 * Remote POSIX sh scripts used by the deployer. Scripts are fed to `sh -s` on stdin so
 * they do not depend on the user's login shell; every interpolated value is quoted.
 * Output lines meant for the host start with "@@key=value"; anything else (login
 * shell noise) is ignored by the parsers.
 */
import { ENV_SH_KEEP_VAR, shellQuote, type ProbeResult } from "@pi-web/shared";
import { dq } from "../ssh/remote-path.js";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const AGENT_FILES = ["pi-web-agent.mjs", "bridge.mjs", "pi-web-ext.mjs", "VERSION"] as const;
export const MIN_GLIBC = "2.28";
/**
 * Oldest pi the deployer installs: the floor of the @earendil-works/pi-coding-agent dependency
 * range of this package (the version pi-web is built and tested against). Older host versions
 * (or the deprecated @mariozechner scope) fall back to the bundled version.
 */
export const MIN_PI_VERSION = "1.4.0";
/** Written into R at install: uninstall only removes directories that carry it (or a legacy install). */
export const ROOT_MARKER = ".pi-web-root";
/** Everything pi-web creates directly under R (uninstall removes exactly these, then R if empty). */
export const ROOT_ENTRIES = [".upload", ROOT_MARKER, "agent", "bin", "daemon", "daemon.tmp", "logs", "pi", "run", "runtime", "state", "trash"] as const;
/** Container for what uninstall keeps (sessions, sync backups); mode 0700. */
export const BACKUP_CONTAINER = "pi-web-backups";
const MIN_DISK_BYTES = 500 * 1024 * 1024;

/**
 * Normalizes a remote root ("~/x/", "/opt//pi-web/.") and rejects the home directory itself,
 * "/", ".." segments and relative paths. Returns the normalized "~/…" or absolute path.
 */
export function normalizeRemoteRoot(input: string): string {
	const value = input.trim();
	const home = value === "~" || value.startsWith("~/");
	if (!home && !value.startsWith("/")) throw new Error("远端安装目录必须是绝对路径或以 ~/ 开头");
	const rest = home ? value.slice(1) : value;
	const segments = rest.split("/").filter((s) => s !== "" && s !== ".");
	if (segments.includes("..")) throw new Error("远端安装目录不能包含 ..");
	if (segments.length === 0) throw new Error(home ? "远端安装目录不能是家目录本身" : "远端安装目录不能是 /");
	return `${home ? "~" : ""}/${segments.join("/")}`;
}

/** sh snippet: fails (via `$1`) when R is "/", $HOME or one of its parents. */
function rootGuardSnippet(onFail: string): string {
	return [
		'case "$R" in ""|/) ' + onFail + ' ;; esac',
		'case "$HOME/" in "$R"/*) ' + onFail + ' ;; esac',
	].join("\n");
}

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
if [ -e "$R" ] || [ -L "$R" ]; then
  if [ -f "$R/${ROOT_MARKER}" ] || [ -f "$R/daemon/VERSION" ]; then p root_state pi-web
  elif [ ! -d "$R" ]; then p root_state notdir
  elif [ -z "$(ls -A "$R" 2>/dev/null | grep -v '^\\.upload$')" ]; then p root_state empty
  else p root_state foreign; fi
else
  p root_state missing
fi
p long_bit "$(getconf LONG_BIT 2>/dev/null)"
LD=""
for L in /lib64/ld-linux-x86-64.so.2 /lib/ld-linux-aarch64.so.1 /lib/ld-linux-armhf.so.3 /lib/ld-linux.so.2; do
  if [ -e "$L" ]; then LD="$LD$L,"; fi
done
p loaders "$LD"
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

/** ELF interpreter of the official Node.js linux builds. */
const EXPECTED_LOADER: Record<"x64" | "arm64", string> = {
	x64: "/lib64/ld-linux-x86-64.so.2",
	arm64: "/lib/ld-linux-aarch64.so.1",
};

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
	else if (os === "Linux") {
		// `uname -m` reports the kernel: a 64-bit kernel may run a 32-bit userland (Raspberry Pi OS
		// 32-bit on a Pi 4/5, i386/armhf containers), where the official Node.js cannot start.
		const loader = EXPECTED_LOADER[nodeArch];
		const loaders = list(kv.loaders);
		if (kv.long_bit?.trim() === "32") {
			issues.push(`内核是 ${rawArch}，但用户空间是 32 位（getconf LONG_BIT = 32），无法运行官方 ${nodeArch} Node.js`);
		} else if (kv.loaders !== undefined && !loaders.includes(loader)) {
			issues.push(`缺少 ${nodeArch} 的动态链接器 ${loader}（可能是 32 位用户空间或非 glibc 系统），无法运行官方 Node.js`);
		}
	}
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
	const root = result.remoteRoot.replace(/\/+$/, "");
	if (result.home && root && (root === "" || root === result.home.replace(/\/+$/, "") || `${result.home.replace(/\/+$/, "")}/`.startsWith(`${root}/`))) {
		result.issues.push(`远端安装目录 ${root || "/"} 是家目录或其上级目录，请换一个专用目录（例如 ~/.pi-web）`);
	}
	if (kv.root_state === "foreign") {
		result.issues.push(`远端安装目录 ${root} 已存在且不是 Pi-Web 的安装目录（卸载时会删除该目录），请换一个空目录或新目录`);
	} else if (kv.root_state === "notdir") {
		result.issues.push(`远端安装目录 ${root} 已存在且不是目录`);
	}
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

/**
 * pi's CLI script relative to R/pi/<version>, for installs that predate DeployedInfo.piCli
 * (the bin of every supported version). New installs read `bin.pi` from the package.json.
 */
export function piCliRelative(): string {
	return `node_modules/${PI_PACKAGE}/dist/bundle/cli.js`;
}

/** A relative CLI path is interpolated into sh and sed: only plain path characters. */
export function isSafeCliPath(value: string): boolean {
	return /^[A-Za-z0-9@._/-]+$/.test(value) && !value.split("/").includes("..");
}

/**
 * R/bin/pi: the server-level env (run/env.sh, written by the agent) is sourced before proxy.env,
 * so the proxy settings always win. ENV_SH_KEEP_VAR makes it a set of defaults: variables the
 * caller already has (`NAME=x pi`, the env of a conversation running `pi`) are kept.
 */
export function piWrapperScript(params: { remoteRoot: string; agentDir: string; piCli?: string }): string {
	const R = dq(params.remoteRoot);
	const cli = params.piCli ?? piCliRelative();
	return `#!/bin/sh
export PI_CODING_AGENT_DIR="\${PI_CODING_AGENT_DIR:-${dq(params.agentDir)}}"
export PI_OFFLINE="\${PI_OFFLINE:-1}"
if [ -f "${R}/run/env.sh" ]; then ${ENV_SH_KEEP_VAR}=1; . "${R}/run/env.sh"; unset ${ENV_SH_KEEP_VAR}; fi
[ -f "${R}/run/proxy.env" ] && . "${R}/run/proxy.env"
exec "${R}/runtime/current/bin/node" "${R}/pi/current/${cli}" "$@"
`;
}

/** sh lines writing R/bin/pi atomically ($R must be set; the wrapper text is not expanded). */
function wrapperWriteLines(wrapper: string): string[] {
	return [
		'cat > "$R/bin/pi.tmp" <<\'PIWEB_WRAPPER_EOF\'',
		wrapper.trimEnd(),
		"PIWEB_WRAPPER_EOF",
		'chmod 755 "$R/bin/pi.tmp"',
		'mv -f "$R/bin/pi.tmp" "$R/bin/pi"',
	];
}

/**
 * Rewrites R/bin/pi (used by the web terminal and the user's shell) after a setting baked into
 * it changed, e.g. agentDirMode. Prints @@wrapper=ok.
 */
export function wrapperUpdateScript(params: { remoteRoot: string; agentDir: string; piCli?: string }): string {
	if (params.piCli !== undefined && !isSafeCliPath(params.piCli)) throw new Error(`invalid pi CLI path: ${params.piCli}`);
	return `${[
		"set -eu",
		"umask 077",
		`R=${shellQuote(params.remoteRoot)}`,
		'[ -d "$R/bin" ] || { echo "$R/bin is missing" >&2; exit 1; }',
		...wrapperWriteLines(piWrapperScript(params)),
		"printf '@@wrapper=ok\\n'",
	].join("\n")}\n`;
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

const PI_CLI_PLACEHOLDER = "@PI_WEB_PI_CLI@";
/** Prints bin.pi (or the single string bin) of a package.json given as argv[1]. */
const PI_BIN_SCRIPT =
	'const p=require(process.argv[1]);const b=typeof p.bin==="string"?p.bin:p.bin&&p.bin.pi;if(typeof b!=="string"||!b)process.exit(1);console.log(b.replace(/^\\.\\//,""))';

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
		rootGuardSnippet('fail "refusing to install into $R (/, the home directory or one of its parents)"'),
		// Never mix pi-web into an unrelated existing directory: uninstall would remove it.
		`if [ -d "$R" ] && [ ! -f "$R/${ROOT_MARKER}" ] && [ ! -f "$R/daemon/VERSION" ] && [ -n "$(ls -A "$R" 2>/dev/null | grep -v '^\\.upload$')" ]; then`,
		'  rm -rf "$U"',
		'  fail "$R already exists and is not a Pi-Web install directory"',
		"fi",
		'for d in "$R" "$R/runtime" "$R/pi" "$R/daemon" "$R/bin" "$R/run" "$R/logs" "$R/state" "$R/trash" "$AGENT_DIR"; do',
		'  mkdir -p "$d"',
		"done",
		'chmod 700 "$R" "$R/runtime" "$R/pi" "$R/daemon" "$R/bin" "$R/run" "$R/logs" "$R/state" "$R/trash"',
		`[ -f "$R/${ROOT_MARKER}" ] || printf 'pi-web install root\\n' > "$R/${ROOT_MARKER}"`,
	];
	if (params.node) {
		lines.push(
			`${verify(params.node.archive)} ${shellQuote(params.node.sha256)}`,
			'if [ "$FORCE" = 1 ] || [ ! -x "$R/runtime/$NODE_DIR/bin/node" ]; then',
			'  rm -rf "$R/runtime/$NODE_DIR.tmp"',
			'  mkdir -p "$R/runtime/$NODE_DIR.tmp"',
			`  tar -xzmf ${shellQuote(params.node.archive)} -C "$R/runtime/$NODE_DIR.tmp" || fail "failed to extract node"`,
			'  [ -x "$R/runtime/$NODE_DIR.tmp/$NODE_DIR/bin/node" ] || fail "node archive has unexpected layout"',
			'  rm -rf "$R/runtime/$NODE_DIR"',
			'  mv "$R/runtime/$NODE_DIR.tmp/$NODE_DIR" "$R/runtime/$NODE_DIR"',
			'  rm -rf "$R/runtime/$NODE_DIR.tmp"',
			"fi",
		);
	}
	lines.push(
		'[ -x "$R/runtime/$NODE_DIR/bin/node" ] || fail "node runtime $NODE_DIR is not installed"',
		// The executable bit says nothing about the userland (e.g. arm64 Node.js on 32-bit armhf).
		'"$R/runtime/$NODE_DIR/bin/node" -v >/dev/null 2>&1 || fail "Node.js $NODE_DIR cannot run on this server (32-bit userland or missing glibc loader?)"',
		'ln -sfn "$NODE_DIR" "$R/runtime/current"',
	);
	const pkgJson = `node_modules/${PI_PACKAGE}/package.json`;
	if (params.pi) {
		lines.push(
			`${verify(params.pi.archive)} ${shellQuote(params.pi.sha256)}`,
			`if [ "$FORCE" = 1 ] || [ ! -f "$R/pi/$PI_VER/${pkgJson}" ]; then`,
			'  rm -rf "$R/pi/$PI_VER.tmp"',
			'  mkdir -p "$R/pi/$PI_VER.tmp"',
			`  tar -xzmf ${shellQuote(params.pi.archive)} -C "$R/pi/$PI_VER.tmp" || fail "failed to extract pi"`,
			`  [ -f "$R/pi/$PI_VER.tmp/${pkgJson}" ] || fail "pi archive has unexpected layout"`,
			'  rm -rf "$R/pi/$PI_VER"',
			'  mv "$R/pi/$PI_VER.tmp" "$R/pi/$PI_VER"',
			"fi",
		);
	}
	lines.push(
		`[ -f "$R/pi/$PI_VER/${pkgJson}" ] || fail "pi $PI_VER is not installed"`,
		// The CLI script is the package's bin.pi (it moved between pi releases).
		`PI_BIN=$("$R/runtime/$NODE_DIR/bin/node" -e ${shellQuote(PI_BIN_SCRIPT)} "$R/pi/$PI_VER/${pkgJson}") || fail "cannot read bin.pi of pi $PI_VER"`,
		`PI_CLI="node_modules/${PI_PACKAGE}/$PI_BIN"`,
		'case "$PI_CLI" in *[!A-Za-z0-9@._/-]*|*..*) fail "unexpected pi bin path: $PI_CLI" ;; esac',
		'[ -f "$R/pi/$PI_VER/$PI_CLI" ] || fail "pi archive has unexpected layout (missing $PI_CLI)"',
		'ln -sfn "$PI_VER" "$R/pi/current"',
	);
	if (params.agent) {
		lines.push(
			`${verify(params.agent.archive)} ${shellQuote(params.agent.sha256)}`,
			'rm -rf "$R/daemon.tmp"',
			'mkdir -p "$R/daemon.tmp"',
			`tar -xzmf ${shellQuote(params.agent.archive)} -C "$R/daemon.tmp" || fail "failed to extract agent"`,
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
		...wrapperWriteLines(piWrapperScript({ remoteRoot: params.remoteRoot, agentDir: params.agentDir, piCli: PI_CLI_PLACEHOLDER })),
		// PI_CLI only holds plain path characters (checked above): safe in the sed expression.
		`sed "s#${PI_CLI_PLACEHOLDER}#$PI_CLI#" "$R/bin/pi" > "$R/bin/pi.tmp"`,
		'chmod 755 "$R/bin/pi.tmp"',
		'mv -f "$R/bin/pi.tmp" "$R/bin/pi"',
		'rm -rf "$U"',
		"printf '@@pi_cli=%s\\n' \"$PI_CLI\"",
		"printf '@@install=ok\\n'",
	);
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// uninstall / misc
// ---------------------------------------------------------------------------

/**
 * Stops nothing (the deployer shut the daemon down) and removes the install root: only the
 * entries pi-web created, then R itself when empty, and only when R carries the install marker
 * (or the layout of an install that predates it). What is kept — the sessions and the sync
 * backups of the user's own files — goes into ~/pi-web-backups (0700): session files were
 * protected only by R's 0700 mode, and may be world-readable themselves.
 */
export function uninstallScript(params: { remoteRoot: string; keepSessions: boolean; timestamp: string }): string {
	return `set -eu
umask 077
${remoteRootSnippet(params.remoteRoot)}
${rootGuardSnippet('echo "refusing to remove $R" >&2; exit 3')}
if [ ! -e "$R" ]; then
  printf '@@uninstall=ok\\n'
  exit 0
fi
if [ ! -f "$R/${ROOT_MARKER}" ] && [ ! -f "$R/daemon/VERSION" ]; then
  echo "refusing to remove $R: not a Pi-Web install directory" >&2
  exit 3
fi
KEEP=${params.keepSessions ? 1 : 0}
TS=${shellQuote(params.timestamp)}
BK="$HOME/${BACKUP_CONTAINER}"
keep() {
  mkdir -p "$BK"
  chmod 700 "$BK"
  chmod -R go-rwx "$1" 2>/dev/null || true
  mv "$1" "$BK/$2"
}
if [ "$KEEP" = 1 ] && [ -d "$R/agent/sessions" ]; then
  keep "$R/agent/sessions" "sessions-$TS"
  printf '@@backup=%s\\n' "$BK/sessions-$TS"
fi
if [ -d "$R/state/backup" ] && [ -n "$(ls -A "$R/state/backup" 2>/dev/null)" ]; then
  keep "$R/state/backup" "sync-backup-$TS"
  printf '@@sync_backup=%s\\n' "$BK/sync-backup-$TS"
fi
for e in ${ROOT_ENTRIES.map((e) => shellQuote(e)).join(" ")}; do
  rm -rf "$R/$e"
done
rmdir "$R" 2>/dev/null || printf '@@kept_root=%s\\n' "$R"
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
