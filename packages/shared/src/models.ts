/** Host-side persisted configuration (stored under ~/.pi-web-host/). */
import type { ThinkingLevel } from "./pi.js";

export type AuthMethod = "key" | "password" | "agent";

export interface ServerAuth {
	method: AuthMethod;
	/** For "key": private key path on the host (may start with "~"). */
	keyPath?: string;
	/** True when a password (method "password") or key passphrase (method "key") is stored encrypted. */
	hasSecret?: boolean;
}

export interface ProxyConfig {
	mode: "off" | "tunnel";
	/** Remote 127.0.0.1 port the agent listens on. */
	port: number;
	/** "llm": only LLM provider traffic, bash tool gets no proxy variables. "tools": tools inherit the proxy. */
	scope: "llm" | "tools";
	/** Only meaningful for scope "tools": allow every destination, or provider domains + extraDomains. */
	toolsPolicy: "allowlist" | "all";
	/** Extra allowed destination host names (exact, or "*.example.com"). */
	extraDomains: string[];
	/** NO_PROXY entries for pi processes (e.g. intranet LLM endpoints). */
	noProxy: string[];
}

export const SYNC_ITEM_KEYS = [
	"settings",
	"models",
	"auth",
	"mcp",
	"instructions",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"npm",
	"git",
	"agentsSkills",
	"keybindings",
] as const;
export type SyncItemKey = (typeof SYNC_ITEM_KEYS)[number];

export interface SyncItemDefinition {
	key: SyncItemKey;
	label: string;
	/** Paths relative to the host agent dir (or "~/.agents/skills" for agentsSkills). */
	paths: string[];
	defaultEnabled: boolean;
	description: string;
}

export const SYNC_ITEMS: readonly SyncItemDefinition[] = [
	{ key: "settings", label: "settings.json", paths: ["settings.json"], defaultEnabled: true, description: "设置（剔除 Host 专属项、注入代理设置、合并服务器级覆盖）" },
	{ key: "models", label: "models.json", paths: ["models.json"], defaultEnabled: true, description: "自定义 provider 与模型" },
	{ key: "auth", label: "auth.json", paths: ["auth.json"], defaultEnabled: true, description: "凭据；OAuth 仅推送 access token，refresh token 留在 Host" },
	{ key: "mcp", label: "mcp.json", paths: ["mcp.json"], defaultEnabled: true, description: "MCP 服务器配置" },
	{
		key: "instructions",
		label: "指令文件",
		paths: ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD", "SYSTEM.md", "APPEND_SYSTEM.md"],
		defaultEnabled: true,
		description: "AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md 等",
	},
	{ key: "extensions", label: "extensions/", paths: ["extensions"], defaultEnabled: true, description: "用户扩展" },
	{ key: "skills", label: "skills/", paths: ["skills"], defaultEnabled: true, description: "用户 skills" },
	{ key: "prompts", label: "prompts/", paths: ["prompts"], defaultEnabled: true, description: "Prompt 模板" },
	{ key: "themes", label: "themes/", paths: ["themes"], defaultEnabled: true, description: "主题" },
	{ key: "npm", label: "npm/", paths: ["npm"], defaultEnabled: true, description: "pi 管理的 npm 插件包" },
	{ key: "git", label: "git/", paths: ["git"], defaultEnabled: true, description: "git 插件包（含 node_modules）" },
	{ key: "agentsSkills", label: "~/.agents/skills", paths: ["~/.agents/skills"], defaultEnabled: false, description: "通用 Agent Skills 目录" },
	{ key: "keybindings", label: "keybindings.json", paths: ["keybindings.json"], defaultEnabled: false, description: "终端快捷键（Web 中不使用）" },
];

/** Never synced, whatever the item selection. Relative to the agent dir. */
export const SYNC_EXCLUDES: readonly string[] = ["sessions", "trust.json", "bin", "tools", "external-cache", "*.log"];

export interface SyncConfig {
	items: Record<SyncItemKey, boolean>;
	auto: boolean;
	/** Deep-merged into the synced settings.json. */
	settingsOverride: Record<string, unknown>;
}

export interface DeployedInfo {
	nodeVersion: string;
	piVersion: string;
	agentVersion: string;
	arch: "x64" | "arm64";
	glibc?: string;
	/** Absolute remote paths. */
	home: string;
	remoteRoot: string;
	agentDir: string;
	/** pi's CLI script relative to R/pi/current (bin.pi of the installed package); older installs: unset. */
	piCli?: string;
	at: number;
}

export interface ServerConfig {
	id: string;
	name: string;
	group?: string;
	host: string;
	port: number;
	username: string;
	auth: ServerAuth;
	/** Ordered jump hosts (other servers' ids), first hop first. */
	jumpServerIds: string[];
	/** Remote install root, default "~/.pi-web". */
	remoteRoot: string;
	agentDirMode: "isolated" | "shared";
	proxy: ProxyConfig;
	sync: SyncConfig;
	/** Minutes before an idle conversation process is stopped; 0 = never. */
	idleTimeoutMin: number;
	/** Default project trust for new workspaces. */
	defaultTrust: "approve" | "no-approve";
	/**
	 * Server-level environment variables: every pi process (below the workspace env), the web
	 * terminal and R/bin/pi (via R/run/env.sh).
	 */
	env: Record<string, string>;
	/** Trusted host key (TOFU). */
	hostKey?: { algorithm: string; fingerprint: string; trustedAt: number };
	deployed?: DeployedInfo;
	/** Marks hosts only used as jump hosts (hidden from the main server list). */
	jumpOnly?: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface WorkspaceConfig {
	id: string;
	serverId: string;
	/** Absolute remote path. */
	path: string;
	alias: string;
	trust: "approve" | "no-approve";
	defaults: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel };
	env: Record<string, string>;
	createdAt: number;
}

export interface HostSettings {
	nodeSource: "official" | "npmmirror" | "custom";
	nodeCustomBaseUrl?: string;
	/** "latest-22" resolves the newest v22 release ≥ 22.19 from the index; otherwise an exact version like "22.20.0". */
	nodeVersion: string;
	targetArchs: Array<"x64" | "arm64">;
	piVersionPolicy: "host" | "pinned";
	piPinnedVersion?: string;
	/** npm registry used when building the pi bundle; default https://registry.npmjs.org */
	npmRegistry?: string;
	prunePrebuilds: boolean;
	/** Host upstream proxy for tunnel egress, e.g. http://proxy.corp:3128 */
	upstreamProxy?: string;
	proxyPortRange: [number, number];
	defaultNoProxy: string[];
	listenHost: string;
	listenPort: number;
	accessTokenEnabled: boolean;
	/** Override of the host pi agent dir; default $PI_CODING_AGENT_DIR or ~/.pi/agent. */
	hostAgentDir?: string;
}

export const DEFAULT_HOST_SETTINGS: HostSettings = {
	nodeSource: "official",
	nodeVersion: "latest-22",
	targetArchs: ["x64", "arm64"],
	piVersionPolicy: "host",
	prunePrebuilds: true,
	proxyPortRange: [30000, 40000],
	defaultNoProxy: ["localhost", "127.0.0.1", "::1"],
	listenHost: "127.0.0.1",
	listenPort: 7878,
	accessTokenEnabled: false,
};

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
export type DeployState = "unknown" | "not_deployed" | "deployed" | "outdated" | "deploying";

export interface ProxyStats {
	active: number;
	byHost: Array<{ host: string; requests: number; bytesUp: number; bytesDown: number; lastAt: number }>;
	denied: Array<{ host: string; count: number; lastAt: number }>;
}

export interface ServerRuntimeStatus {
	serverId: string;
	connection: ConnectionState;
	error?: string;
	latencyMs?: number;
	connectedAt?: number;
	agent?: { version: string; pid: number; uptimeSec: number };
	deployState: DeployState;
	conversationsRunning: number;
	conversationsWaiting: number;
	pendingSync: number;
	lastSyncAt?: number;
	proxy?: ProxyStats;
}
