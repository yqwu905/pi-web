import { createServer, type IncomingMessage, type Server } from "node:http";

export interface MockOpenAi {
	server: Server;
	baseUrl: string;
	requests: Array<{ path: string; body: Record<string, unknown> }>;
	close(): Promise<void>;
}

/** Splits the reply into a few chunks so streaming produces several text deltas. */
function chunks(text: string): string[] {
	const size = Math.max(1, Math.ceil(text.length / 3));
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (c: string) => (body += c));
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

/** OpenAI-compatible /v1/chat/completions mock that streams `reply(request)` as SSE. */
export async function startMockOpenAi(reply: (body: Record<string, unknown>) => string): Promise<MockOpenAi> {
	const requests: MockOpenAi["requests"] = [];
	const server = createServer(async (req, res) => {
		const raw = await readBody(req);
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(raw);
		} catch {
			// keep empty
		}
		requests.push({ path: req.url ?? "", body });
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(body.model ?? "mock") };
		const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
		for (const part of chunks(reply(body))) {
			send({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
			await new Promise((r) => setTimeout(r, 5));
		}
		send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		send({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return {
		server,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
