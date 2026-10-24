#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible Chat Completions server for end-to-end tests and demos.
 *
 * Behaviour (based on the last message):
 *   - last message is a tool result        → short text summarizing the tool output
 *   - a compaction summary request          → a fixed summary (pi rejects tool calls there)
 *   - user text contains "run: <command>"  → a `bash` tool call with that command
 *   - user text contains "write: <path>"   → a `write` tool call creating <path>
 *   - user text contains "todo: <json>"    → a `todo` tool call with those arguments (rpiv-todo style)
 *   - anything else                        → streams "收到：<text>" in small chunks
 *
 * Usage: node e2e/mock-llm.mjs [--port 18080] [--host 127.0.0.1]
 * Every request is logged as one JSON line on stdout (method, path, host header, model).
 */
import { createServer } from "node:http";

const args = process.argv.slice(2);
const port = Number(argValue("--port") ?? 18080);
const host = argValue("--host") ?? "127.0.0.1";
let callCounter = 0;

function argValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
	return "";
}

function planReply(messages) {
	const last = messages[messages.length - 1] ?? {};
	if (last.role === "tool") {
		const out = textOf(last.content).trim().replace(/\s+/g, " ");
		return { text: `工具执行完成：${out.slice(0, 120) || "(无输出)"}` };
	}
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const text = textOf(lastUser?.content ?? "");
	// pi wraps the history to summarize in <conversation> tags; it may quote "run:" or "todo:" prompts.
	if (text.startsWith("<conversation>")) return { text: "## 摘要\nE2E 测试会话。" };
	const todo = text.match(/todo:\s*(\{.*\})\s*$/m);
	if (todo) return { tool: { name: "todo", arguments: JSON.parse(todo[1]) } };
	const run = text.match(/run:\s*(.+)$/m);
	if (run) return { tool: { name: "bash", arguments: { command: run[1].trim() } } };
	const write = text.match(/write:\s*(\S+)/);
	if (write) {
		return { tool: { name: "write", arguments: { path: write[1], content: `hello from mock-llm\n` } } };
	}
	return { text: `收到：${text.slice(0, 200)}` };
}

function chunk(id, model, delta, finishReason = null) {
	return {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const raw = Buffer.concat(chunks).toString("utf8");
	let body = {};
	try {
		body = raw ? JSON.parse(raw) : {};
	} catch {}
	console.log(JSON.stringify({ ts: Date.now(), method: req.method, path: req.url, host: req.headers.host, model: body.model }));

	if (req.method === "GET" && req.url?.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model", owned_by: "pi-web" }] }));
		return;
	}
	if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "not found" } }));
		return;
	}

	const model = body.model ?? "mock-1";
	const id = `chatcmpl-${++callCounter}`;
	const plan = planReply(body.messages ?? []);
	const usage = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 };

	if (!body.stream) {
		const message = plan.tool
			? {
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: `call_${callCounter}`, type: "function", function: { name: plan.tool.name, arguments: JSON.stringify(plan.tool.arguments) } },
					],
				}
			: { role: "assistant", content: plan.text };
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				id,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model,
				choices: [{ index: 0, message, finish_reason: plan.tool ? "tool_calls" : "stop" }],
				usage,
			}),
		);
		return;
	}

	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
	send(chunk(id, model, { role: "assistant", content: "" }));
	if (plan.tool) {
		const argsText = JSON.stringify(plan.tool.arguments);
		send(
			chunk(id, model, {
				tool_calls: [{ index: 0, id: `call_${callCounter}`, type: "function", function: { name: plan.tool.name, arguments: "" } }],
			}),
		);
		for (let i = 0; i < argsText.length; i += 8) {
			send(chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: argsText.slice(i, i + 8) } }] }));
			await sleep(5);
		}
		send(chunk(id, model, {}, "tool_calls"));
	} else {
		const text = plan.text;
		for (let i = 0; i < text.length; i += 3) {
			send(chunk(id, model, { content: text.slice(i, i + 3) }));
			await sleep(15);
		}
		send(chunk(id, model, {}, "stop"));
	}
	if (body.stream_options?.include_usage) {
		send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage });
	}
	res.write("data: [DONE]\n\n");
	res.end();
});

server.listen(port, host, () => {
	console.log(JSON.stringify({ ts: Date.now(), listening: `http://${host}:${port}` }));
});
