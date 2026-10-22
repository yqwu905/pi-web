/**
 * SSH connection form shared by the add-server wizard (step 1) and the server settings page:
 * values, validation, request builders and `~/.ssh/config` import.
 */
import type { AuthMethod, CreateServerRequest, ServerAuthInput, ServerView, SshConfigHost, UpdateServerRequest } from "@pi-web/shared";

export interface ConnectionFormValues {
	name: string;
	group: string;
	host: string;
	/** Text as typed; validated with parsePort. */
	port: string;
	username: string;
	authMethod: AuthMethod;
	keyPath: string;
	/** Password (method "password") or key passphrase (method "key"); empty = none / keep stored. */
	secret: string;
	/** Ordered jump hosts (server ids), first hop first. */
	jumpServerIds: string[];
}

export type ConnectionField = "name" | "group" | "host" | "port" | "username" | "keyPath" | "secret" | "jumpServerIds";
export type ConnectionFormErrors = Partial<Record<ConnectionField, string>>;

export const DEFAULT_KEY_PATH = "~/.ssh/id_ed25519";

export const AUTH_METHOD_LABELS: Record<AuthMethod, string> = {
	key: "私钥",
	password: "密码",
	agent: "ssh-agent",
};

const NO_WHITESPACE = /^\S+$/;

export function emptyConnectionForm(): ConnectionFormValues {
	return {
		name: "",
		group: "",
		host: "",
		port: "22",
		username: "",
		authMethod: "key",
		keyPath: DEFAULT_KEY_PATH,
		secret: "",
		jumpServerIds: [],
	};
}

/** Integer in 1..65535, or null. Empty text means the default 22. */
export function parsePort(text: string, fallback: number | null = 22): number | null {
	const t = text.trim();
	if (!t) return fallback;
	if (!/^\d+$/.test(t)) return null;
	const n = Number(t);
	return n >= 1 && n <= 65535 ? n : null;
}

export interface ValidateConnectionOptions {
	/** A password is mandatory for method "password" (true when no secret is stored yet). */
	requirePassword?: boolean;
}

export function validateConnectionForm(values: ConnectionFormValues, options: ValidateConnectionOptions = {}): ConnectionFormErrors {
	const errors: ConnectionFormErrors = {};
	if (values.name.trim().length > 200) errors.name = "名称不能超过 200 个字符";
	if (values.group.trim().length > 200) errors.group = "分组不能超过 200 个字符";
	const host = values.host.trim();
	if (!host) errors.host = "请填写主机地址";
	else if (!NO_WHITESPACE.test(host)) errors.host = "主机地址不能包含空格";
	if (parsePort(values.port) === null) errors.port = "端口应为 1–65535 的整数";
	const username = values.username.trim();
	if (!username) errors.username = "请填写用户名";
	else if (!NO_WHITESPACE.test(username)) errors.username = "用户名不能包含空格";
	if (values.authMethod === "key" && !values.keyPath.trim()) errors.keyPath = "请填写私钥路径";
	if (values.authMethod === "password" && options.requirePassword && !values.secret) errors.secret = "请填写密码";
	if (new Set(values.jumpServerIds).size !== values.jumpServerIds.length) errors.jumpServerIds = "跳板机不能重复";
	return errors;
}

export function hasErrors(errors: object): boolean {
	return Object.values(errors).some((v) => v !== undefined && v !== "");
}

/** Auth payload; an empty secret is omitted (keeps the stored one when updating). */
export function toAuthInput(values: ConnectionFormValues): ServerAuthInput {
	switch (values.authMethod) {
		case "key":
			return { method: "key", keyPath: values.keyPath.trim(), ...(values.secret ? { secret: values.secret } : {}) };
		case "password":
			return { method: "password", ...(values.secret ? { secret: values.secret } : {}) };
		default:
			return { method: "agent" };
	}
}

export interface ConnectionTestRequest {
	host: string;
	port: number;
	username: string;
	auth: ServerAuthInput;
	jumpServerIds?: string[];
	/** Existing server being edited: its trusted host key (same host:port) and stored secret apply. */
	serverId?: string;
}

/**
 * Test request for the values as typed. Pass `serverId` when editing a saved server so the
 * server checks the host key against the trusted one and uses the stored secret when the
 * secret field is left empty. Jump hosts are always sent, so removing them all is honoured.
 */
export function toTestRequest(values: ConnectionFormValues, serverId?: string): ConnectionTestRequest {
	return {
		host: values.host.trim(),
		port: parsePort(values.port) ?? 22,
		username: values.username.trim(),
		auth: toAuthInput(values),
		jumpServerIds: [...values.jumpServerIds],
		...(serverId ? { serverId } : {}),
	};
}

/** Display name used when the name field is left empty. */
export function defaultServerName(values: Pick<ConnectionFormValues, "name" | "host" | "username">): string {
	const name = values.name.trim();
	if (name) return name;
	const host = values.host.trim();
	const user = values.username.trim();
	return user && host ? `${user}@${host}` : host;
}

export function toCreateRequest(values: ConnectionFormValues): CreateServerRequest {
	const group = values.group.trim();
	return {
		name: defaultServerName(values),
		...(group ? { group } : {}),
		host: values.host.trim(),
		port: parsePort(values.port) ?? 22,
		username: values.username.trim(),
		auth: toAuthInput(values),
		jumpServerIds: [...values.jumpServerIds],
	};
}

/** Full connection update (wizard: the user went back to step 1 after the server was created). */
export function toConnectionUpdate(values: ConnectionFormValues): UpdateServerRequest {
	return {
		name: defaultServerName(values),
		group: values.group.trim(),
		host: values.host.trim(),
		port: parsePort(values.port) ?? 22,
		username: values.username.trim(),
		auth: toAuthInput(values),
		jumpServerIds: [...values.jumpServerIds],
	};
}

/** Identity of the fields a connection test depends on (a test result is stale once it changes). */
export function connectionSignature(values: ConnectionFormValues): string {
	return JSON.stringify([
		values.host.trim(),
		parsePort(values.port),
		values.username.trim(),
		values.authMethod,
		values.authMethod === "key" ? values.keyPath.trim() : "",
		values.authMethod === "agent" ? "" : values.secret,
		values.jumpServerIds,
	]);
}

/** Connection values of an existing server (the secret is never sent back by the host). */
export function formFromServerConfig(view: ServerView): ConnectionFormValues {
	const c = view.config;
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
	};
}

// ---------- ~/.ssh/config import ----------

/** Splits a ProxyJump value ("a,user@b:2222") into hop host names ("a", "b"). */
export function parseProxyJump(value: string | undefined): Array<{ raw: string; host: string; user?: string; port?: number }> {
	if (!value || value.trim().toLowerCase() === "none") return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((raw) => {
			let rest = raw.replace(/^ssh:\/\//, "");
			let user: string | undefined;
			const at = rest.lastIndexOf("@");
			if (at >= 0) {
				user = rest.slice(0, at);
				rest = rest.slice(at + 1);
			}
			let port: number | undefined;
			const m = /^(.*):(\d+)$/.exec(rest);
			if (m && !m[1].includes(":")) {
				rest = m[1];
				port = Number(m[2]);
			}
			return { raw, host: rest.replace(/^\[|\]$/g, ""), ...(user ? { user } : {}), ...(port ? { port } : {}) };
		});
}

/** Finds a configured server matching a ProxyJump hop (by name, then host and optional user/port). */
export function matchJumpServer(
	hop: { host: string; user?: string; port?: number },
	servers: readonly ServerView[],
): ServerView | undefined {
	const byName = servers.find((s) => s.config.name === hop.host);
	if (byName) return byName;
	return servers.find(
		(s) =>
			s.config.host === hop.host &&
			(hop.user === undefined || s.config.username === hop.user) &&
			(hop.port === undefined || s.config.port === hop.port),
	);
}

export interface SshImportResult {
	values: ConnectionFormValues;
	/** ProxyJump hops without a matching server (they must be added first). */
	unresolvedJumps: string[];
}

/** Fills the connection form from a `~/.ssh/config` Host entry. */
export function formFromSshHost(entry: SshConfigHost, servers: readonly ServerView[], base: ConnectionFormValues): SshImportResult {
	const values: ConnectionFormValues = {
		...base,
		name: entry.alias,
		host: entry.hostName?.trim() || entry.alias,
		port: String(entry.port ?? 22),
		username: entry.user?.trim() || base.username,
		secret: "",
	};
	if (entry.identityFile) {
		values.authMethod = "key";
		values.keyPath = entry.identityFile;
	}
	const jumpIds: string[] = [];
	const unresolvedJumps: string[] = [];
	for (const hop of parseProxyJump(entry.proxyJump)) {
		const match = matchJumpServer(hop, servers);
		if (match && !jumpIds.includes(match.config.id)) jumpIds.push(match.config.id);
		else if (!match) unresolvedJumps.push(hop.raw);
	}
	values.jumpServerIds = jumpIds;
	return { values, unresolvedJumps };
}

/** "user@host:port" of an SSH config entry, for the import list. */
export function sshHostTarget(entry: SshConfigHost): string {
	const host = entry.hostName || entry.alias;
	return `${entry.user ? `${entry.user}@` : ""}${host}:${entry.port ?? 22}`;
}

/** Second line of an import row: ProxyJump wins over IdentityFile. */
export function sshHostExtra(entry: SshConfigHost): string {
	if (entry.proxyJump) return `ProxyJump ${entry.proxyJump}`;
	if (entry.identityFile) return `IdentityFile ${entry.identityFile}`;
	return "";
}

export function sameJumps(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Servers usable as the next hop: not the server itself and not already in the chain. */
export function jumpCandidates(servers: readonly ServerView[], selfId: string | undefined, chain: readonly string[], index: number): ServerView[] {
	const others = new Set(chain.filter((_, i) => i !== index));
	return servers.filter((s) => s.config.id !== selfId && !others.has(s.config.id));
}

/** "bastion-gw → hop2" for a jump chain; unknown ids are shown as-is. */
export function jumpChainLabel(ids: readonly string[], servers: readonly ServerView[]): string {
	return ids.map((id) => servers.find((s) => s.config.id === id)?.config.name ?? id).join(" → ");
}

/** "dev@10.0.3.21:22". */
export function serverTarget(c: { username: string; host: string; port: number }): string {
	return `${c.username}@${c.host}:${c.port}`;
}
