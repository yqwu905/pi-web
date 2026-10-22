import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig, AgentEventMap, ConvEvent, ConvInfo } from "@pi-web/shared";
import { buildPiArgs, buildPiEnv, ConversationManager, type ConversationManagerOptions } from "../src/daemon/conversations.js";
import { remotePaths } from "../src/daemon/paths.js";
import { cleanupTempDirs, makeConfig, silentLog, tempDir, waitFor } from "./helpers.js";

interface Harness {
	manager: ConversationManager;
	events: ConvEvent[];
	infos: ConvInfo[];
	config: AgentConfig;
	cwd: string;
	root: string;
}

const managers: ConversationManager[] = [];

async function setup(options: Partial<ConversationManagerOptions> & { config?: Partial<AgentConfig> } = {}): Promise<Harness> {
	const root = await tempDir();
	const cwd = join(root, "ws");
	await mkdir(cwd, { recursive: true });
	const config = makeConfig(root, options.config);
	const events: ConvEvent[] = [];
	const infos: ConvInfo[] = [];
	const manager = new ConversationManager({
		paths: remotePaths(root),
		getConfig: () => config,
		emit: <E extends keyof AgentEventMap>(event: E, data: AgentEventMap[E]) => {
			if (event === "conv.event") events.push(data as ConvEvent);
			if (event === "conv.info") infos.push(data as ConvInfo);
		},
		log: silentLog,
		reapIntervalMs: 0,
		stopGraceMs: 300,
		killGraceMs: 300,
		...options,
	});
	managers.push(manager);
	return { manager, events, infos, config, cwd, root };
}

afterEach(async () => {
	for (const m of managers.splice(0)) {
		await m.shutdownAll();
		m.dispose();
	}
	await cleanupTempDirs();
});

const types = (events: ConvEvent[]) => events.map((e) => e.record.type);

describe("spawn arguments and environment", () => {
	it("builds pi argv from the start params", () => {
		const config = makeConfig("/r");
		expect(
			buildPiArgs(
				config,
				{ convId: "c", cwd: "/w", trust: "approve", model: { provider: "p", modelId: "m" }, thinkingLevel: "high", name: "N" },
				"/s.jsonl",
			),
		).toEqual([config.piCliPath, "--mode", "rpc", "--session", "/s.jsonl", "--approve", "-e", config.companionExtPath, "--model", "p/m", "--thinking", "high", "--name", "N"]);
		expect(buildPiArgs(config, { convId: "c", cwd: "/w", trust: "no-approve" })).toEqual([
			config.piCliPath,
			"--mode",
			"rpc",
			"--no-approve",
			"-e",
			config.companionExtPath,
		]);
	});

	it("strips inherited proxy variables and injects the agent proxy", () => {
		const base = { PATH: "/usr/bin", HTTPS_PROXY: "http://corp:3128", no_proxy: "x", HOME: "/home/u" };
		const off = buildPiEnv(makeConfig("/r"), remotePaths("/r"), {}, base);
		expect(off.HTTPS_PROXY).toBeUndefined();
		expect(off.no_proxy).toBeUndefined();
		expect(off.PI_OFFLINE).toBe("1");
		expect(off.PI_SKIP_VERSION_CHECK).toBe("1");
		expect(off.PI_TELEMETRY).toBe("0");
		expect(off.PI_CODING_AGENT_DIR).toBe("/r/agent");
		expect(off.PATH.split(":").slice(0, 2)).toEqual(["/r/bin", process.execPath.replace(/\/[^/]+$/, "")]);
		expect(off.PATH.endsWith("/usr/bin")).toBe(true);

		const on = buildPiEnv(
			makeConfig("/r", {
				proxy: { enabled: true, port: 31000, token: "abcdef0123456789", scope: "llm", noProxy: ["localhost", "10.0.0.5"] },
				extraEnv: { EXTRA_A: "1", WS_B: "base" },
			}),
			remotePaths("/r"),
			{ env: { WS_B: "ws" } },
			base,
		);
		expect(on.HTTPS_PROXY).toBe("http://pw:abcdef0123456789@127.0.0.1:31000");
		expect(on.http_proxy).toBe(on.HTTPS_PROXY);
		expect(on.NO_PROXY).toBe("localhost,10.0.0.5");
		expect(on.EXTRA_A).toBe("1");
		expect(on.WS_B).toBe("ws");
	});
});

describe("ConversationManager with fake pi", () => {
	it("starts, streams events with increasing seq and tracks status", async () => {
		const h = await setup();
		const result = await h.manager.start({ convId: "c1", cwd: h.cwd, trust: "no-approve", name: "First" });
		expect(result.attached).toBe(false);
		expect(result.conv.status).toBe("idle");
		expect(result.state.sessionName).toBe("First");
		expect(h.infos.map((i) => i.status)).toEqual(["starting", "idle"]);

		const sent = await h.manager.send({ convId: "c1", command: { type: "prompt", message: "hi" } });
		expect(sent.success).toBe(true);
		expect(sent.id).toMatch(/^pw-\d+$/);
		await waitFor(() => h.events.find((e) => e.record.type === "agent_settled"));

		const seqs = h.events.map((e) => e.seq);
		expect(seqs).toEqual(seqs.map((_, i) => i + 1));
		const t = types(h.events);
		expect(t).toContain("agent_start");
		expect(t).toContain("message_update");
		// U+2028 inside JSON strings must not split records
		const deltas = h.events
			.filter((e) => e.record.type === "message_update")
			.map((e) => (e.record as { assistantMessageEvent: { delta?: string } }).assistantMessageEvent.delta)
			.filter(Boolean);
		expect(deltas.join("")).toBe("Hello world");
		const statuses = h.events.filter((e) => e.record.type === "pi_web_status").map((e) => (e.record as { status: string }).status);
		expect(statuses).toEqual(["idle", "running", "idle"]);
		expect(h.manager.get("c1")?.status).toBe("idle");
		expect(h.manager.get("c1")?.lastSeq).toBe(h.events.length);
	});

	it("passes argv and environment to pi", async () => {
		const h = await setup({ config: { extraEnv: { EXTRA_X: "1" } } });
		await h.manager.start({ convId: "env", cwd: h.cwd, trust: "approve", env: { WS_Y: "2" }, thinkingLevel: "low" });
		const res = await h.manager.send({ convId: "env", command: { type: "debug_env" } as never });
		const data = res.data as { argv: string[]; cwd: string; env: Record<string, string> };
		expect(data.argv).toContain("--approve");
		expect(data.argv).toContain("--thinking");
		expect(data.cwd).toBe(h.cwd);
		expect(data.env.EXTRA_X).toBe("1");
		expect(data.env.WS_Y).toBe("2");
		expect(data.env.PI_CODING_AGENT_DIR).toBe(h.config.agentDir);
		expect(data.env.HTTPS_PROXY).toBeUndefined();
	});

	it("returns the existing process for the same session file", async () => {
		const h = await setup();
		const file = join(h.root, "s.jsonl");
		await writeFile(file, "");
		const a = await h.manager.start({ convId: "a", cwd: h.cwd, trust: "no-approve", sessionFile: file });
		const b = await h.manager.start({ convId: "b", cwd: h.cwd, trust: "no-approve", sessionFile: file });
		expect(b.attached).toBe(true);
		expect(b.conv.convId).toBe("a");
		expect(a.conv.pid).toBe(b.conv.pid);
		expect(h.manager.findBySessionFile(file)?.convId).toBe("a");
		await expect(h.manager.start({ convId: "x", cwd: join(h.root, "nope"), trust: "no-approve" })).rejects.toMatchObject({
			code: "CWD_NOT_FOUND",
		});
	});

	it("builds snapshots from get_messages and the tracker at the same seq", async () => {
		const h = await setup();
		await h.manager.start({ convId: "s", cwd: h.cwd, trust: "no-approve" });
		await h.manager.send({ convId: "s", command: { type: "prompt", message: "hello" } });
		await waitFor(() => h.events.find((e) => e.record.type === "agent_settled"));
		const snap = await h.manager.snapshot({ convId: "s" });
		expect(snap.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(snap.seq).toBe(h.manager.get("s")?.lastSeq);
		expect(snap.isRunning).toBe(false);
		expect(snap.streaming).toBeNull();
		expect(snap.runningTools).toEqual([]);
		expect(snap.stats?.totalMessages).toBe(2);
		expect(snap.state.sessionId).toBeTruthy();
	});

	it("tracks dialogs, answers them and resolves timeouts", async () => {
		const h = await setup();
		await h.manager.start({ convId: "u", cwd: h.cwd, trust: "no-approve" });
		await h.manager.send({ convId: "u", command: { type: "prompt", message: "ask" } });
		const request = await waitFor(() => h.events.find((e) => e.record.type === "extension_ui_request"));
		const uiId = (request.record as { id: string }).id;
		expect(h.manager.get("u")?.status).toBe("waiting_ui");
		expect(h.manager.get("u")?.pendingUi.map((r) => r.id)).toEqual([uiId]);
		const snap = await h.manager.snapshot({ convId: "u" });
		expect(snap.ui.pending.map((r) => r.id)).toEqual([uiId]);

		h.manager.uiResponse({ convId: "u", response: { type: "extension_ui_response", id: uiId, confirmed: true } });
		expect(h.manager.get("u")?.pendingUi).toEqual([]);
		expect(h.events.some((e) => e.record.type === "pi_web_ui_resolved" && (e.record as { id: string }).id === uiId)).toBe(true);
		await waitFor(() => h.events.find((e) => e.record.type === "agent_settled"));
		await waitFor(() => h.manager.get("u")?.status === "idle");

		// timeout + 1s → resolved by the agent
		await h.manager.send({ convId: "u", command: { type: "prompt", message: "ask-timeout" } });
		const timed = await waitFor(() => h.events.filter((e) => e.record.type === "extension_ui_request").at(1));
		const timedId = (timed.record as { id: string }).id;
		await waitFor(
			() => h.events.find((e) => e.record.type === "pi_web_ui_resolved" && (e.record as { id: string }).id === timedId),
			4000,
		);
		expect(h.manager.get("u")?.pendingUi).toEqual([]);
	});

	it("forwards statuses and widgets but swallows companion results", async () => {
		const h = await setup();
		await h.manager.start({ convId: "c", cwd: h.cwd, trust: "no-approve" });
		const label = await h.manager.companion({ convId: "c", action: "label", args: { entryId: "e1", label: "mark" } });
		expect(label).toEqual({ ok: true });
		const missing = await h.manager.companion({ convId: "c", action: "label", args: { entryId: "missing" } });
		expect(missing).toEqual({ ok: false, error: "Entry missing not found" });
		const nav = await h.manager.companion({ convId: "c", action: "navigate", args: { targetId: "e1", summarize: false } });
		expect(nav).toEqual({ ok: true, cancelled: false });
		// navigate tells viewers to resync
		expect(types(h.events)).toContain("pi_web_session_changed");
		const reload = await h.manager.companion({ convId: "c", action: "reload" });
		expect(reload.ok).toBe(true);
		expect(h.events.some((e) => e.record.type === "extension_ui_request")).toBe(false);
	});

	it("reports missing companion extension and silent companions", async () => {
		const h = await setup({ baseEnv: { ...process.env, FAKE_PI_NO_COMPANION: "1" } });
		await h.manager.start({ convId: "n", cwd: h.cwd, trust: "no-approve" });
		await expect(h.manager.companion({ convId: "n", action: "reload" })).rejects.toMatchObject({ code: "COMPANION_UNAVAILABLE" });

		const h2 = await setup({ baseEnv: { ...process.env, FAKE_PI_COMPANION_SILENT: "1" } });
		await h2.manager.start({ convId: "q", cwd: h2.cwd, trust: "no-approve" });
		expect(await h2.manager.companion({ convId: "q", action: "reload" })).toEqual({ ok: false, error: "伴随扩展未返回结果" });
	});

	it("refreshes the session after new_session and session name changes", async () => {
		const h = await setup();
		const started = await h.manager.start({ convId: "n", cwd: h.cwd, trust: "no-approve" });
		const before = started.conv.sessionFile as string;
		expect(h.manager.findBySessionFile(before)?.convId).toBe("n");
		const res = await h.manager.send({ convId: "n", command: { type: "new_session" } });
		expect(res.success).toBe(true);
		const changed = h.events.find((e) => e.record.type === "pi_web_session_changed");
		expect(changed).toBeTruthy();
		const after = h.manager.get("n")?.sessionFile as string;
		expect(after).not.toBe(before);
		expect(h.manager.findBySessionFile(before)).toBeUndefined();
		expect(h.manager.findBySessionFile(after)?.convId).toBe("n");

		await h.manager.send({ convId: "n", command: { type: "set_session_name", name: "Renamed" } });
		await waitFor(() => h.manager.get("n")?.sessionName === "Renamed");
	});

	it("times out commands and rejects unknown conversations", async () => {
		const h = await setup();
		await h.manager.start({ convId: "t", cwd: h.cwd, trust: "no-approve" });
		await expect(h.manager.send({ convId: "t", command: { type: "prompt", message: "slow" }, timeoutMs: 150 })).rejects.toMatchObject({
			code: "TIMEOUT",
		});
		await expect(h.manager.send({ convId: "zzz", command: { type: "get_state" } })).rejects.toMatchObject({ code: "CONV_NOT_FOUND" });
		const failed = await h.manager.send({ convId: "t", command: { type: "bogus" } as never });
		expect(failed.success).toBe(false);
	});

	it("rate-limits stderr and reports process exit with the stderr tail", async () => {
		const h = await setup();
		await h.manager.start({ convId: "x", cwd: h.cwd, trust: "no-approve" });
		await h.manager.send({ convId: "x", command: { type: "prompt", message: "flood" } });
		await waitFor(() => h.events.filter((e) => e.record.type === "pi_web_stderr").length >= 20);
		await new Promise((r) => setTimeout(r, 100));
		const stderrLines = h.events.filter((e) => e.record.type === "pi_web_stderr");
		expect(stderrLines.length).toBeLessThanOrEqual(21);

		const pending = h.manager.send({ convId: "x", command: { type: "prompt", message: "slow" } });
		await h.manager.send({ convId: "x", command: { type: "prompt", message: "crash" } });
		await expect(pending).rejects.toMatchObject({ code: "CONV_EXITED" });
		const exit = await waitFor(() => h.events.find((e) => e.record.type === "pi_web_exit"));
		expect(exit.record).toMatchObject({ type: "pi_web_exit", code: 3 });
		expect((exit.record as { stderrTail: string }).stderrTail).toContain("fatal: boom");
		const info = h.manager.get("x") as ConvInfo;
		expect(info.status).toBe("exited");
		expect(info.exitCode).toBe(3);
		expect(h.infos.at(-1)?.status).toBe("exited");
		await expect(h.manager.send({ convId: "x", command: { type: "get_state" } })).rejects.toMatchObject({ code: "CONV_EXITED" });
		// exited conversations stay replayable
		expect(h.manager.replay({ convId: "x", afterSeq: 0 }).events.at(-1)?.record.type).toBe("pi_web_status");
	});

	it("replays from the ring buffer and flags gaps", async () => {
		const h = await setup({ ringSize: 5 });
		await h.manager.start({ convId: "r", cwd: h.cwd, trust: "no-approve" });
		await h.manager.send({ convId: "r", command: { type: "prompt", message: "hi" } });
		await waitFor(() => h.events.find((e) => e.record.type === "agent_settled"));
		const last = h.manager.get("r")?.lastSeq as number;
		expect(last).toBeGreaterThan(5);
		const full = h.manager.replay({ convId: "r", afterSeq: last - 3 });
		expect(full.events.map((e) => e.seq)).toEqual([last - 2, last - 1, last]);
		expect(full.complete).toBe(true);
		expect(full.lastSeq).toBe(last);
		const gap = h.manager.replay({ convId: "r", afterSeq: 0 });
		expect(gap.complete).toBe(false);
		expect(gap.events).toHaveLength(5);
		expect(h.manager.replay({ convId: "r", afterSeq: last })).toEqual({ events: [], complete: true, lastSeq: last });
	});

	it("stops gracefully, escalates to signals, and reaps idle conversations", async () => {
		const h = await setup();
		await h.manager.start({ convId: "g", cwd: h.cwd, trust: "no-approve" });
		await h.manager.stop({ convId: "g" });
		expect(h.manager.get("g")?.status).toBe("exited");
		expect(h.manager.get("g")?.exitCode).toBe(0);

		const stubborn = await setup({ baseEnv: { ...process.env, FAKE_PI_IGNORE_STDIN_END: "1", FAKE_PI_IGNORE_SIGTERM: "1" } });
		await stubborn.manager.start({ convId: "k", cwd: stubborn.cwd, trust: "no-approve" });
		const t0 = Date.now();
		await stubborn.manager.stop({ convId: "k" });
		expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
		expect(stubborn.manager.get("k")?.exitSignal).toBe("SIGKILL");

		const idle = await setup({ config: { idleTimeoutMin: 1 } });
		await idle.manager.start({ convId: "i", cwd: idle.cwd, trust: "no-approve" });
		idle.manager.reapIdle(Date.now());
		expect(idle.manager.get("i")?.status).toBe("idle");
		idle.manager.reapIdle(Date.now() + 2 * 60_000);
		await waitFor(() => idle.manager.get("i")?.status === "exited", 3000);
	});

	it("restarts a conversation id whose process exited", async () => {
		const h = await setup({ retentionMs: 60_000 });
		const first = await h.manager.start({ convId: "re", cwd: h.cwd, trust: "no-approve" });
		await h.manager.stop({ convId: "re", force: true });
		expect(h.manager.get("re")?.exitSignal).toBe("SIGKILL");
		const second = await h.manager.start({ convId: "re", cwd: h.cwd, trust: "no-approve" });
		expect(second.attached).toBe(false);
		expect(second.conv.pid).not.toBe(first.conv.pid);
		expect(second.conv.lastSeq).toBeGreaterThan(0);
	});

	it("fails start with stderr when pi exits immediately", async () => {
		const h = await setup({ config: { piCliPath: "/nonexistent/cli.js" } });
		await expect(h.manager.start({ convId: "bad", cwd: h.cwd, trust: "no-approve" })).rejects.toMatchObject({
			code: "START_FAILED",
			message: expect.stringContaining("Cannot find module"),
		});
		expect(h.manager.get("bad")?.status).toBe("exited");
	});
});
