import type { OAuthStatusResponse } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/types.js";
import { badRequest } from "./util.js";

export function oauthRoutes(app: FastifyInstance, ctx: AppContext): void {
	app.get("/oauth", async (): Promise<OAuthStatusResponse> => ctx.oauth.status());

	app.post<{ Params: { provider: string } }>("/oauth/:provider/refresh", async (request): Promise<OAuthStatusResponse> => {
		const provider = request.params.provider;
		if (!/^[A-Za-z0-9._:-]{1,200}$/.test(provider)) throw badRequest("provider 名称无效");
		return ctx.oauth.refresh(provider);
	});
}
