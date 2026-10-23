/**
 * Rules for user-defined environment variables (server-level `ServerConfig.env` and workspace
 * `WorkspaceConfig.env`), shared by the browser forms and the host's request validation.
 */

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Most variables one map may hold. */
export const MAX_ENV_VARS = 100;
/** Largest value, in UTF-8 bytes. */
export const MAX_ENV_VALUE_BYTES = 32 * 1024;
/** Longest name. */
export const MAX_ENV_NAME_LENGTH = 256;
/**
 * Largest map, as the UTF-8 size of its NAME=value strings: the server and workspace maps are
 * merged into every pi process environment, which execve caps at about 2 MiB in total.
 */
export const MAX_ENV_TOTAL_BYTES = 256 * 1024;

export const ENV_NAME_LENGTH_ERROR = `变量名不能超过 ${MAX_ENV_NAME_LENGTH} 个字符`;
export const ENV_TOTAL_ERROR = `环境变量总大小不能超过 ${MAX_ENV_TOTAL_BYTES / 1024} KiB`;

/** Proxy variables Pi-Web sets itself (rejected in any letter case). */
const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
/**
 * Read-only in bash: exporting one in run/env.sh aborts R/bin/pi where /bin/sh is bash
 * (POSIX mode exits on the failed assignment).
 */
const SHELL_READONLY_NAMES = ["UID", "EUID", "PPID", "SHELLOPTS", "BASHOPTS", "BASH_VERSINFO"];

/** Why a name cannot be set by the user (managed by Pi-Web, or read-only in the shell), or null. */
export function reservedEnvReason(name: string): string | null {
	if (PROXY_ENV_NAMES.includes(name.toUpperCase())) return `${name} 由 Pi-Web 管理，请在服务器设置的“LLM 代理”中配置`;
	if (name === "PI_CODING_AGENT_DIR") return "PI_CODING_AGENT_DIR 由服务器设置中的“Agent 目录”决定，不能在此设置";
	if (SHELL_READONLY_NAMES.includes(name)) return `${name} 是 shell 只读变量，不能设置`;
	return null;
}

/** Problem with a variable name (as typed, already trimmed), or null when it can be used. */
export function envNameError(name: string): string | null {
	if (!name) return "请填写变量名";
	if (!ENV_NAME_PATTERN.test(name)) return "变量名只能包含字母、数字和下划线，且不能以数字开头";
	if (name.length > MAX_ENV_NAME_LENGTH) return ENV_NAME_LENGTH_ERROR;
	return reservedEnvReason(name);
}

/** UTF-8 size of a string (a lone surrogate counts as the 3 bytes of U+FFFD). */
export function utf8Length(value: string): number {
	let bytes = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

/** Size one variable adds to a process environment ("NAME=value"). */
export function envEntryBytes(name: string, value: string): number {
	return utf8Length(name) + 1 + utf8Length(value);
}

/** Problem with a value, phrased to follow "变量值" / "环境变量 X 的值", or null. */
export function envValueError(value: string): string | null {
	if (value.includes("\0")) return "不能包含 NUL 字符";
	if (utf8Length(value) > MAX_ENV_VALUE_BYTES) return "不能超过 32 KiB";
	return null;
}

export const ENV_COUNT_ERROR = `环境变量最多 ${MAX_ENV_VARS} 个`;

/**
 * Shell variable R/bin/pi sets while sourcing R/run/env.sh: the file then only exports variables
 * the caller's environment does not already have (the web terminal sources it without).
 */
export const ENV_SH_KEEP_VAR = "_piweb_keep_env";

/**
 * Validates a whole name → value map (e.g. a request body field). Errors are complete
 * sentences naming the offending variable.
 */
export function validateEnvMap(value: Record<string, unknown>): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
	const entries = Object.entries(value);
	if (entries.length > MAX_ENV_VARS) return { ok: false, error: ENV_COUNT_ERROR };
	const env: Record<string, string> = {};
	let total = 0;
	for (const [name, v] of entries) {
		if (name.length > MAX_ENV_NAME_LENGTH) return { ok: false, error: `环境${ENV_NAME_LENGTH_ERROR}` };
		if (!ENV_NAME_PATTERN.test(name)) return { ok: false, error: `环境变量名无效：${name}` };
		const reserved = reservedEnvReason(name);
		if (reserved) return { ok: false, error: reserved };
		if (typeof v !== "string") return { ok: false, error: `环境变量 ${name} 的值必须是字符串` };
		const problem = envValueError(v);
		if (problem) return { ok: false, error: `环境变量 ${name} 的值${problem}` };
		total += envEntryBytes(name, v);
		if (total > MAX_ENV_TOTAL_BYTES) return { ok: false, error: ENV_TOTAL_ERROR };
		env[name] = v;
	}
	return { ok: true, env };
}
