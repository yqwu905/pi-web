/** Translation of thrown errors into ApiErrorBody responses. */
import type { ApiErrorBody } from "@pi-web/shared";
import { ApiError } from "../core/types.js";

/** Status codes for well-known `code`s carried by non-ApiError errors (agent LinkRequestError, Node errors). */
const CODE_STATUS: Record<string, number> = {
	BAD_REQUEST: 400,
	INVALID_PARAMS: 400,
	EINVAL: 400,
	EACCES: 403,
	EPERM: 403,
	NOT_FOUND: 404,
	ENOENT: 404,
	ENOTDIR: 400,
	EISDIR: 400,
	BUSY: 409,
	EEXIST: 409,
	NOT_DEPLOYED: 409,
	HOSTKEY_UNKNOWN: 409,
	HOSTKEY_MISMATCH: 409,
	NOT_CONNECTED: 503,
	LINK_CLOSED: 503,
	TIMEOUT: 504,
};

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
	return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

function isApiErrorLike(err: unknown): err is ApiError {
	if (err instanceof ApiError) return true;
	const e = err as { name?: unknown; status?: unknown; code?: unknown };
	return !!e && e.name === "ApiError" && typeof e.status === "number" && typeof e.code === "string";
}

export function toErrorResponse(err: unknown): { status: number; body: ApiErrorBody } {
	if (isApiErrorLike(err)) {
		const status = err.status >= 400 && err.status <= 599 ? err.status : 500;
		return { status, body: errorBody(err.code, err.message, err.details) };
	}
	const e = (err ?? {}) as {
		message?: unknown;
		code?: unknown;
		statusCode?: unknown;
		validation?: unknown;
		data?: unknown;
	};
	const message = typeof e.message === "string" && e.message ? e.message : String(err);
	if (e.validation) {
		return { status: 400, body: errorBody("BAD_REQUEST", `请求参数无效：${message}`) };
	}
	// Fastify's own client errors (malformed JSON, unsupported media type, body too large…).
	if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
		const code = typeof e.code === "string" ? e.code : "BAD_REQUEST";
		const text =
			e.statusCode === 413
				? "请求体过大"
				: e.statusCode === 415
					? "不支持的 Content-Type"
					: `请求格式错误：${message}`;
		return { status: e.statusCode, body: errorBody(code, text) };
	}
	if (typeof e.code === "string" && e.code) {
		return { status: CODE_STATUS[e.code] ?? 500, body: errorBody(e.code, message, e.data) };
	}
	return { status: 500, body: errorBody("INTERNAL", message) };
}
