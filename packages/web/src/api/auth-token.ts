/**
 * Access token of this browser (when Pi-Web's access token is enabled).
 *
 * Kept in localStorage, which is scoped to this origin including its port, never in a cookie
 * (cookies for 127.0.0.1 are sent to every port of the host). REST calls send it as
 * `Authorization: Bearer`, WebSockets offer it as a sub-protocol entry and plain browser
 * downloads use a single-use ticket.
 */
const STORAGE_KEY = "pi-web.accessToken";
/** Mirrors WS_PROTOCOL / WS_TOKEN_PROTOCOL_PREFIX of the server. */
const WS_PROTOCOL = "pi-web";
const WS_TOKEN_PROTOCOL_PREFIX = "pi-web.token.";
/** Characters allowed in a WebSocket sub-protocol token (generated tokens are base64url). */
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

let memory: string | null = null;

export function getAccessToken(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY) ?? memory;
	} catch {
		return memory;
	}
}

export function setAccessToken(token: string | null): void {
	memory = token;
	try {
		if (token) localStorage.setItem(STORAGE_KEY, token);
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		// storage unavailable: keep it in memory for this page
	}
}

/** Headers for REST calls. */
export function authHeaders(): Record<string, string> {
	const token = getAccessToken();
	return token ? { authorization: `Bearer ${token}` } : {};
}

/** Sub-protocols for `new WebSocket(url, protocols)`; the server always selects "pi-web". */
export function wsProtocols(): string[] {
	const token = getAccessToken();
	return token && TOKEN_RE.test(token) ? [WS_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${token}`] : [WS_PROTOCOL];
}

/**
 * The start-up link printed by the CLI is `/?token=…`: keep the token and drop it from the
 * address bar (and so from history) before the app renders.
 */
export function adoptTokenFromUrl(loc: Pick<Location, "href"> = window.location): void {
	let url: URL;
	try {
		url = new URL(loc.href);
	} catch {
		return;
	}
	const token = url.searchParams.get("token");
	if (token === null) return;
	if (token.trim()) setAccessToken(token.trim());
	url.searchParams.delete("token");
	try {
		window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
	} catch {
		// ignore
	}
}
