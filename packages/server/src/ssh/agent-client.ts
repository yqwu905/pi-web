import { EventEmitter } from "node:events";
import type { AgentHelloResult, AgentMethod, AgentParams, AgentResult } from "@pi-web/shared";
import { LinkRequestError, type LinkPeer } from "@pi-web/shared/link";
import { ApiError } from "../core/errors.js";
import type { AgentClient } from "../core/types.js";

const STATUS_BY_CODE: Record<string, number> = {
	NOT_FOUND: 404,
	ENOENT: 404,
	BUSY: 409,
	CONFLICT: 409,
	EEXIST: 409,
	INVALID: 400,
	INVALID_PARAMS: 400,
	BAD_REQUEST: 400,
	EACCES: 403,
	EPERM: 403,
	FORBIDDEN: 403,
	TOO_LARGE: 413,
	TIMEOUT: 504,
	LINK_CLOSED: 503,
	METHOD_NOT_FOUND: 501,
};

/** Converts a Link error into an ApiError (code and data preserved; HTTP status guessed from the code). */
export function linkErrorToApiError(err: unknown, method: string): unknown {
	if (err instanceof LinkRequestError) {
		const status = STATUS_BY_CODE[err.code] ?? 502;
		const message = err.code === "LINK_CLOSED" ? `与 Remote Agent 的连接已断开（${method}）` : err.message;
		return new ApiError(status, err.code, message, err.data);
	}
	return err;
}

/** Typed wrapper around a LinkPeer connected to a pi-web-agent. */
export class LinkAgentClient extends EventEmitter implements AgentClient {
	private closed = false;

	constructor(
		readonly serverId: string,
		readonly peer: LinkPeer,
		readonly hello: AgentHelloResult,
	) {
		super();
		peer.on("event", (name: string, data: unknown) => this.emit("event", name, data));
		peer.once("close", (err?: Error) => {
			this.closed = true;
			this.emit("close", err);
		});
	}

	get isClosed(): boolean {
		return this.closed || this.peer.closed;
	}

	async call<M extends AgentMethod>(
		method: M,
		params: AgentParams<M>,
		options?: { timeoutMs?: number },
	): Promise<AgentResult<M>> {
		try {
			return await this.peer.request<AgentResult<M>>(method, params, options);
		} catch (err) {
			throw linkErrorToApiError(err, method);
		}
	}

	close(): void {
		this.peer.close();
	}
}
