import type { HostInventory, SyncPlan, SyncRecord, SyncRunResponse, SyncStatusResponse } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/types.js";
import { bodyObject, optStringArray, queryInt, reqString, requireServer } from "./util.js";
import type { Json } from "./util.js";

export function syncRoutes(app: FastifyInstance, ctx: AppContext): void {
	app.get("/sync/inventory", async (): Promise<HostInventory> => ctx.syncer.inventory());

	app.get("/sync/status", async (): Promise<SyncStatusResponse> => ctx.syncer.status());

	app.post("/sync/preview", async (request): Promise<SyncPlan> => {
		const server = requireServer(ctx, reqString(bodyObject(request.body), "serverId", { max: 200 }));
		return ctx.syncer.preview(server.id);
	});

	app.post("/sync/run", async (request): Promise<SyncRunResponse> => {
		const serverIds = optStringArray(bodyObject(request.body), "serverIds", { maxItems: 1000 });
		if (serverIds) for (const id of serverIds) requireServer(ctx, id);
		return { records: await ctx.syncer.runMany(serverIds, "manual") };
	});

	app.get("/sync/history", async (request): Promise<{ records: SyncRecord[] }> => {
		const limit = queryInt(request.query as Json, "limit", 1, 1000) ?? 100;
		return { records: ctx.store.listSyncRecords(limit) };
	});
}
