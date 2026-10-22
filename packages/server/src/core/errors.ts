import { ApiError } from "./types.js";

export { ApiError };

export function isApiError(err: unknown): err is ApiError {
	return err instanceof ApiError;
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

/** Reads a string `code` property from any error-like value. */
export function errorCode(err: unknown): string | undefined {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

export function badRequest(message: string, details?: unknown, code = "BAD_REQUEST"): ApiError {
	return new ApiError(400, code, message, details);
}

export function notFound(message: string, code = "NOT_FOUND"): ApiError {
	return new ApiError(404, code, message);
}

export function conflict(code: string, message: string, details?: unknown): ApiError {
	return new ApiError(409, code, message, details);
}

export function internalError(message: string, details?: unknown, code = "INTERNAL"): ApiError {
	return new ApiError(500, code, message, details);
}

/** Wraps unknown errors as ApiError(500) while keeping existing ApiErrors untouched. */
export function toApiError(err: unknown, fallbackCode = "INTERNAL", status = 500): ApiError {
	if (err instanceof ApiError) return err;
	return new ApiError(status, errorCode(err) ?? fallbackCode, errorMessage(err));
}

export function serverNotFound(serverId: string): ApiError {
	return new ApiError(404, "SERVER_NOT_FOUND", `服务器不存在：${serverId}`);
}
