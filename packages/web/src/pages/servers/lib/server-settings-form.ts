/**
 * Server settings page form (pure): values from a ServerConfig, dirty tracking per field and
 * section, validation, and the minimal UpdateServerRequest for the changed fields.
 */
import { SYNC_ITEM_KEYS, type ServerConfig, type SyncItemKey, type UpdateServerRequest } from "@pi-web/shared";
import {
	type ConnectionFormErrors,
	type ConnectionFormValues,
	DEFAULT_KEY_PATH,
	parsePort,
	sameJumps,
	validateConnectionForm,
} from "./connection-form";
import { formatOverride, jsonEqual, parseSettingsOverride } from "./json-override";
import { formatList, parseList, sameList } from "./lists";

export interface ServerSettingsForm extends ConnectionFormValues {
	agentDirMode: ServerConfig["agentDirMode"];
	proxyMode: ServerConfig["proxy"]["mode"];
	proxyPort: string;
	proxyScope: ServerConfig["proxy"]["scope"];
	toolsPolicy: ServerConfig["proxy"]["toolsPolicy"];
	extraDomains: string[];
	noProxyText: string;
	syncItems: Record<SyncItemKey, boolean>;
	syncAuto: boolean;
	overrideText: string;
	idleTimeoutMin: number;
	defaultTrust: ServerConfig["defaultTrust"];
}

export type SettingsField = keyof ServerSettingsForm;

export type SettingsSection = "conn" | "deploy" | "proxy" | "sync" | "session" | "danger";

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
	{ id: "conn", label: "连接" },
	{ id: "deploy", label: "部署与目录" },
	{ id: "proxy", label: "LLM 代理" },
	{ id: "sync", label: "配置同步" },
	{ id: "session", label: "会话" },
	{ id: "danger", label: "危险操作" },
];

export const SECTION_FIELDS: Record<SettingsSection, readonly SettingsField[]> = {
	conn: ["name", "group", "host", "port", "username", "authMethod", "keyPath", "secret", "jumpServerIds"],
	deploy: ["agentDirMode"],
	proxy: ["proxyMode", "proxyPort", "proxyScope", "toolsPolicy", "extraDomains", "noProxyText"],
	sync: ["syncItems", "syncAuto", "overrideText"],
	session: ["idleTimeoutMin", "defaultTrust"],
	danger: [],
};

export function formFromServer(c: ServerConfig): ServerSettingsForm {
	return {
		name: c.name,
		group: c.group ?? "",
		host: c.host,
		port: String(c.port),
		username: c.username,
		authMethod: c.auth.method,
		keyPath: c.auth.keyPath ?? (c.auth.method === "key" ? DEFAULT_KEY_PATH : ""),
		secret: "",
		jumpServerIds: [...c.jumpServerIds],
		agentDirMode: c.agentDirMode,
		proxyMode: c.proxy.mode,
		proxyPort: String(c.proxy.port),
		proxyScope: c.proxy.scope,
		toolsPolicy: c.proxy.toolsPolicy,
		extraDomains: [...c.proxy.extraDomains],
		noProxyText: formatList(c.proxy.noProxy),
		syncItems: Object.fromEntries(SYNC_ITEM_KEYS.map((k) => [k, Boolean(c.sync.items[k])])) as Record<SyncItemKey, boolean>,
		syncAuto: c.sync.auto,
		overrideText: formatOverride(c.sync.settingsOverride),
		idleTimeoutMin: c.idleTimeoutMin,
		defaultTrust: c.defaultTrust,
	};
}

function overrideEqual(a: string, b: string): boolean {
	const pa = parseSettingsOverride(a);
	const pb = parseSettingsOverride(b);
	if (pa.ok && pb.ok) return jsonEqual(pa.value, pb.value);
	return a === b;
}

function fieldEqual(field: SettingsField, a: ServerSettingsForm, b: ServerSettingsForm): boolean {
	switch (field) {
		case "name":
		case "group":
		case "host":
		case "username":
		case "keyPath":
			return a[field].trim() === b[field].trim();
		case "port":
			return parsePort(a.port) === parsePort(b.port);
		case "proxyPort":
			return parsePort(a.proxyPort, null) === parsePort(b.proxyPort, null);
		case "secret":
			return a.secret === b.secret;
		case "jumpServerIds":
			return sameJumps(a.jumpServerIds, b.jumpServerIds);
		case "extraDomains":
			return sameList(a.extraDomains, b.extraDomains);
		case "noProxyText":
			return sameList(parseList(a.noProxyText), parseList(b.noProxyText));
		case "syncItems":
			return changedSyncItems(a, b).length === 0;
		case "overrideText":
			return overrideEqual(a.overrideText, b.overrideText);
		default:
			return a[field] === b[field];
	}
}

export function changedSyncItems(base: ServerSettingsForm, form: ServerSettingsForm): SyncItemKey[] {
	return SYNC_ITEM_KEYS.filter((k) => Boolean(base.syncItems[k]) !== Boolean(form.syncItems[k]));
}

const ALL_FIELDS = Object.values(SECTION_FIELDS).flat();

/** Fields whose value differs from the saved one (keyPath only counts for key auth). */
export function dirtyFields(base: ServerSettingsForm, form: ServerSettingsForm): SettingsField[] {
	return ALL_FIELDS.filter((f) => {
		if (f === "keyPath" && form.authMethod !== "key") return false;
		return !fieldEqual(f, base, form);
	});
}

/** Number of unsaved changes as shown in the save bar (each toggled sync item counts once). */
export function dirtyCount(base: ServerSettingsForm, form: ServerSettingsForm): number {
	const fields = dirtyFields(base, form);
	return fields.filter((f) => f !== "syncItems").length + changedSyncItems(base, form).length;
}

export function dirtySections(fields: readonly SettingsField[]): Set<SettingsSection> {
	const out = new Set<SettingsSection>();
	for (const [section, list] of Object.entries(SECTION_FIELDS) as Array<[SettingsSection, readonly SettingsField[]]>) {
		if (list.some((f) => fields.includes(f))) out.add(section);
	}
	return out;
}

export type ServerSettingsErrors = ConnectionFormErrors & Partial<Record<"proxyPort" | "noProxyText" | "overrideText" | "idleTimeoutMin", string>>;

export function validateServerSettings(
	form: ServerSettingsForm,
	base: ServerSettingsForm,
	options: { hasSecret: boolean },
): ServerSettingsErrors {
	// A password is required when switching to password auth without a stored password.
	const switchedToPassword = form.authMethod === "password" && base.authMethod !== "password";
	const errors: ServerSettingsErrors = validateConnectionForm(form, {
		requirePassword: switchedToPassword || !options.hasSecret,
	});
	if (form.proxyMode === "tunnel") {
		const port = parsePort(form.proxyPort, null);
		if (port === null || port < 1024) errors.proxyPort = "端口应为 1024–65535 的整数";
	}
	const noProxy = parseList(form.noProxyText);
	if (noProxy.some((v) => v.length > 255)) errors.noProxyText = "NO_PROXY 条目过长";
	const override = parseSettingsOverride(form.overrideText);
	if (!override.ok) errors.overrideText = override.error;
	if (!Number.isInteger(form.idleTimeoutMin) || form.idleTimeoutMin < 0 || form.idleTimeoutMin > 7 * 24 * 60) {
		errors.idleTimeoutMin = "空闲回收时间无效";
	}
	return errors;
}

/** The update request carrying only what changed (nested proxy/sync are merged by the host). */
export function buildServerUpdate(base: ServerSettingsForm, form: ServerSettingsForm): UpdateServerRequest {
	const dirty = new Set(dirtyFields(base, form));
	const req: UpdateServerRequest = {};
	if (dirty.has("name")) req.name = form.name.trim();
	if (dirty.has("group")) req.group = form.group.trim();
	if (dirty.has("host")) req.host = form.host.trim();
	if (dirty.has("port")) req.port = parsePort(form.port) ?? 22;
	if (dirty.has("username")) req.username = form.username.trim();
	if (dirty.has("authMethod") || dirty.has("keyPath") || dirty.has("secret")) {
		if (form.authMethod === "agent") req.auth = { method: "agent", secret: null };
		else if (form.authMethod === "key") {
			req.auth = { method: "key", keyPath: form.keyPath.trim() };
			// Switching from password to key: the stored password is not a passphrase.
			if (form.secret) req.auth.secret = form.secret;
			else if (base.authMethod !== "key") req.auth.secret = null;
		} else {
			req.auth = { method: "password" };
			if (form.secret) req.auth.secret = form.secret;
		}
	}
	if (dirty.has("jumpServerIds")) req.jumpServerIds = [...form.jumpServerIds];
	if (dirty.has("agentDirMode")) req.agentDirMode = form.agentDirMode;
	const proxy: NonNullable<UpdateServerRequest["proxy"]> = {};
	if (dirty.has("proxyMode")) proxy.mode = form.proxyMode;
	if (dirty.has("proxyPort")) {
		const port = parsePort(form.proxyPort, null);
		if (port !== null) proxy.port = port;
	}
	if (dirty.has("proxyScope")) proxy.scope = form.proxyScope;
	if (dirty.has("toolsPolicy")) proxy.toolsPolicy = form.toolsPolicy;
	if (dirty.has("extraDomains")) proxy.extraDomains = [...form.extraDomains];
	if (dirty.has("noProxyText")) proxy.noProxy = parseList(form.noProxyText);
	if (Object.keys(proxy).length) req.proxy = proxy;
	const sync: NonNullable<UpdateServerRequest["sync"]> = {};
	if (dirty.has("syncItems")) sync.items = Object.fromEntries(changedSyncItems(base, form).map((k) => [k, form.syncItems[k]]));
	if (dirty.has("syncAuto")) sync.auto = form.syncAuto;
	if (dirty.has("overrideText")) {
		const parsed = parseSettingsOverride(form.overrideText);
		if (parsed.ok) sync.settingsOverride = parsed.value;
	}
	if (Object.keys(sync).length) req.sync = sync;
	if (dirty.has("idleTimeoutMin")) req.idleTimeoutMin = form.idleTimeoutMin;
	if (dirty.has("defaultTrust")) req.defaultTrust = form.defaultTrust;
	return req;
}

/** Saving these changes alters what the next sync writes (proxy injection, items, override). */
export function affectsSync(fields: readonly SettingsField[]): boolean {
	return fields.some((f) => SECTION_FIELDS.sync.includes(f) || f === "proxyMode" || f === "proxyScope" || f === "agentDirMode");
}

/** Saving these reconnects the server. */
export function affectsConnection(fields: readonly SettingsField[]): boolean {
	return fields.some((f) => f !== "name" && f !== "group" && SECTION_FIELDS.conn.includes(f));
}

export const IDLE_TIMEOUT_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
	{ value: 15, label: "15 分钟" },
	{ value: 30, label: "30 分钟" },
	{ value: 60, label: "60 分钟" },
	{ value: 120, label: "2 小时" },
	{ value: 0, label: "从不" },
];

/** Select options for the idle timeout, keeping a non-preset current value selectable. */
export function idleTimeoutOptions(current: number): Array<{ value: number; label: string }> {
	if (IDLE_TIMEOUT_PRESETS.some((p) => p.value === current)) return [...IDLE_TIMEOUT_PRESETS];
	const custom = { value: current, label: `${current} 分钟` };
	return [...IDLE_TIMEOUT_PRESETS.filter((p) => p.value !== 0), custom, IDLE_TIMEOUT_PRESETS[IDLE_TIMEOUT_PRESETS.length - 1]].sort(
		(a, b) => (a.value === 0 ? 1 : b.value === 0 ? -1 : a.value - b.value),
	);
}
