/**
 * Typed REST client for the Pi-Web host (`/api`, IMPLEMENTATION.md §5). One function per route;
 * request/response types come from @pi-web/shared. Non-2xx responses throw `ApiError`
 * (code/message from ApiErrorBody); network failures throw ApiError with code "network_error".
 *
 * Usage (no path aliases are configured; import relatively):
 *   import { api, ApiError } from "../api/client";
 *   const { servers } = await api.listServers();
 */
import type {
	AgentLogsResponse,
	AgentStatus,
	ApiErrorBody,
	CacheEntry,
	CacheResponse,
	CompanionActionResponse,
	ConversationRpcRequest,
	ConversationRpcResponse,
	ConversationSnapshot,
	ConversationUiResponseRequest,
	ConversationView,
	ConvReplayResult,
	CreateServerRequest,
	CreateWorkspaceRequest,
	DeployProgress,
	DeployRequest,
	FsListResponse,
	FsReadResponse,
	GitDiffResponse,
	GitLogResponse,
	GitStatusResponse,
	HostInventory,
	LabelRequest,
	MetaResponse,
	NavigateRequest,
	OAuthStatusResponse,
	OpenConversationRequest,
	ProbeResult,
	ProxyStats,
	ServerAuthInput,
	ServerView,
	SessionFileResponse,
	SessionListResponse,
	SettingsResponse,
	SshConfigHost,
	SyncPlan,
	SyncRecord,
	SyncRunRequest,
	SyncRunResponse,
	SyncStatusResponse,
	TestConnectionResult,
	TrustHostKeyRequest,
	UninstallRequest,
	UpdateServerRequest,
	UpdateSettingsRequest,
	UpdateWorkspaceRequest,
	WorkspaceView,
} from "@pi-web/shared";

export const API_BASE = "/api";

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;
	constructor(status: number, code: string, message: string, details?: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export function isApiError(error: unknown): error is ApiError {
	return error instanceof ApiError;
}

/** User-facing message for any thrown value. */
export function errorMessage(error: unknown): string {
	if (error instanceof ApiError) return error.message || `请求失败（${error.status}）`;
	if (error instanceof Error) return error.message;
	return String(error);
}

type QueryValue = string | number | boolean | null | undefined;

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
	const params = new URLSearchParams();
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null) continue;
			params.set(key, String(value));
		}
	}
	const qs = params.toString();
	return `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
}

interface RequestOptions {
	query?: Record<string, QueryValue>;
	/** JSON body (objects) or raw body (Blob / ArrayBuffer). */
	body?: unknown;
	signal?: AbortSignal;
	headers?: Record<string, string>;
}

const enc = encodeURIComponent;

async function toApiError(res: Response): Promise<ApiError> {
	let text = "";
	try {
		text = await res.text();
	} catch {
		// ignore
	}
	if (text) {
		try {
			const body = JSON.parse(text) as Partial<ApiErrorBody>;
			if (body && typeof body === "object" && body.error && typeof body.error.message === "string") {
				return new ApiError(res.status, body.error.code ?? "error", body.error.message, body.error.details);
			}
		} catch {
			// not JSON
		}
	}
	const fallback = res.status === 401 ? "需要访问令牌" : res.status === 404 ? "资源不存在" : `请求失败（${res.status}）`;
	return new ApiError(res.status, res.status === 401 ? "unauthorized" : "http_error", text && text.length < 300 ? text : fallback);
}

/** Low-level fetch returning the raw Response (throws ApiError on non-2xx). */
export async function requestRaw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
	const headers: Record<string, string> = { accept: "application/json", ...options.headers };
	let body: BodyInit | undefined;
	if (options.body !== undefined) {
		if (options.body instanceof Blob || options.body instanceof ArrayBuffer || ArrayBuffer.isView(options.body)) {
			body = options.body as BodyInit;
			headers["content-type"] ??= "application/octet-stream";
		} else {
			body = JSON.stringify(options.body);
			headers["content-type"] = "application/json";
		}
	}
	let res: Response;
	try {
		res = await fetch(buildUrl(path, options.query), {
			method,
			headers,
			body,
			signal: options.signal,
			credentials: "same-origin",
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		throw new ApiError(0, "network_error", "无法连接到 Pi-Web 服务");
	}
	if (!res.ok) throw await toApiError(res);
	return res;
}

/** JSON request. A 204 / empty body resolves to undefined (typed as T). */
export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
	const res = await requestRaw(method, path, options);
	const text = await res.text();
	if (!text) return undefined as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new ApiError(res.status, "invalid_response", "服务返回了无法解析的数据");
	}
}

const get = <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) => request<T>("GET", path, { query, signal });
const post = <T>(path: string, body?: unknown, query?: Record<string, QueryValue>) => request<T>("POST", path, { body: body ?? {}, query });
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, { body });
const del = <T>(path: string, query?: Record<string, QueryValue>) => request<T>("DELETE", path, { query });

type Ok = { ok: true };

// ---------- meta & settings ----------

export const getMeta = (signal?: AbortSignal) => get<MetaResponse>("/meta", undefined, signal);
export const getSettings = () => get<SettingsResponse>("/settings");
export const updateSettings = (req: UpdateSettingsRequest) => put<SettingsResponse>("/settings", req);
export const getSshConfig = () => get<{ hosts: SshConfigHost[] }>("/ssh-config");
export const login = (token: string) => post<Ok>("/auth/login", { token });

// ---------- servers ----------

export interface TestConnectionRequest {
	host: string;
	port: number;
	username: string;
	auth: ServerAuthInput;
	jumpServerIds?: string[];
}

export const listServers = () => get<{ servers: ServerView[] }>("/servers");
export const createServer = (req: CreateServerRequest) => post<ServerView>("/servers", req);
export const testConnection = (req: TestConnectionRequest) => post<TestConnectionResult>("/servers/test", req);
export const getServer = (id: string) => get<ServerView>(`/servers/${enc(id)}`);
export const updateServer = (id: string, req: UpdateServerRequest) => put<ServerView>(`/servers/${enc(id)}`, req);
export const deleteServer = (id: string) => del<Ok>(`/servers/${enc(id)}`);
export const testServer = (id: string) => post<TestConnectionResult>(`/servers/${enc(id)}/test`);
export const trustHostKey = (id: string, req: TrustHostKeyRequest) => post<ServerView>(`/servers/${enc(id)}/trust-host-key`, req);
export const connectServer = (id: string) => post<ServerView>(`/servers/${enc(id)}/connect`);
export const disconnectServer = (id: string) => post<ServerView>(`/servers/${enc(id)}/disconnect`);
export const probeServer = (id: string) => post<ProbeResult>(`/servers/${enc(id)}/probe`);
export const deployServer = (id: string, req: DeployRequest = {}) => post<DeployProgress>(`/servers/${enc(id)}/deploy`, req);
export const getDeployJob = (id: string) => get<{ job: DeployProgress | null }>(`/servers/${enc(id)}/deploy`);
export const cancelDeploy = (id: string) => post<Ok>(`/servers/${enc(id)}/deploy/cancel`);
export const restartAgent = (id: string) => post<Ok>(`/servers/${enc(id)}/restart-agent`);
export const uninstallServer = (id: string, req: UninstallRequest) => post<Ok>(`/servers/${enc(id)}/uninstall`, req);
export const getAgentStatus = (id: string) => get<AgentStatus>(`/servers/${enc(id)}/agent-status`);
export const getAgentLogs = (id: string, tail = 200) => get<AgentLogsResponse>(`/servers/${enc(id)}/logs`, { tail });
export const getProxyStats = (id: string) => get<ProxyStats>(`/servers/${enc(id)}/proxy`);
export const allowProxyDomain = (id: string, domain: string) => post<ServerView>(`/servers/${enc(id)}/proxy/allow`, { domain });
/** Directory picker on a server; `path` may be "~". */
export const listServerDir = (id: string, params: { path?: string; showHidden?: boolean } = {}) =>
	get<FsListResponse>(`/servers/${enc(id)}/fs/list`, { path: params.path, showHidden: params.showHidden });
export const mkdirOnServer = (id: string, path: string) => post<{ ok: true; path: string }>(`/servers/${enc(id)}/fs/mkdir`, { path });

// ---------- workspaces ----------

export const listWorkspaces = () => get<{ workspaces: WorkspaceView[] }>("/workspaces");
export const listServerWorkspaces = (serverId: string) => get<{ workspaces: WorkspaceView[] }>(`/servers/${enc(serverId)}/workspaces`);
export const createWorkspace = (serverId: string, req: CreateWorkspaceRequest) =>
	post<WorkspaceView>(`/servers/${enc(serverId)}/workspaces`, req);
export const updateWorkspace = (wsId: string, req: UpdateWorkspaceRequest) => put<WorkspaceView>(`/workspaces/${enc(wsId)}`, req);
export const deleteWorkspace = (wsId: string) => del<Ok>(`/workspaces/${enc(wsId)}`);
export const listSessions = (wsId: string, signal?: AbortSignal) => get<SessionListResponse>(`/workspaces/${enc(wsId)}/sessions`, undefined, signal);

/** `path` is relative to the workspace or absolute; defaults to the workspace root. */
export const listWorkspaceDir = (wsId: string, params: { path?: string; showHidden?: boolean; hideIgnored?: boolean } = {}) =>
	get<FsListResponse>(`/workspaces/${enc(wsId)}/fs/list`, {
		path: params.path,
		showHidden: params.showHidden,
		hideIgnored: params.hideIgnored,
	});
export const readWorkspaceFile = (wsId: string, path: string, maxBytes?: number) =>
	get<FsReadResponse>(`/workspaces/${enc(wsId)}/fs/read`, { path, maxBytes });
/** URL for `<a href download>`; the browser streams the file. */
export const workspaceDownloadUrl = (wsId: string, path: string) => buildUrl(`/workspaces/${enc(wsId)}/fs/download`, { path });
export const downloadWorkspaceFile = async (wsId: string, path: string): Promise<Blob> =>
	(await requestRaw("GET", `/workspaces/${enc(wsId)}/fs/download`, { query: { path } })).blob();

export const getGitStatus = (wsId: string) => get<GitStatusResponse>(`/workspaces/${enc(wsId)}/git/status`);
export const getGitDiff = (wsId: string, params: { path?: string; area: "staged" | "unstaged" | "untracked"; context?: number }) =>
	get<GitDiffResponse>(`/workspaces/${enc(wsId)}/git/diff`, { path: params.path, area: params.area, context: params.context });
export const getGitLog = (wsId: string, limit?: number) => get<GitLogResponse>(`/workspaces/${enc(wsId)}/git/log`, { limit });

// ---------- sessions ----------

export const readSession = (serverId: string, file: string, signal?: AbortSignal) =>
	get<SessionFileResponse>("/sessions/read", { serverId, file }, signal);
export const deleteSession = (serverId: string, file: string) => del<{ trashedTo: string }>("/sessions", { serverId, file });

// ---------- conversations ----------

export const listConversations = () => get<{ conversations: ConversationView[] }>("/conversations");
export const openConversation = (wsId: string, req: OpenConversationRequest = {}) =>
	post<ConversationView>(`/workspaces/${enc(wsId)}/conversations`, req);
export const getConversationSnapshot = (convId: string, signal?: AbortSignal) =>
	get<ConversationSnapshot>(`/conversations/${enc(convId)}/snapshot`, undefined, signal);
export const conversationRpc = (convId: string, req: ConversationRpcRequest) =>
	post<ConversationRpcResponse & { seq?: number }>(`/conversations/${enc(convId)}/rpc`, req);
export const conversationUiResponse = (convId: string, req: ConversationUiResponseRequest) =>
	post<Ok>(`/conversations/${enc(convId)}/ui-response`, req);
export const navigateConversation = (convId: string, req: NavigateRequest) =>
	post<CompanionActionResponse>(`/conversations/${enc(convId)}/navigate`, req);
export const labelConversationEntry = (convId: string, req: LabelRequest) =>
	post<CompanionActionResponse>(`/conversations/${enc(convId)}/label`, req);
export const reloadConversation = (convId: string) => post<CompanionActionResponse>(`/conversations/${enc(convId)}/reload`);
export const stopConversation = (convId: string, force?: boolean) => post<Ok>(`/conversations/${enc(convId)}/stop`, { force });
export const replayConversation = (convId: string, afterSeq: number) =>
	get<ConvReplayResult>(`/conversations/${enc(convId)}/replay`, { afterSeq });
/** URL of the HTML export (text/html download). */
export const conversationExportUrl = (convId: string) => buildUrl(`/conversations/${enc(convId)}/export`);
export const exportConversation = async (convId: string): Promise<{ blob: Blob; fileName: string }> => {
	const res = await requestRaw("GET", `/conversations/${enc(convId)}/export`, { headers: { accept: "text/html" } });
	const disposition = res.headers.get("content-disposition") ?? "";
	const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition);
	const raw = match ? (match[1] ?? match[2]) : undefined;
	let fileName = `${convId}.html`;
	if (raw) {
		try {
			fileName = decodeURIComponent(raw);
		} catch {
			fileName = raw;
		}
	}
	return { blob: await res.blob(), fileName };
};

// ---------- sync & oauth ----------

export const getSyncInventory = () => get<HostInventory>("/sync/inventory");
export const getSyncStatus = () => get<SyncStatusResponse>("/sync/status");
export const previewSync = (serverId: string) => post<SyncPlan>("/sync/preview", { serverId });
export const runSync = (req: SyncRunRequest = {}) => post<SyncRunResponse>("/sync/run", req);
export const getSyncHistory = (limit?: number) => get<{ records: SyncRecord[] }>("/sync/history", { limit });
export const getOAuthStatus = () => get<OAuthStatusResponse>("/oauth");
export const refreshOAuth = (provider: string) => post<OAuthStatusResponse>(`/oauth/${enc(provider)}/refresh`);

// ---------- cache ----------

export const getCache = () => get<CacheResponse>("/cache");
export const deleteCache = (name: string) => del<Ok>(`/cache/${enc(name)}`);
/** Uploads a local Node runtime archive (tar.xz / tar.gz) as the raw request body. */
export const importNodeArchive = (file: Blob, fileName: string) =>
	request<CacheEntry>("POST", "/cache/import-node", { query: { fileName }, body: file });

/** Every route function, grouped for discoverability (`api.listServers()`). */
export const api = {
	getMeta,
	getSettings,
	updateSettings,
	getSshConfig,
	login,
	listServers,
	createServer,
	testConnection,
	getServer,
	updateServer,
	deleteServer,
	testServer,
	trustHostKey,
	connectServer,
	disconnectServer,
	probeServer,
	deployServer,
	getDeployJob,
	cancelDeploy,
	restartAgent,
	uninstallServer,
	getAgentStatus,
	getAgentLogs,
	getProxyStats,
	allowProxyDomain,
	listServerDir,
	mkdirOnServer,
	listWorkspaces,
	listServerWorkspaces,
	createWorkspace,
	updateWorkspace,
	deleteWorkspace,
	listSessions,
	listWorkspaceDir,
	readWorkspaceFile,
	workspaceDownloadUrl,
	downloadWorkspaceFile,
	getGitStatus,
	getGitDiff,
	getGitLog,
	readSession,
	deleteSession,
	listConversations,
	openConversation,
	getConversationSnapshot,
	conversationRpc,
	conversationUiResponse,
	navigateConversation,
	labelConversationEntry,
	reloadConversation,
	stopConversation,
	replayConversation,
	conversationExportUrl,
	exportConversation,
	getSyncInventory,
	getSyncStatus,
	previewSync,
	runSync,
	getSyncHistory,
	getOAuthStatus,
	refreshOAuth,
	getCache,
	deleteCache,
	importNodeArchive,
} as const;

/** Triggers a browser download of a Blob. */
export function saveBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
