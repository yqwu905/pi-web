import { describe, expect, it } from "vitest";
import type { ConvEvent, ConversationView } from "@pi-web/shared";
import { ApiError } from "../../src/core/types.js";
import { sanitizeFileName } from "../../src/conv/index.js";
import { FakeAgent, createFakeContext, flush, makeServer, makeWorkspace, until } from "../api/fakes.js";
import type { FakeContext } from "../api/fakes.js";

async function setup(options: { workspaces?: boolean } = {}) {
	const fake = createFakeContext();
	await fake.store.saveServer(makeServer());
	if (options.workspaces !== false) await fake.store.saveWorkspace(makeWorkspace());
	const agent = new FakeAgent("srv1");
	fake.connections.agentFactory = () => agent.connect();
	// Mirror the composition root: agent-connected → attach, agent-disconnected → detach.
	fake.connections.on("agent-connected", (serverId: string, client) => {
		void fake.ctx.conversations.attach(serverId, client);
	});
	fake.connections.on("agent-disconnected", (serverId: string) => fake.ctx.conversations.detach(serverId));
	return { fake, agent };
}

function convEvents(fake: FakeContext, convId: string): ConvEvent[] {
	return fake.hub.topic<ConvEvent>(`conv:${convId}`);
}

async function connect(fake: FakeContext): Promise<void> {
	await fake.connections.connect("srv1");
	await flush();
}

describe("ConversationService.attach", () => {
	it("lists the agent's conversations, matches workspaces by cwd and publishes them", async () => {
		const { fake, agent } = await setup();
		agent.addConv({ convId: "c1", cwd: "/home/dev/project/", status: "running", lastSeq: 7 });
		agent.addConv({ convId: "c2", cwd: "/elsewhere", status: "waiting_ui" });
		await connect(fake);

		const list = fake.ctx.conversations.list();
		expect(list.map((c) => c.convId).sort()).toEqual(["c1", "c2"]);
		expect(fake.ctx.conversations.get("c1")).toMatchObject({ serverId: "srv1", workspaceId: "ws1" });
		expect(fake.ctx.conversations.get("c2")?.workspaceId).toBeNull();
		expect(fake.hub.topic<ConversationView>("convs").map((v) => v.convId).sort()).toEqual(["c1", "c2"]);
		expect(fake.connections.status("srv1")).toMatchObject({ conversationsRunning: 1, conversationsWaiting: 1 });
		// A host that just learned about a conversation does not replay history the browser never had.
		expect(agent.callsOf("conv.replay")).toEqual([]);
	});

	it("forwards live events in order and ignores duplicates", async () => {
		const { fake, agent } = await setup();
		agent.addConv({ convId: "c1", cwd: "/home/dev/project" });
		await connect(fake);

		agent.emitRecord("c1", { type: "agent_start" });
		agent.emitRecord("c1", { type: "turn_start" });
		await flush();
		// A duplicate (same seq) pushed again must not be republished.
		agent.broadcast("conv.event", agent.events.get("c1")![1]);
		await flush();
		expect(convEvents(fake, "c1").map((e) => e.seq)).toEqual([1, 2]);
		expect(convEvents(fake, "c1")[0].record).toEqual({ type: "agent_start" });
	});

	it("tracks conv.info status changes and updates server counts", async () => {
		const { fake, agent } = await setup();
		agent.addConv({ convId: "c1", cwd: "/home/dev/project" });
		await connect(fake);
		agent.setStatus("c1", "running");
		await flush();
		expect(fake.ctx.conversations.get("c1")?.info.status).toBe("running");
		expect(fake.connections.status("srv1").conversationsRunning).toBe(1);
		agent.setStatus("c1", "waiting_ui");
		await flush();
		expect(fake.connections.status("srv1")).toMatchObject({ conversationsRunning: 0, conversationsWaiting: 1 });
		expect(convEvents(fake, "c1").map((e) => e.record.type)).toEqual(["pi_web_status", "pi_web_status"]);
	});

	it("replays events missed while the link was down, in seq order", async () => {
		const { fake, agent } = await setup();
		agent.addConv({ convId: "c1", cwd: "/home/dev/project" });
		await connect(fake);
		agent.emitRecord("c1", { type: "agent_start" });
		await flush();
		expect(convEvents(fake, "c1").map((e) => e.seq)).toEqual([1]);

		const conn = fake.connections.get("srv1");
		conn.disconnectAgent();
		await flush();
		agent.emitRecord("c1", { type: "turn_start" });
		agent.emitRecord("c1", { type: "turn_end", message: { role: "user", content: "x", timestamp: 1 }, toolResults: [] });
		expect(convEvents(fake, "c1")).toHaveLength(1);

		// Hold the replay response until a live event arrived, to check buffering keeps the order.
		const replayHandler = agent.handlers.get("conv.replay")!;
		let releaseReplay!: () => void;
		const gate = new Promise<void>((r) => (releaseReplay = r));
		agent.handle("conv.replay", async (p) => {
			await gate;
			return replayHandler(p);
		});
		const client = agent.connect();
		const attaching = fake.ctx.conversations.attach("srv1", client);
		await until(() => agent.callsOf("conv.replay").length === 1);
		agent.emitRecord("c1", { type: "agent_settled", aborted: false });
		await flush();
		releaseReplay();
		await attaching;

		expect(agent.callsOf("conv.replay")).toEqual([{ convId: "c1", afterSeq: 1 }]);
		expect(convEvents(fake, "c1").map((e) => e.seq)).toEqual([1, 2, 3, 4]);
	});

	it("publishes a resync marker when the agent's buffer no longer covers the gap", async () => {
		const { fake, agent } = await setup();
		agent.addConv({ convId: "c1", cwd: "/home/dev/project", sessionFile: "/s/a.jsonl" });
		await connect(fake);
		agent.emitRecord("c1", { type: "agent_start" });
		await flush();
		fake.connections.get("srv1").disconnectAgent();
		await flush();
		for (let i = 0; i < 5; i++) agent.emitRecord("c1", { type: "turn_start" });
		agent.ringStart.set("c1", 4); // events 2..3 fell out of the ring buffer

		await fake.ctx.conversations.attach("srv1", agent.connect());
		const events = convEvents(fake, "c1");
		expect(events.map((e) => e.seq)).toEqual([1, 6]);
		expect(events[1].record).toMatchObject({ type: "pi_web_session_changed", sessionFile: "/s/a.jsonl" });

		// Later live events continue after the marker.
		agent.emitRecord("c1", { type: "agent_settled", aborted: false });
		await flush();
		expect(convEvents(fake, "c1").map((e) => e.seq)).toEqual([1, 6, 7]);
	});

	it("marks conversations the agent no longer knows as exited", async () => {
		const { fake, agent } = await setup();
		agent.addConv({ convId: "c1", cwd: "/home/dev/project", status: "running" });
		await connect(fake);
		agent.emitRecord("c1", { type: "agent_start" });
		await flush();
		fake.connections.get("srv1").disconnectAgent();
		agent.convs.clear(); // daemon restarted

		await fake.ctx.conversations.attach("srv1", agent.connect());
		expect(fake.ctx.conversations.get("c1")?.info.status).toBe("exited");
		const last = convEvents(fake, "c1").at(-1)!;
		expect(last).toMatchObject({ seq: 2, record: { type: "pi_web_exit", code: null } });
		expect(fake.connections.status("srv1").conversationsRunning).toBe(0);
	});

	it("drops exited conversations after the retention period", async () => {
		const fake = createFakeContext({ conversations: { exitedRetentionMs: 30 } });
		await fake.store.saveServer(makeServer());
		const agent = new FakeAgent();
		agent.addConv({ convId: "c1", cwd: "/x", status: "exited" });
		await fake.ctx.conversations.attach("srv1", agent.connect());
		expect(fake.ctx.conversations.get("c1")).toBeDefined();
		await until(() => fake.ctx.conversations.get("c1") === undefined);
	});
});

describe("ConversationService.open", () => {
	it("connects when needed, waits for attach and starts pi with workspace defaults", async () => {
		const { fake, agent } = await setup();
		await fake.store.saveWorkspace(
			makeWorkspace({
				defaults: { provider: "anthropic", modelId: "claude-x", thinkingLevel: "high" },
				env: { FOO: "1" },
				trust: "no-approve",
			}),
		);
		const view = await fake.ctx.conversations.open("ws1", {});
		expect(fake.connections.calls.map((c) => c.method)).toContain("connect");
		const [params] = agent.callsOf("conv.start");
		expect(params).toMatchObject({
			cwd: "/home/dev/project",
			trust: "no-approve",
			model: { provider: "anthropic", modelId: "claude-x" },
			thinkingLevel: "high",
			env: { FOO: "1" },
		});
		expect(params.sessionFile).toBeUndefined();
		expect(view).toMatchObject({ convId: params.convId, serverId: "srv1", workspaceId: "ws1" });
		expect(fake.ctx.conversations.list()).toHaveLength(1);
		expect(fake.hub.topic<ConversationView>("convs").at(-1)?.convId).toBe(params.convId);
	});

	it("prefers request values over workspace defaults and reuses an attached process", async () => {
		const { fake, agent } = await setup();
		await fake.store.saveWorkspace(makeWorkspace({ defaults: { provider: "a", modelId: "b", thinkingLevel: "low" } }));
		agent.addConv({ convId: "running1", cwd: "/home/dev/project", sessionFile: "/s/1.jsonl", status: "idle" });
		await connect(fake);
		const view = await fake.ctx.conversations.open("ws1", {
			sessionFile: "/s/1.jsonl",
			model: { provider: "openai", modelId: "gpt" },
			thinkingLevel: "off",
			name: "Named",
		});
		const params = agent.callsOf("conv.start")[0];
		expect(params).toMatchObject({
			sessionFile: "/s/1.jsonl",
			model: { provider: "openai", modelId: "gpt" },
			thinkingLevel: "off",
			name: "Named",
		});
		expect(view.convId).toBe("running1");
	});

	it("rejects unknown workspaces", async () => {
		const { fake } = await setup({ workspaces: false });
		await expect(fake.ctx.conversations.open("nope", {})).rejects.toMatchObject({ status: 404, code: "WORKSPACE_NOT_FOUND" });
	});

	it("fails with AGENT_NOT_READY when attach never happens", async () => {
		const fake = createFakeContext({ conversations: { attachWaitMs: 50 } });
		await fake.store.saveServer(makeServer());
		await fake.store.saveWorkspace(makeWorkspace());
		const agent = new FakeAgent();
		fake.connections.agentFactory = () => agent.connect();
		await expect(fake.ctx.conversations.open("ws1", {})).rejects.toMatchObject({ status: 503, code: "AGENT_NOT_READY" });
	});
});

describe("ConversationService commands", () => {
	async function withConversation() {
		const ctx = await setup();
		await connect(ctx.fake);
		const view = await ctx.fake.ctx.conversations.open("ws1", {});
		return { ...ctx, convId: view.convId };
	}

	it("snapshot reports configStale from the syncer's last change, cleared by reload", async () => {
		const { fake, convId } = await withConversation();
		let snap = await fake.ctx.conversations.snapshot(convId);
		expect(snap).toMatchObject({ convId, serverId: "srv1", workspaceId: "ws1", configStale: false });
		expect(snap.snapshot.info.convId).toBe(convId);

		fake.syncer.lastChange.set("srv1", Date.now() - 60_000);
		expect((await fake.ctx.conversations.snapshot(convId)).configStale).toBe(false);

		fake.syncer.lastChange.set("srv1", Date.now() + 1000);
		snap = await fake.ctx.conversations.snapshot(convId);
		expect(snap.configStale).toBe(true);

		await fake.ctx.conversations.companion(convId, "reload", {});
		fake.syncer.lastChange.set("srv1", Date.now() - 1);
		expect((await fake.ctx.conversations.snapshot(convId)).configStale).toBe(false);
	});

	it("passes rpc, ui responses, companion actions, stop and replay to the agent", async () => {
		const { fake, agent, convId } = await withConversation();
		const response = await fake.ctx.conversations.rpc(convId, { type: "get_state" });
		expect(response).toMatchObject({ type: "response", command: "get_state", success: true, seq: 0 });
		await fake.ctx.conversations.rpc(convId, { type: "compact" }, 5000);
		expect(agent.callsOf("conv.send")).toEqual([
			{ convId, command: { type: "get_state" } },
			{ convId, command: { type: "compact" }, timeoutMs: 5000 },
		]);

		await fake.ctx.conversations.uiResponse(convId, { type: "extension_ui_response", id: "u1", confirmed: true });
		expect(agent.callsOf("conv.uiResponse")).toEqual([{ convId, response: { type: "extension_ui_response", id: "u1", confirmed: true } }]);

		const result = await fake.ctx.conversations.companion(convId, "navigate", { targetId: "e1", summarize: true });
		expect(result).toEqual({ ok: true });
		expect(agent.callsOf("conv.companion")).toEqual([{ convId, action: "navigate", args: { targetId: "e1", summarize: true } }]);

		await fake.ctx.conversations.stop(convId, true);
		await fake.ctx.conversations.stop(convId);
		expect(agent.callsOf("conv.stop")).toEqual([{ convId, force: true }, { convId }]);

		agent.emitRecord(convId, { type: "agent_start" });
		const replay = await fake.ctx.conversations.replay(convId, 0);
		expect(replay).toMatchObject({ complete: true, lastSeq: 1 });
		expect(replay.events.map((e) => e.seq)).toEqual([1]);
	});

	it("exports HTML through a temporary remote file that is removed afterwards", async () => {
		const { fake, agent, convId } = await withConversation();
		const conn = fake.connections.get("srv1");
		agent.handle("conv.send", (p) => {
			conn.files.set(p.command.outputPath, Buffer.from("<html>hi</html>"));
			return { type: "response", command: "export_html", success: true, data: { path: p.command.outputPath }, seq: 0 };
		});
		agent.convs.get(convId)!.sessionName = "My: chat/1";
		await fake.ctx.conversations.snapshot(convId); // refresh info (sessionName)

		const { stream, size, fileName } = await fake.ctx.conversations.exportHtml(convId);
		const outputPath = agent.callsOf("conv.send")[0].command.outputPath as string;
		expect(outputPath).toMatch(new RegExp(`^/home/dev/\\.pi-web/state/exports/${convId}-\\d+\\.html$`));
		expect(agent.callsOf("fs.mkdir")).toContainEqual({ path: "/home/dev/.pi-web/state/exports", recursive: true });
		expect(fileName).toBe("My_ chat_1.html");
		expect(size).toBe(15);
		const chunks: Buffer[] = [];
		for await (const chunk of stream) chunks.push(chunk as Buffer);
		expect(Buffer.concat(chunks).toString()).toBe("<html>hi</html>");
		await until(() => conn.execs.length > 0);
		expect(conn.execs).toEqual([`rm -f ${outputPath}`]);
	});

	it("reports export failures in Chinese", async () => {
		const { fake, agent, convId } = await withConversation();
		agent.handle("conv.send", () => ({ type: "response", command: "export_html", success: false, error: "boom", seq: 0 }));
		await expect(fake.ctx.conversations.exportHtml(convId)).rejects.toMatchObject({ status: 500, code: "EXPORT_FAILED", message: "导出失败：boom" });
	});

	it("rejects unknown conversations and disconnected servers", async () => {
		const { fake, convId } = await withConversation();
		await expect(fake.ctx.conversations.snapshot("nope")).rejects.toBeInstanceOf(ApiError);
		await expect(fake.ctx.conversations.rpc("nope", { type: "abort" })).rejects.toMatchObject({ status: 404 });
		fake.connections.get("srv1").disconnectAgent();
		await flush();
		await expect(fake.ctx.conversations.snapshot(convId)).rejects.toMatchObject({ status: 503, code: "NOT_CONNECTED" });
	});
});

describe("sanitizeFileName", () => {
	it("replaces path and control characters and falls back when empty", () => {
		expect(sanitizeFileName("a/b\\c:d*e?f\"g<h>i|j", "x")).toBe("a_b_c_d_e_f_g_h_i_j");
		expect(sanitizeFileName("  ..  ", "fallback")).toBe("fallback");
		expect(sanitizeFileName("会话 一", "x")).toBe("会话 一");
	});
});
