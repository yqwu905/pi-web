import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/types.js";
import { authRoutes } from "./auth.js";
import type { AccessControl } from "./auth.js";
import { cacheRoutes } from "./cache.js";
import { conversationRoutes } from "./conversations.js";
import { fileRoutes } from "./files.js";
import { gitRoutes } from "./git.js";
import { metaRoutes } from "./meta.js";
import { oauthRoutes } from "./oauth.js";
import { serverRoutes } from "./servers.js";
import type { ServerRouteOptions } from "./servers.js";
import { sessionRoutes } from "./sessions.js";
import { settingsRoutes } from "./settings.js";
import { syncRoutes } from "./sync.js";
import { workspaceRoutes } from "./workspaces.js";

export interface ApiRouteOptions extends ServerRouteOptions {
	auth: AccessControl;
}

/** Registers every REST route; mount with `{ prefix: "/api" }`. */
export function registerApiRoutes(api: FastifyInstance, ctx: AppContext, options: ApiRouteOptions): void {
	metaRoutes(api, ctx);
	authRoutes(api, options.auth);
	settingsRoutes(api, ctx, options.auth);
	serverRoutes(api, ctx, options);
	workspaceRoutes(api, ctx);
	fileRoutes(api, ctx);
	gitRoutes(api, ctx);
	sessionRoutes(api, ctx);
	conversationRoutes(api, ctx);
	syncRoutes(api, ctx);
	oauthRoutes(api, ctx);
	cacheRoutes(api, ctx);
}

export { createAccessControl, ACCESS_TOKEN_SECRET_KEY, TOKEN_COOKIE } from "./auth.js";
export type { AccessControl } from "./auth.js";
export { errorBody, toErrorResponse } from "./errors.js";
