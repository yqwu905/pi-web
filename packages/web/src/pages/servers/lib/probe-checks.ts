/** Maps a ProbeResult to the rows of the "环境探测" list (wizard step 3, proxy test). */
import type { ProbeResult } from "@pi-web/shared";
import { formatBytes } from "../../../lib/format";

export type CheckStatus = "pass" | "warn" | "fail";

export interface ProbeCheck {
	key: "system" | "glibc" | "home" | "tar" | "sftp" | "internet" | "existing" | "shell";
	label: string;
	status: CheckStatus;
	/** Main value ("Linux x86_64", "2.35"). */
	value: string;
	/** Gray text after the value ("（要求 ≥ 2.28）"). */
	hint?: string;
	/** Highlighted follow-up ("→ 建议开启隧道代理…"). */
	suggestion?: string;
	/** The read-only command shown on the right. */
	command: string;
}

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = { pass: "通过", warn: "提示", fail: "失败" };

/** Below this much free space in $HOME a deploy (≈ 120 MB unpacked per version) is risky. */
export const LOW_DISK_BYTES = 512 * 1024 * 1024;

export function probeChecks(p: ProbeResult): ProbeCheck[] {
	const checks: ProbeCheck[] = [];
	const linux = p.os.toLowerCase() === "linux";
	checks.push({
		key: "system",
		label: "系统",
		status: linux && p.supportedArch ? "pass" : "fail",
		value: `${p.os} ${p.arch}`.trim(),
		hint: linux && p.supportedArch ? (p.kernel ? ` · 内核 ${p.kernel}` : undefined) : "（仅支持 Linux x64 / arm64）",
		command: "uname -sm",
	});
	checks.push({
		key: "glibc",
		label: "glibc",
		status: p.glibcOk ? "pass" : "fail",
		value: p.glibc ?? "未检测到",
		hint: "（要求 ≥ 2.28）",
		command: "getconf GNU_LIBC_VERSION",
	});
	const lowDisk = p.diskFreeBytes !== undefined && p.diskFreeBytes < LOW_DISK_BYTES;
	checks.push({
		key: "home",
		label: "家目录",
		status: p.home ? (lowDisk ? "warn" : "pass") : "fail",
		value: p.home || "未知",
		hint: p.diskFreeBytes !== undefined ? ` · 磁盘可用 ${formatBytes(p.diskFreeBytes)}` : undefined,
		suggestion: lowDisk ? "→ 磁盘空间偏少，部署需要约 150 MB" : undefined,
		command: "df -Pk $HOME",
	});
	const missing = [!p.hasTar && "tar", !p.hasGzip && "gzip"].filter(Boolean) as string[];
	checks.push({
		key: "tar",
		label: "tar / gzip",
		status: missing.length ? "fail" : "pass",
		value: missing.length ? `缺少 ${missing.join("、")}` : "可用",
		command: "command -v tar gzip",
	});
	checks.push({
		key: "sftp",
		label: "SFTP 子系统",
		status: p.sftp ? "pass" : "warn",
		value: p.sftp ? "可用" : "不可用",
		suggestion: p.sftp ? undefined : "→ 将改用 SSH exec 流式上传，速度略慢",
		command: "sftp",
	});
	checks.push({
		key: "internet",
		label: "外网访问",
		status: p.internet.reachable ? "pass" : "warn",
		value: p.internet.reachable ? "可直接访问 api.anthropic.com" : "无法访问 api.anthropic.com",
		hint: p.internet.detail ? ` · ${p.internet.detail}` : undefined,
		suggestion: p.internet.reachable ? undefined : "→ 建议开启隧道代理，LLM 请求经 Host 发出",
		command: "curl -sI https://api.anthropic.com",
	});
	const ex = p.existing;
	const existingParts = ex
		? [ex.piVersion && `pi ${ex.piVersion}`, ex.nodeVersion && `Node ${ex.nodeVersion}`, ex.agentVersion && `agent ${ex.agentVersion}`].filter(Boolean)
		: [];
	checks.push({
		key: "existing",
		label: "已有安装",
		status: "pass",
		value: existingParts.length ? `已安装 ${existingParts.join(" · ")}` : "未发现 ~/.pi-web",
		hint: existingParts.length ? "，相同版本将复用" : "，将全新安装",
		command: "ls ~/.pi-web",
	});
	checks.push({
		key: "shell",
		label: "默认 shell",
		status: "pass",
		value: p.shell || "未知",
		command: "echo $SHELL",
	});
	return checks;
}

export interface ProbeSummary {
	pass: number;
	warn: number;
	fail: number;
	/** Deploy must not start (host-reported issues or failed checks). */
	blocking: boolean;
}

export function probeSummary(p: ProbeResult, checks: readonly ProbeCheck[] = probeChecks(p)): ProbeSummary {
	const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
	const fail = count("fail");
	return { pass: count("pass"), warn: count("warn") + p.warnings.length, fail: fail + p.issues.length, blocking: fail > 0 || p.issues.length > 0 };
}

/** Recommended proxy mode for the deploy step: tunnel when the server cannot reach the internet. */
export function recommendedProxyMode(p: ProbeResult | undefined): "tunnel" | "off" {
	return p && p.internet.reachable ? "off" : "tunnel";
}
