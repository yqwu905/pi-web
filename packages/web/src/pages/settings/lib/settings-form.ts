/**
 * Global settings form (pure): HostSettings ⇄ editable strings, validation and the minimal
 * UpdateSettingsRequest. Optional strings are cleared by sending "" (accepted by the host).
 */
import { DEFAULT_HOST_SETTINGS, type HostSettings, type UpdateSettingsRequest } from "@pi-web/shared";

export interface SettingsForm {
	nodeSource: HostSettings["nodeSource"];
	nodeCustomBaseUrl: string;
	/** "latest-22" or an exact version. */
	nodeVersion: string;
	archX64: boolean;
	archArm64: boolean;
	piVersionPolicy: HostSettings["piVersionPolicy"];
	piPinnedVersion: string;
	npmRegistry: string;
	prunePrebuilds: boolean;
	upstreamProxy: string;
	portFrom: string;
	portTo: string;
	defaultNoProxyText: string;
	listenHost: string;
	listenPort: string;
	accessTokenEnabled: boolean;
	hostAgentDir: string;
}

export type SettingsFormField = keyof SettingsForm;
export type SettingsFormErrors = Partial<Record<SettingsFormField, string>>;

export const LATEST_NODE = "latest-22";
/** pi ≥ 1.4 requires Node ≥ 22.19. */
export const MIN_NODE_VERSION = "22.19.0";
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function formFromSettings(s: HostSettings): SettingsForm {
	return {
		nodeSource: s.nodeSource,
		nodeCustomBaseUrl: s.nodeCustomBaseUrl ?? "",
		nodeVersion: s.nodeVersion,
		archX64: s.targetArchs.includes("x64"),
		archArm64: s.targetArchs.includes("arm64"),
		piVersionPolicy: s.piVersionPolicy,
		piPinnedVersion: s.piPinnedVersion ?? "",
		npmRegistry: s.npmRegistry ?? "",
		prunePrebuilds: s.prunePrebuilds,
		upstreamProxy: s.upstreamProxy ?? "",
		portFrom: String(s.proxyPortRange[0]),
		portTo: String(s.proxyPortRange[1]),
		defaultNoProxyText: s.defaultNoProxy.join(","),
		listenHost: s.listenHost,
		listenPort: String(s.listenPort),
		accessTokenEnabled: s.accessTokenEnabled,
		hostAgentDir: s.hostAgentDir ?? "",
	};
}

/** Defaults for "恢复默认"; the host agent dir override is kept (it is not a policy default). */
export function defaultForm(current: SettingsForm): SettingsForm {
	return { ...formFromSettings(DEFAULT_HOST_SETTINGS), hostAgentDir: current.hostAgentDir };
}

/** Compares dotted numeric versions ("22.20.0" vs "22.19.0"); pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
	const pb = b.replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

export function isHttpUrl(text: string): boolean {
	try {
		const url = new URL(text);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function intIn(text: string, min: number, max: number): number | null {
	const t = text.trim();
	if (!/^\d+$/.test(t)) return null;
	const n = Number(t);
	return n >= min && n <= max ? n : null;
}

export function parseNoProxy(text: string): string[] {
	const out: string[] = [];
	for (const part of text.split(/[\s,]+/)) if (part && !out.includes(part)) out.push(part);
	return out;
}

export function validateSettingsForm(f: SettingsForm): SettingsFormErrors {
	const e: SettingsFormErrors = {};
	if (f.nodeSource === "custom") {
		if (!f.nodeCustomBaseUrl.trim()) e.nodeCustomBaseUrl = "请填写自定义下载地址";
		else if (!isHttpUrl(f.nodeCustomBaseUrl.trim())) e.nodeCustomBaseUrl = "下载地址必须是 http(s) URL";
	} else if (f.nodeCustomBaseUrl.trim() && !isHttpUrl(f.nodeCustomBaseUrl.trim())) {
		e.nodeCustomBaseUrl = "下载地址必须是 http(s) URL";
	}
	const nv = f.nodeVersion.trim().replace(/^v/, "");
	if (nv !== LATEST_NODE) {
		if (!VERSION.test(nv)) e.nodeVersion = "版本格式无效，例如 22.20.0";
		else if (compareVersions(nv, MIN_NODE_VERSION) < 0) e.nodeVersion = `pi 需要 Node ≥ ${MIN_NODE_VERSION}`;
	}
	if (!f.archX64 && !f.archArm64) e.archX64 = "至少选择一个目标平台";
	if (f.piVersionPolicy === "pinned") {
		const pv = f.piPinnedVersion.trim().replace(/^v/, "");
		if (!pv) e.piPinnedVersion = "请填写 pi 版本";
		else if (!VERSION.test(pv)) e.piPinnedVersion = "版本格式无效，例如 1.4.0";
	}
	if (f.npmRegistry.trim() && !isHttpUrl(f.npmRegistry.trim())) e.npmRegistry = "registry 必须是 http(s) URL";
	if (f.upstreamProxy.trim() && !isHttpUrl(f.upstreamProxy.trim())) e.upstreamProxy = "上游代理必须是 http(s) 地址，例如 http://proxy:3128";
	const from = intIn(f.portFrom, 1024, 65535);
	const to = intIn(f.portTo, 1024, 65535);
	if (from === null) e.portFrom = "端口应为 1024–65535";
	if (to === null) e.portTo = "端口应为 1024–65535";
	if (from !== null && to !== null && from > to) e.portTo = "结束端口不能小于起始端口";
	const host = f.listenHost.trim();
	if (!host) e.listenHost = "请填写监听地址";
	else if (/\s/.test(host)) e.listenHost = "监听地址不能包含空格";
	if (intIn(f.listenPort, 1, 65535) === null) e.listenPort = "端口应为 1–65535";
	const dir = f.hostAgentDir.trim();
	if (dir && !dir.startsWith("/") && !dir.startsWith("~")) e.hostAgentDir = "必须是绝对路径或以 ~ 开头";
	return e;
}

/** Only the changed keys; call after validation passes. */
export function buildSettingsPatch(base: SettingsForm, f: SettingsForm): UpdateSettingsRequest {
	const patch: UpdateSettingsRequest = {};
	const str = (k: "nodeCustomBaseUrl" | "piPinnedVersion" | "npmRegistry" | "upstreamProxy" | "hostAgentDir") => {
		const v = f[k].trim();
		if (v !== base[k].trim()) patch[k] = k === "piPinnedVersion" ? v.replace(/^v/, "") : v;
	};
	if (f.nodeSource !== base.nodeSource) patch.nodeSource = f.nodeSource;
	str("nodeCustomBaseUrl");
	const nv = f.nodeVersion.trim().replace(/^v/, "");
	if (nv !== base.nodeVersion.trim().replace(/^v/, "")) patch.nodeVersion = nv;
	if (f.archX64 !== base.archX64 || f.archArm64 !== base.archArm64) {
		patch.targetArchs = [...(f.archX64 ? (["x64"] as const) : []), ...(f.archArm64 ? (["arm64"] as const) : [])];
	}
	if (f.piVersionPolicy !== base.piVersionPolicy) patch.piVersionPolicy = f.piVersionPolicy;
	str("piPinnedVersion");
	str("npmRegistry");
	if (f.prunePrebuilds !== base.prunePrebuilds) patch.prunePrebuilds = f.prunePrebuilds;
	str("upstreamProxy");
	if (f.portFrom.trim() !== base.portFrom.trim() || f.portTo.trim() !== base.portTo.trim()) {
		patch.proxyPortRange = [Number(f.portFrom.trim()), Number(f.portTo.trim())];
	}
	const noProxy = parseNoProxy(f.defaultNoProxyText);
	if (noProxy.join(",") !== parseNoProxy(base.defaultNoProxyText).join(",")) patch.defaultNoProxy = noProxy;
	if (f.listenHost.trim() !== base.listenHost.trim()) patch.listenHost = f.listenHost.trim();
	if (f.listenPort.trim() !== base.listenPort.trim()) patch.listenPort = Number(f.listenPort.trim());
	if (f.accessTokenEnabled !== base.accessTokenEnabled) patch.accessTokenEnabled = f.accessTokenEnabled;
	str("hostAgentDir");
	return patch;
}

/** Changes that only take effect after restarting Pi-Web. */
export function needsRestart(patch: UpdateSettingsRequest): boolean {
	return patch.listenHost !== undefined || patch.listenPort !== undefined;
}

export function isLoopback(host: string): boolean {
	const h = host.trim().toLowerCase();
	return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Options for the Node version select: latest, cached versions, the current value. */
export function nodeVersionOptions(current: string, cached: readonly string[]): string[] {
	const out = [LATEST_NODE];
	for (const v of [...cached].sort((a, b) => compareVersions(b, a))) if (!out.includes(v)) out.push(v);
	const cur = current.trim().replace(/^v/, "");
	if (cur && !out.includes(cur)) out.push(cur);
	return out;
}
