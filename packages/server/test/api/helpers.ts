import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.js";
import type { AppOptions } from "../../src/app.js";
import { createFakeContext } from "./fakes.js";
import type { FakeContext } from "./fakes.js";

export const HOST = "127.0.0.1:7878";
export const ORIGIN = "http://127.0.0.1:7878";

export interface TestApp extends FakeContext {
	app: FastifyInstance;
	request(method: InjectOptions["method"], url: string, body?: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
}

/** A Fastify app over fake services; `request` adds same-origin Host/Origin headers like a browser. */
export async function createTestApp(
	options: { app?: AppOptions; webDistDir?: string | null } = {},
): Promise<TestApp> {
	const fake = createFakeContext({ webDistDir: options.webDistDir });
	const app = await buildApp(fake.ctx, options.app);
	return {
		...fake,
		app,
		request(method, url, body, headers = {}) {
			const isSafe = method === "GET" || method === "HEAD";
			return app.inject({
				method,
				url,
				headers: { host: HOST, ...(isSafe ? {} : { origin: ORIGIN }), ...headers },
				...(body === undefined ? {} : typeof body === "string" || Buffer.isBuffer(body) ? { payload: body } : { payload: body as object }),
			});
		},
	};
}
