import { mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentConfig, AgentEventMap, ConvEvent, ProxyStreamMeta, RpcResponseData, SessionTreeNode } from "@pi-web/shared";
import { LinkPeer } from "@pi-web/shared/link";
import { ConversationManager } from "../src/daemon/conversations.js";
import { remotePaths } from "../src/daemon/paths.js";
import { ProxyListener } from "../src/daemon/proxy.js";
import { cleanupTempDirs, distDir, makeConfig, packageDir, silentLog, socketPair, tempDir, waitFor } from "./helpers.js";
import { type MockOpenAi, startMockOpenAi } from "./mock-openai.js";

const piCli = join(packageDir, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

let mock: MockOpenAi;
let manager: ConversationManager;
let config: AgentConfig;
let cwd: string;
let proxy: ProxyListener;
let hostPeer: LinkPeer;
let agentPeer: LinkPeer;
const tunnels: ProxyStreamMeta[] = [];
const events: ConvEvent[] = [];
let firstSessionFile = "";

function since(seq: number): ConvEvent[] {
	return events.filter((e) => e.seq > seq);
}

beforeAll(async () => {
	mock = await startMockOpenAi(() => "Hello from the mock model.");
	const root = await tempDir("pwa-real-");
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				mocklab: {
					baseUrl: mock.baseUrl,
					api: "openai-completions",
					apiKey: "test",
					models: [
						{
							id: "mock-1",
							name: "Mock One",
							reasoning: false,
							input: ["text"],
							contextWindow: 32000,
							maxTokens: 1024,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "mocklab", defaultModel: "mock-1", quietStartup: true }));
	cwd = join(root, "workspace");
	await mkdir(cwd, { recursive: true });
	config = makeConfig(root, { agentDir, piCliPath: piCli, companionExtPath: join(distDir, "pi-web-ext.mjs") });
	manager = new ConversationManager({
		paths: remotePaths(root),
		getConfig: () => config,
		emit: <E extends keyof AgentEventMap>(event: E, data: AgentEventMap[E]) => {
			if (event === "conv.event") events.push(data as ConvEvent);
		},
		log: silentLog,
		reapIntervalMs: 0,
	});

	// Host side of an in-memory Link that dials the requested target (like TunnelProxy).
	const [a, b] = socketPair();
	hostPeer = new LinkPeer(a, { side: "host" });
	agentPeer = new LinkPeer(b, { side: "agent" });
	hostPeer.onStreamOpen((meta: ProxyStreamMeta, control) => {
		tunnels.push(meta);
		const upstream = connect(meta.port, meta.host);
		upstream.once("connect", () => {
			const stream = control.accept();
			stream.pipe(upstream);
			upstream.pipe(stream);
			stream.on("error", () => upstream.destroy());
			upstream.on("error", () => stream.destroy());
		});
		upstream.once("error", (err) => control.reject(err.message, 502));
	});
	proxy = new ProxyListener({ getPeer: () => agentPeer });
	await proxy.start(0, "real-pi-proxy-token");
});

afterAll(async () => {
	await manager?.shutdownAll();
	manager?.dispose();
	await proxy?.stop();
	hostPeer?.close();
	await mock?.close();
	await cleanupTempDirs();
});

describe("real pi in RPC mode", () => {
	it("streams a reply from a custom provider and serves companion actions", async () => {
		const started = await manager.start({ convId: "real", cwd, trust: "no-approve", name: "Integration" });
		expect(started.state.model).toMatchObject({ provider: "mocklab", id: "mock-1" });
		expect(started.conv.status).toBe("idle");

		const sent = await manager.send({ convId: "real", command: { type: "prompt", message: "Say hello" } });
		expect(sent.success).toBe(true);
		expect((sent.data as RpcResponseData["prompt"]).disposition).toBe("started");
		await waitFor(() => events.find((e) => e.record.type === "agent_settled"), 30_000, 50);

		const deltas = events
			.filter((e) => e.record.type === "message_update")
			.map((e) => (e.record as { assistantMessageEvent: { type: string; delta?: string } }).assistantMessageEvent)
			.filter((a) => a.type === "text_delta")
			.map((a) => a.delta ?? "");
		expect(deltas.length).toBeGreaterThan(1);
		expect(deltas.join("")).toBe("Hello from the mock model.");
		expect(mock.requests.some((r) => r.path.endsWith("/chat/completions") && r.body.model === "mock-1")).toBe(true);
		await waitFor(() => manager.get("real")?.status === "idle");

		const snap = await manager.snapshot({ convId: "real" });
		const roles = snap.messages.map((m) => m.role).filter((r) => r !== "system");
		expect(roles).toEqual(["user", "assistant"]);
		expect(snap.isRunning).toBe(false);
		expect(snap.seq).toBeGreaterThan(0);
		expect(snap.state.sessionName).toBe("Integration");
		expect(snap.stats?.sessionId).toBe(snap.state.sessionId);
		expect(manager.findBySessionFile(snap.state.sessionFile as string)?.convId).toBe("real");
		firstSessionFile = snap.state.sessionFile as string;

		// label: attach a label to the user message entry through the companion extension
		const entries = await manager.send({ convId: "real", command: { type: "get_entries" } });
		const userEntry = (entries.data as RpcResponseData["get_entries"]).entries.find(
			(e) => e.type === "message" && e.message.role === "user",
		);
		expect(userEntry).toBeTruthy();
		const label = await manager.companion({ convId: "real", action: "label", args: { entryId: userEntry!.id, label: "checkpoint" } });
		expect(label).toEqual({ ok: true });
		const tree = await manager.send({ convId: "real", command: { type: "get_tree" } });
		const flatten = (nodes: SessionTreeNode[]): SessionTreeNode[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);
		const labelled = flatten((tree.data as RpcResponseData["get_tree"]).tree).find((n) => n.entry.id === userEntry!.id);
		expect(labelled?.label).toBe("checkpoint");
		const badLabel = await manager.companion({ convId: "real", action: "label", args: { entryId: "nope", label: "x" } });
		expect(badLabel.ok).toBe(false);
		expect(badLabel.error).toContain("nope");

		// reload: the extension reports after ctx.reload() using the ui captured beforehand
		const before = manager.get("real")?.lastSeq ?? 0;
		const reload = await manager.companion({ convId: "real", action: "reload" });
		expect(reload).toEqual({ ok: true });
		expect(since(before).some((e) => e.record.type === "extension_error")).toBe(false);
		// companion commands still work after the reload (the extension was re-registered)
		const relabel = await manager.companion({ convId: "real", action: "label", args: { entryId: userEntry!.id } });
		expect(relabel).toEqual({ ok: true });

		// navigate to the user message: the leaf moves and viewers are told to resync
		const nav = await manager.companion({ convId: "real", action: "navigate", args: { targetId: userEntry!.id } });
		expect(nav).toEqual({ ok: true, cancelled: false });
		expect(since(before).some((e) => e.record.type === "pi_web_session_changed")).toBe(true);

		await manager.stop({ convId: "real" });
		expect(manager.get("real")?.status).toBe("exited");
		expect(manager.get("real")?.exitCode).toBe(0);
	}, 90_000);

	it("sends LLM traffic through the agent proxy and the Link tunnel", async () => {
		config = { ...config, proxy: { enabled: true, port: proxy.port, token: "real-pi-proxy-token", scope: "llm", noProxy: [] } };
		const requestsBefore = mock.requests.length;
		const started = await manager.start({ convId: "proxied", cwd, trust: "no-approve" });
		expect(started.conv.status).toBe("idle");
		const before = started.conv.lastSeq;
		await manager.send({ convId: "proxied", command: { type: "prompt", message: "Through the tunnel" } });
		const settled = await waitFor(
			() => events.find((e) => e.convId === "proxied" && e.seq > before && e.record.type === "agent_settled"),
			30_000,
			50,
		);
		expect(settled).toBeTruthy();
		const text = events
			.filter((e) => e.convId === "proxied" && e.record.type === "message_end")
			.map((e) => JSON.stringify(e.record))
			.join("");
		expect(text).toContain("Hello from the mock model.");
		expect(mock.requests.length).toBeGreaterThan(requestsBefore);
		const mockPort = Number(new URL(mock.baseUrl).port);
		expect(tunnels).toContainEqual({ kind: "proxy", host: "127.0.0.1", port: mockPort, protocol: "connect" });
		await manager.stop({ convId: "proxied" });
	}, 90_000);

	it("resumes an existing session file with --session", async () => {
		expect(firstSessionFile).toBeTruthy();
		const resumed = await manager.start({ convId: "resumed", cwd, trust: "no-approve", sessionFile: firstSessionFile });
		expect(resumed.attached).toBe(false);
		expect(resumed.state.sessionFile).toBe(firstSessionFile);
		const snap = await manager.snapshot({ convId: "resumed" });
		const texts = snap.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m));
		expect(texts.join("")).toContain("Say hello");
		const again = await manager.start({ convId: "other", cwd, trust: "no-approve", sessionFile: firstSessionFile });
		expect(again).toMatchObject({ attached: true, conv: { convId: "resumed" } });
		await manager.stop({ convId: "resumed" });
	}, 60_000);
});
