import type { Readable } from "node:stream";
import type { CacheEntry, CacheResponse } from "@pi-web/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../core/types.js";
import { badRequest, queryRequired } from "./util.js";
import type { Json } from "./util.js";

const CACHE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const NODE_TARBALL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.tar\.(xz|gz)$/;
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

export function cacheRoutes(app: FastifyInstance, ctx: AppContext): void {
	app.get("/cache", async (): Promise<CacheResponse> => ctx.deployer.listCache());

	app.delete<{ Params: { name: string } }>("/cache/:name", async (request) => {
		const name = request.params.name;
		if (!CACHE_NAME.test(name) || name.includes("..")) throw badRequest("缓存名称无效");
		await ctx.deployer.deleteCache(name);
		return { ok: true as const };
	});

	// Raw upload: the body is streamed to the deployer, whatever its content type.
	app.register(async (scoped) => {
		scoped.removeAllContentTypeParsers();
		scoped.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
		scoped.post("/cache/import-node", { bodyLimit: MAX_IMPORT_BYTES }, async (request): Promise<CacheEntry> => {
			const fileName = queryRequired(request.query as Json, "fileName");
			if (!NODE_TARBALL.test(fileName) || fileName.includes("..")) {
				throw badRequest("文件名必须是 .tar.xz 或 .tar.gz 格式的 Node.js 发行包");
			}
			const body = request.body as Readable | undefined;
			if (!body || typeof (body as Readable).pipe !== "function") throw badRequest("缺少上传的文件内容");
			return ctx.deployer.importNodeTarball(fileName, body);
		});
	});
}
