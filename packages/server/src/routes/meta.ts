import { hostname } from "node:os";
import type { MetaResponse } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/types.js";

export function metaRoutes(app: FastifyInstance, ctx: AppContext): void {
	app.get("/meta", async (request): Promise<MetaResponse> => {
		if (!request.authenticated) {
			// Reachable without a token (the UI needs `authenticated`); reveal nothing else.
			return { version: ctx.version, hostname: "", hostAgentDir: "", hostPiVersion: null, dataDir: "", authenticated: false };
		}
		let hostPiVersion: string | null = null;
		try {
			hostPiVersion = await ctx.hostPi.version();
		} catch {
			hostPiVersion = null;
		}
		return {
			version: ctx.version,
			hostname: hostname(),
			hostAgentDir: ctx.hostPi.agentDir ?? ctx.paths.hostAgentDir,
			hostPiVersion,
			dataDir: ctx.paths.dataDir,
			authenticated: true,
		};
	});
}
