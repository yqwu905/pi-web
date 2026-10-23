import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgent, flush, makeServer, makeWorkspace } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import type { TestApp } from "./helpers.js";

let t: TestApp;
let agent: FakeAgent;

beforeEach(async () => {
	t = await createTestApp();
	await t.store.saveServer(makeServer());
	await t.store.saveWorkspace(makeWorkspace({ defaults: { provider: "anthropic", modelId: "m1" } }));
	agent = new FakeAgent();
	t.connections.agentFactory = () => agent.connect();
	t.connections.on("agent-connected", (serverId: string, client) => void t.ctx.conversations.attach(serverId, client));
});

afterEach(async () => {
	await t.app.close();
});

async function open(body: unknown = {}): Promise<string> {
	const res = await t.request("POST", "/api/workspaces/ws1/conversations", body);
	expect(res.statusCode).toBe(200);
	return res.json().convId as string;
}

describe("conversation routes", () => {
	it("opens a conversation and lists it", async () => {
		const res = await t.request("POST", "/api/workspaces/ws1/conversations", { thinkingLevel: "high", name: "Chat" });
		expect(res.statusCode).toBe(200);
		const view = res.json();
		expect(view).toMatchObject({ serverId: "srv1", workspaceId: "ws1", info: { status: "idle", cwd: "/home/dev/project" } });
		expect(agent.callsOf("conv.start")[0]).toMatchObject({
			model: { provider: "anthropic", modelId: "m1" },
			thinkingLevel: "high",
			name: "Chat",
		});
		const list = await t.request("GET", "/api/conversations");
		expect(list.json().conversations.map((c: { convId: string }) => c.convId)).toEqual([view.convId]);
	});

	it("validates open requests", async () => {
		expect((await t.request("POST", "/api/workspaces/ws1/conversations", { sessionFile: "rel.jsonl" })).statusCode).toBe(400);
		expect((await t.request("POST", "/api/workspaces/ws1/conversations", { model: { provider: "x" } })).statusCode).toBe(400);
		expect((await t.request("POST", "/api/workspaces/ws1/conversations", { thinkingLevel: "ultra" })).statusCode).toBe(400);
		const missing = await t.request("POST", "/api/workspaces/nope/conversations", {});
		expect(missing.statusCode).toBe(404);
		expect(missing.json().error.code).toBe("WORKSPACE_NOT_FOUND");
	});

	it("returns snapshots with configStale", async () => {
		const convId = await open();
		const snap = await t.request("GET", `/api/conversations/${convId}/snapshot`);
		expect(snap.json()).toMatchObject({ convId, serverId: "srv1", workspaceId: "ws1", configStale: false, snapshot: { seq: 0 } });
		t.syncer.lastChange.set("srv1", Date.now() + 5000);
		expect((await t.request("GET", `/api/conversations/${convId}/snapshot`)).json().configStale).toBe(true);
		const unknown = await t.request("GET", "/api/conversations/nope/snapshot");
		expect(unknown.statusCode).toBe(404);
		expect(unknown.json().error).toEqual({ code: "CONV_NOT_FOUND", message: "对话不存在或已结束" });
	});

	it("passes RPC commands through", async () => {
		const convId = await open();
		const res = await t.request("POST", `/api/conversations/${convId}/rpc`, { command: { type: "prompt", message: "hi" }, timeoutMs: 30_000 });
		expect(res.json()).toMatchObject({ type: "response", command: "prompt", success: true, seq: 0 });
		expect(agent.callsOf("conv.send")[0]).toEqual({ convId, command: { type: "prompt", message: "hi" }, timeoutMs: 30_000 });
		expect((await t.request("POST", `/api/conversations/${convId}/rpc`, { command: { message: "no type" } })).statusCode).toBe(400);
		expect((await t.request("POST", `/api/conversations/${convId}/rpc`, { command: { type: "abort" }, timeoutMs: 5 })).statusCode).toBe(400);
	});

	it("forwards UI responses", async () => {
		const convId = await open();
		const cases = [
			{ response: { id: "u1", value: "picked" } },
			{ response: { type: "extension_ui_response", id: "u2", confirmed: false } },
			{ response: { id: "u3", cancelled: true } },
		];
		for (const body of cases) {
			const res = await t.request("POST", `/api/conversations/${convId}/ui-response`, body);
			expect(res.json()).toEqual({ ok: true, delivered: true });
		}
		expect(agent.callsOf("conv.uiResponse").map((p) => p.response)).toEqual([
			{ type: "extension_ui_response", id: "u1", value: "picked" },
			{ type: "extension_ui_response", id: "u2", confirmed: false },
			{ type: "extension_ui_response", id: "u3", cancelled: true },
		]);
		expect((await t.request("POST", `/api/conversations/${convId}/ui-response`, { response: { id: "u4" } })).statusCode).toBe(400);
		// The agent did not pass it to pi (answered elsewhere, timed out).
		agent.handle("conv.uiResponse", () => ({ ok: true, delivered: false }));
		const dropped = await t.request("POST", `/api/conversations/${convId}/ui-response`, { response: { id: "u5", value: "late" } });
		expect(dropped.json()).toEqual({ ok: true, delivered: false });
	});

	it("runs companion actions", async () => {
		const convId = await open();
		await t.request("POST", `/api/conversations/${convId}/navigate`, { targetId: "e1", summarize: true, customInstructions: "short", label: "here" });
		await t.request("POST", `/api/conversations/${convId}/label`, { entryId: "e2", label: "" });
		await t.request("POST", `/api/conversations/${convId}/label`, { entryId: "e3", label: "keep" });
		const reload = await t.request("POST", `/api/conversations/${convId}/reload`);
		expect(reload.json()).toEqual({ ok: true });
		expect(agent.callsOf("conv.companion")).toEqual([
			{ convId, action: "navigate", args: { targetId: "e1", summarize: true, customInstructions: "short", label: "here" } },
			{ convId, action: "label", args: { entryId: "e2" } },
			{ convId, action: "label", args: { entryId: "e3", label: "keep" } },
			{ convId, action: "reload", args: {} },
		]);
		expect((await t.request("POST", `/api/conversations/${convId}/navigate`, {})).statusCode).toBe(400);
	});

	it("stops and replays", async () => {
		const convId = await open();
		expect((await t.request("POST", `/api/conversations/${convId}/stop`, { force: true })).json()).toEqual({ ok: true });
		await t.request("POST", `/api/conversations/${convId}/stop`);
		expect(agent.callsOf("conv.stop")).toEqual([{ convId, force: true }, { convId }]);

		agent.emitRecord(convId, { type: "agent_start" });
		agent.emitRecord(convId, { type: "agent_settled", aborted: false });
		await flush();
		const replay = await t.request("GET", `/api/conversations/${convId}/replay?afterSeq=1`);
		expect(replay.json()).toMatchObject({ complete: true, lastSeq: 2 });
		expect(replay.json().events.map((e: { seq: number }) => e.seq)).toEqual([2]);
		expect((await t.request("GET", `/api/conversations/${convId}/replay?afterSeq=-1`)).statusCode).toBe(400);
	});

	it("exports HTML as a download", async () => {
		const convId = await open();
		const conn = t.connections.get("srv1");
		agent.handle("conv.send", (p) => {
			conn.files.set(p.command.outputPath, Buffer.from("<html>export</html>"));
			return { type: "response", command: "export_html", success: true, data: { path: p.command.outputPath }, seq: 0 };
		});
		const res = await t.request("GET", `/api/conversations/${convId}/export`);
		expect(res.statusCode).toBe(200);
		expect(res.body).toBe("<html>export</html>");
		expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
		expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="sid-[0-9a-f]{8}\.html"/);
	});
});
