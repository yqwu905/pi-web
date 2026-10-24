#!/usr/bin/env node
/**
 * API-level end-to-end test of Pi-Web: drives the built host server (packages/server/dist/cli.mjs)
 * over REST + /ws exactly like the browser does, against a real local sshd ("server" = user pitest
 * on 127.0.0.1:2222) and the mock OpenAI-compatible LLM (e2e/mock-llm.mjs on mock-llm.test → 127.0.0.2).
 *
 * Prerequisites: Linux, root, OpenSSH server installed, and a build:
 *   npm run build && npm run e2e:api
 *
 * Environment:
 *   E2E_KEEP=1      keep the temp directory (host agent dir, data dir, logs) after the run
 *   E2E_VERBOSE=1   print every conversation event and server log line
 *
 * Bundle downloads are seeded from /tmp/pi-web-test-cache/cache when present (same layout as
 * <data-dir>/cache); anything missing is downloaded through the host's HTTPS_PROXY.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";
import {
	AssertionError,
	EventSocket,
	KEEP,
	MOCK_HOST,
	MOCK_IP,
	MOCK_PORT,
	Runner,
	VERBOSE,
	assert,
	cleanup,
	debug,
	freePort,
	info,
	onCleanup,
	pinCachedNodeVersion,
	preflight,
	prepareHostAgentDir,
	seedBundleCache,
	sleep,
	startMockLlm,
	startPiWebProcess,
	startSshdFixture,
	stopChild,
	tailFile,
	textOf,
	waitUntil,
} from "./lib/env.mjs";

const WS_DIR_NAME = "e2e-ws";

// ------------------------------------------------------------------ reporting

const runner = new Runner();
const results = runner.results;
const step = (...args) => runner.step(...args);
/** Collects remote-side diagnostics right after the first failure (later steps may remove them). */
let captureDiagnostics = () => "";
let firstFailureDiagnostics = "";
runner.onFirstFailure = async () => {
	try {
		firstFailureDiagnostics = captureDiagnostics() || "(none)";
	} catch (e) {
		firstFailureDiagnostics = `(diagnostics failed: ${e.message})`;
	}
};

// ------------------------------------------------------------------ main

async function main() {
	const S0 = "setup";
	let tmp;
	let hostAgentDir;
	let dataDir;
	let fixture;
	let runAsTestUser;
	let port;
	let api;
	let events;
	let piWebChild;
	let mockRequests = [];
	const serverLog = { file: "" };

	// ---------------------------------------------------------------- setup
	await step(S0, "preflight: built dist, root, OpenSSH", async () => preflight(), { critical: true });

	await step(
		S0,
		"prepare temp host agent dir (models, settings, extension, skill, prompt, auth)",
		async () => {
			({ tmp, hostAgentDir, dataDir } = await prepareHostAgentDir("pi-web-e2e-"));
		},
		{ critical: true },
	);

	await step(
		S0,
		`map ${MOCK_HOST} → ${MOCK_IP} in /etc/hosts and start the mock LLM`,
		async () => {
			mockRequests = (await startMockLlm(tmp)).requests;
		},
		{ critical: true },
	);

	await step(
		S0,
		"start sshd fixture (pitest@127.0.0.1:2222) with a clean home",
		async () => {
			let remoteDiagnostics;
			({ fixture, runAsTestUser, remoteDiagnostics } = await startSshdFixture({ cleanPaths: [WS_DIR_NAME] }));
			captureDiagnostics = remoteDiagnostics;
		},
		{ critical: true },
	);

	/** Starts the built CLI on `port` (again after a restart) and opens the browser's /ws. */
	async function startPiWeb() {
		({ child: piWebChild, api } = await startPiWebProcess({ hostAgentDir, dataDir, port, logFile: serverLog.file }));
		events = await new EventSocket(port).open();
	}

	await step(
		S0,
		"start pi-web (built CLI) with a seeded bundle cache",
		async () => {
			await seedBundleCache(dataDir);
			port = await freePort();
			serverLog.file = path.join(tmp, "pi-web.out");
			await startPiWeb();
			onCleanup(async () => events.close());
		},
		{ critical: true },
	);

	await step(
		S0,
		"security: non-GET without Origin is rejected, foreign Host is rejected",
		async () => {
			const noOrigin = await fetch(`${api.base}/api/sync/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
			assert(noOrigin.status === 403, `POST without Origin → ${noOrigin.status}`);
			const res = await new Promise((resolve, reject) => {
				const socket = net.connect(port, "127.0.0.1", () => {
					socket.write("GET /api/meta HTTP/1.1\r\nHost: evil.example:80\r\nConnection: close\r\n\r\n");
				});
				let data = "";
				socket.on("data", (d) => (data += d));
				socket.on("end", () => resolve(data));
				socket.on("error", reject);
			});
			assert(/^HTTP\/1\.1 403/.test(res), "foreign Host header should be rejected", res.slice(0, 200));
		},
		{ critical: true },
	);

	await step(S0, "web SPA: index, hashed assets and deep-link fallback are served", async () => {
		const index = await fetch(`${api.base}/`);
		const html = await index.text();
		assert(index.ok && (index.headers.get("content-type") ?? "").startsWith("text/html"), `GET / → ${index.status}`);
		assert(/<div id="root">/.test(html), "index.html has the React root", html.slice(0, 500));
		const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
		assert(assets.some((a) => a.endsWith(".js")), "index.html references a JS bundle", html.slice(0, 800));
		for (const asset of assets) {
			const res = await fetch(`${api.base}${asset}`);
			await res.arrayBuffer();
			assert(res.ok, `${asset} → ${res.status}`);
		}
		const deep = await fetch(`${api.base}/servers/some-id/workspaces`);
		assert(deep.ok && (await deep.text()) === html, `deep link falls back to index.html (${deep.status})`);
		const missingApi = await fetch(`${api.base}/api/does-not-exist`);
		assert(missingApi.status === 404 && (await missingApi.json()).error?.code === "NOT_FOUND", "unknown /api route → JSON 404");
	});

	// Pin the cached Node.js version so the run does not depend on nodejs.org's index.
	await step(S0, "settings: pin Node.js to the cached runtime", async () => pinCachedNodeVersion(api, dataDir), { critical: true });

	// ---------------------------------------------------------------- server: add, trust, probe, deploy
	const S1 = "server";
	let server;
	let serverId;
	let agentPid;

	await step(
		S1,
		"test connection reports an unknown host key",
		async () => {
			const result = await api.post("/servers/test", {
				host: "127.0.0.1",
				port: fixture.port,
				username: fixture.user,
				auth: { method: "key", keyPath: fixture.keyPath },
			});
			assert(result.hostKeyStatus === "unknown", "first contact should report an unknown host key", result);
			assert(result.hostKey && fixture.hostFingerprints.includes(result.hostKey.fingerprint), "host key fingerprint should match sshd", result);
		},
		{ critical: true },
	);

	await step(
		S1,
		"create server, trust the host key, test succeeds",
		async () => {
			server = await api.post("/servers", {
				name: "e2e-local",
				host: "127.0.0.1",
				port: fixture.port,
				username: fixture.user,
				auth: { method: "key", keyPath: fixture.keyPath },
				jumpServerIds: [],
			});
			serverId = server.config.id;
			assert(serverId, "server id", server);
			assert(server.config.proxy.mode === "tunnel", "default proxy mode should be tunnel", server.config.proxy);
			events.subscribe("servers", `deploy:${serverId}`, `proxy:${serverId}`, "sync", "convs", "oauth");
			const first = await api.post(`/servers/${serverId}/test`);
			assert(first.hostKeyStatus === "unknown" && first.hostKey, "saved server: host key should still be unknown", first);
			const trusted = await api.post(`/servers/${serverId}/trust-host-key`, first.hostKey);
			assert(trusted.config.hostKey?.fingerprint === first.hostKey.fingerprint, "trusted host key saved", trusted.config);
			const second = await api.post(`/servers/${serverId}/test`);
			assert(second.ok === true && second.hostKeyStatus === "trusted", "test after trust", second);
			// Settings page: unsaved edits are tested against this server's trusted key.
			const edited = { host: "127.0.0.1", port: fixture.port, username: fixture.user, auth: { method: "key", keyPath: fixture.keyPath }, jumpServerIds: [] };
			const unsaved = await api.post("/servers/test", { ...edited, serverId });
			assert(unsaved.ok === true && unsaved.hostKeyStatus === "trusted", "unsaved edits tested with the trusted key", unsaved);
			const wrongUser = await api.post("/servers/test", { ...edited, username: "nobody-e2e", serverId });
			assert(wrongUser.ok === false && wrongUser.hostKeyStatus === "trusted" && /认证失败/.test(wrongUser.error ?? ""), "a bad user fails authentication, not the host key", wrongUser);
		},
		{ critical: true },
	);

	await step(
		S1,
		"probe",
		async () => {
			const probe = await api.post(`/servers/${serverId}/probe`);
			assert(probe.os === "Linux" && probe.supportedArch && probe.glibcOk, "probe basics", probe);
			assert(probe.home === fixture.home, "probe home", probe);
			assert(probe.hasTar && probe.hasGzip && probe.sftp, "probe tools", probe);
			assert(Array.isArray(probe.issues) && probe.issues.length === 0, "probe issues", probe);
		},
		{ critical: true },
	);

	await step(
		S1,
		"deploy (progress over WS deploy:<id>)",
		async () => {
			const fromIndex = events.list(`deploy:${serverId}`).length;
			const started = await api.post(`/servers/${serverId}/deploy`, {});
			assert(started.state === "running", "deploy should start running", started);
			assert(started.steps.length === 9, "9 deploy steps", started.steps);
			let lastLogged = "";
			const final = await events.waitFor(
				`deploy:${serverId}`,
				(p) => {
					const running = p.steps.find((s) => s.status === "running");
					const now = running ? `${running.id}${running.detail ? `: ${running.detail}` : ""}` : p.state;
					if (now !== lastLogged) {
						lastLogged = now;
						debug(`deploy: ${now}`);
					}
					return p.state !== "running";
				},
				{ fromIndex, timeoutMs: 15 * 60_000, what: "deploy to finish" },
			);
			const summary = final.steps.map((s) => `${s.id}=${s.status}${s.detail ? `(${s.detail})` : ""}`).join(" ");
			assert(final.state === "done", `deploy state ${final.state}: ${final.error ?? ""}\n      ${summary}\n      ${final.log.slice(-15).join("\n      ")}`);
			for (const s of final.steps) assert(s.status === "done" || s.status === "skipped", `deploy step ${s.id} is ${s.status}`, summary);
			info(`deploy: ${summary}`);
			const job = await api.get(`/servers/${serverId}/deploy`);
			assert(job.job?.state === "done" && job.job.jobId === final.jobId, "GET deploy returns the finished job", job);
			assert(final.result?.agentDir === `${fixture.home}/.pi-web/agent`, "deployed agentDir", final.result);
		},
		{ critical: true },
	);

	await step(
		S1,
		"server connected with a running agent",
		async () => {
			const view = await waitUntil(
				"connection + agent",
				async () => {
					const v = await api.get(`/servers/${serverId}`);
					return v.status.connection === "connected" && v.status.agent && v.status.deployState === "deployed" ? v : null;
				},
				{ timeoutMs: 30_000 },
			);
			agentPid = view.status.agent.pid;
			assert(view.config.deployed?.piVersion, "deployed info saved", view.config);
			const status = await api.get(`/servers/${serverId}/agent-status`);
			assert(status.pid === agentPid && status.proxy.listening, "agent status: proxy listening", status);
			const logs = await api.get(`/servers/${serverId}/logs?tail=50`);
			assert(Array.isArray(logs.lines) && logs.lines.length > 0, "agent logs", logs);
			const piVersion = runAsTestUser("~/.pi-web/bin/pi --version").stdout.trim();
			assert(piVersion === view.config.deployed.piVersion, `remote pi --version: ${piVersion}`);
			const statusEvents = events.list("servers").filter((s) => s.serverId === serverId);
			assert(statusEvents.some((s) => s.connection === "connected"), "servers topic published the connected status");
		},
		{ critical: true },
	);

	// ---------------------------------------------------------------- workspace
	const S2 = "workspace";
	let workspace;
	let wsId;
	const wsPath = `${fixture?.home ?? "/home/pitest"}/${WS_DIR_NAME}`;

	await step(
		S2,
		"create a git repo in pitest's home and add it as a workspace",
		async () => {
			const script = [
				`set -e`,
				`mkdir -p ~/${WS_DIR_NAME}/src && cd ~/${WS_DIR_NAME}`,
				`git init -q -b main . 2>/dev/null || git init -q .`,
				`printf '# E2E workspace\\n\\nhello\\n' > README.md`,
				`printf 'console.log("hi");\\n' > src/main.js`,
				`printf 'node_modules/\\n' > .gitignore`,
				`git add -A && git -c user.name=E2E -c user.email=e2e@example.com commit -qm "initial commit"`,
				`printf 'changed line\\n' >> README.md`,
				`printf 'untracked\\n' > notes.txt`,
			].join("\n");
			const r = runAsTestUser(script);
			assert(r.status === 0, "workspace setup script failed", r.stdout);
			const listing = await api.get(`/servers/${serverId}/fs/list?path=~`);
			assert(listing.entries.some((e) => e.name === WS_DIR_NAME && e.type === "dir"), "server fs/list ~ shows the workspace dir", listing);
			workspace = await api.post(`/servers/${serverId}/workspaces`, { path: `~/${WS_DIR_NAME}`, alias: "E2E" });
			wsId = workspace.config.id;
			assert(workspace.config.path === wsPath, "workspace path resolved to the absolute path", workspace.config);
			const list = await api.get(`/servers/${serverId}/workspaces`);
			assert(list.workspaces.some((w) => w.config.id === wsId), "workspace listed", list);
		},
		{ critical: true },
	);

	await step(
		S2,
		"list sessions (empty)",
		async () => {
			const sessions = await api.get(`/workspaces/${wsId}/sessions`);
			assert(Array.isArray(sessions.sessions) && sessions.sessions.length === 0, "no sessions yet", sessions);
		},
		{ critical: true },
	);

	// ---------------------------------------------------------------- conversation
	const S3 = "conversation";
	let convId;
	let originalSessionFile;
	let lastSeq = 0;
	const topic = () => `conv:${convId}`;
	const records = () => events.list(topic()).map((e) => e.record);

	/**
	 * Sends a prompt to conversation `cid` and waits for agent_settled followed by the idle
	 * status; returns the events of this run. `seqs.last` tracks the conversation's seq.
	 */
	async function promptOn(cid, seqs, message, timeoutMs = 90_000) {
		const t = `conv:${cid}`;
		const fromIndex = events.list(t).length;
		const response = await api.post(`/conversations/${cid}/rpc`, { command: { type: "prompt", message } });
		assert(response.success === true, `prompt "${message}" rejected`, response);
		const settled = await events.waitFor(t, (e) => e.record.type === "agent_settled", { fromIndex, timeoutMs, what: `agent_settled after "${message}"` });
		// The agent reports the resulting status right after agent_settled.
		const settledIndex = events.list(t).indexOf(settled);
		await events.waitFor(t, (e) => e.record.type === "pi_web_status" && e.record.status === "idle", {
			fromIndex: settledIndex,
			timeoutMs: 10_000,
			what: "pi_web_status idle after agent_settled",
		});
		const run = events.list(t).slice(fromIndex);
		for (const e of run) {
			assert(e.seq > seqs.last, `conversation seq must increase (${e.seq} after ${seqs.last})`);
			seqs.last = e.seq;
		}
		if (VERBOSE) for (const e of run) debug(`#${e.seq} ${e.record.type}${e.record.assistantMessageEvent ? `/${e.record.assistantMessageEvent.type}` : ""}`);
		return run;
	}
	const mainSeqs = {
		get last() {
			return lastSeq;
		},
		set last(v) {
			lastSeq = v;
		},
	};
	const prompt = (message, timeoutMs) => promptOn(convId, mainSeqs, message, timeoutMs);
	const lastAssistantText = (run) => {
		const end = run.filter((e) => e.record.type === "message_end" && e.record.message.role === "assistant").at(-1);
		return end ? textOf(end.record.message.content) : undefined;
	};

	await step(
		S3,
		"open a new conversation and subscribe conv:<id>",
		async () => {
			const view = await api.post(`/workspaces/${wsId}/conversations`, {});
			convId = view.convId;
			assert(convId && view.serverId === serverId && view.workspaceId === wsId, "conversation view", view);
			assert(["idle", "starting"].includes(view.info.status), "conversation status", view.info);
			events.subscribe(topic());
			const convs = await api.get("/conversations");
			assert(convs.conversations.some((c) => c.convId === convId), "conversation listed", convs);
			lastSeq = view.info.lastSeq ?? 0;
		},
		{ critical: false },
	);

	await step(S3, "extension command, skill and prompt template are available remotely (get_commands)", async () => {
		const res = await api.post(`/conversations/${convId}/rpc`, { command: { type: "get_commands" } });
		assert(res.success, "get_commands failed", res);
		const names = res.data.commands.map((c) => c.name);
		assert(names.includes("e2e-hello"), "extension command e2e-hello", names);
		assert(names.some((n) => n === "skill:demo" || n === "demo"), "skill demo", names);
		assert(names.includes("e2e-review"), "prompt template e2e-review", names);
		const state = await api.post(`/conversations/${convId}/rpc`, { command: { type: "get_state" } });
		assert(state.success && state.data.model?.provider === "mock" && state.data.model?.id === "mock-1", "default model mock/mock-1", state.data?.model);
	});

	await step(S3, 'prompt "你好" streams "收到：你好" and settles', async () => {
		const run = await prompt("你好");
		const deltas = run
			.filter((e) => e.record.type === "message_update" && e.record.assistantMessageEvent?.type === "text_delta")
			.map((e) => e.record.assistantMessageEvent.delta);
		assert(deltas.length > 1, "streamed in several text deltas", deltas);
		assert(deltas.join("") === "收到：你好", `streamed text: ${deltas.join("")}`);
		const end = run.filter((e) => e.record.type === "message_end" && e.record.message.role === "assistant").at(-1);
		assert(end && textOf(end.record.message.content) === "收到：你好", "final assistant message", end?.record);
		assert(run.some((e) => e.record.type === "agent_start"), "agent_start seen");
		const statuses = run.filter((e) => e.record.type === "pi_web_status").map((e) => e.record.status);
		assert(statuses.includes("running") && statuses.at(-1) === "idle", "pi_web_status running → idle", statuses);
	});

	await step(S3, 'prompt "run: echo pi-web-e2e" executes bash and replies', async () => {
		const run = await prompt("run: echo pi-web-e2e");
		const start = run.find((e) => e.record.type === "tool_execution_start");
		assert(start && start.record.toolName === "bash" && start.record.args?.command === "echo pi-web-e2e", "bash tool started", start?.record);
		const end = run.find((e) => e.record.type === "tool_execution_end");
		assert(end && !end.record.isError, "bash tool finished without error", end?.record);
		assert(textOf(end.record.result?.content).includes("pi-web-e2e"), "bash output", end.record.result);
		const last = run.filter((e) => e.record.type === "message_end" && e.record.message.role === "assistant").at(-1);
		assert(last && textOf(last.record.message.content).startsWith("工具执行完成：pi-web-e2e"), "final assistant reply", last?.record);
	});

	await step(S3, "LLM traffic went through the tunnel (proxy stats + mock log)", async () => {
		const stats = await waitUntil(
			"proxy stats for mock-llm.test",
			async () => {
				const s = await api.get(`/servers/${serverId}/proxy`);
				return s.byHost.find((h) => h.host === MOCK_HOST && h.requests > 0) ? s : null;
			},
			{ timeoutMs: 10_000 },
		);
		const entry = stats.byHost.find((h) => h.host === MOCK_HOST);
		assert(entry.bytesUp > 0 && entry.bytesDown > 0, "tunnel byte counters", entry);
		const completions = mockRequests.filter((r) => r.method === "POST" && r.path?.endsWith("/chat/completions"));
		assert(completions.length >= 3, `mock LLM saw ${completions.length} chat completions`, mockRequests);
		assert(completions.every((r) => r.host === `${MOCK_HOST}:${MOCK_PORT}` && r.model === "mock-1"), "requests addressed to mock-llm.test with model mock-1", completions);
		// Stats are published throttled (≤ 1/s) on proxy:<id> and mirrored into the server status.
		await events.waitFor(`proxy:${serverId}`, (p) => p.byHost?.some((h) => h.host === MOCK_HOST), { timeoutMs: 5000, what: "proxy:<id> stats event" });
		const view = await api.get(`/servers/${serverId}`);
		assert(view.status.proxy?.byHost?.some((h) => h.host === MOCK_HOST), "server status carries proxy stats", view.status.proxy);
	});

	await step(S3, "snapshot is consistent with the streamed events", async () => {
		const snap = await api.get(`/conversations/${convId}/snapshot`);
		assert(snap.convId === convId && snap.serverId === serverId && snap.workspaceId === wsId, "snapshot ids", snap);
		const s = snap.snapshot;
		assert(s.seq === lastSeq, `snapshot.seq ${s.seq} should equal the last streamed seq ${lastSeq}`);
		assert(s.info.lastSeq === lastSeq, `snapshot.info.lastSeq ${s.info.lastSeq}`);
		assert(!s.isRunning && s.streaming === null && s.runningTools.length === 0, "nothing running", s);
		// pi ≥ 1.4 keeps system messages (system prompt + later prompt/tool changes) in the transcript;
		// they are part of the snapshot but never rendered as chat bubbles (web: buildDisplayItems skips them).
		const allRoles = s.messages.map((m) => m.role);
		assert(allRoles[0] === "system", `the transcript starts with pi's system message: ${allRoles}`);
		const systemText = `${textOf(s.messages[0].content)}\n${Object.values(s.messages[0].sections ?? {}).join("\n")}`;
		assert(systemText.includes("Demo skill used by the Pi-Web E2E test"), "the synced skill is listed in the remote system prompt", systemText.slice(-1500));
		const chat = s.messages.filter((m) => m.role !== "system");
		const roles = chat.map((m) => m.role);
		assert(JSON.stringify(roles) === JSON.stringify(["user", "assistant", "user", "assistant", "toolResult", "assistant"]), `snapshot chat message roles ${roles}`);
		assert(textOf(chat[1].content) === "收到：你好", "snapshot first reply");
		assert(s.state.sessionFile && s.state.sessionFile.endsWith(".jsonl"), "session file in state", s.state);
		assert(s.stats === undefined || typeof s.stats === "object", "stats");
		originalSessionFile = s.state.sessionFile;
		assert(originalSessionFile.startsWith(`${fixture.home}/.pi-web/agent/sessions/`), "session file in the isolated agent dir", originalSessionFile);
		const replay = await api.get(`/conversations/${convId}/replay?afterSeq=0`);
		assert(replay.complete && replay.lastSeq === lastSeq && replay.events.length === lastSeq, "replay returns every event", { ...replay, events: replay.events.length });
	});

	await step(S3, "session list shows the conversation", async () => {
		const { sessions } = await api.get(`/workspaces/${wsId}/sessions`);
		const mine = sessions.find((s) => s.file === originalSessionFile);
		assert(mine, "session listed", sessions);
		assert(mine.runningConvId === convId, "runningConvId", mine);
		assert(mine.firstMessage === "你好" && mine.messageCount >= 6, "summary", mine);
		assert(mine.cwd === wsPath, "session cwd", mine);
	});

	let tree;
	await step(S3, "rpc get_tree + companion navigate, label, reload", async () => {
		const res = await api.post(`/conversations/${convId}/rpc`, { command: { type: "get_tree" } });
		assert(res.success && Array.isArray(res.data.tree) && res.data.leafId, "get_tree", res);
		tree = res.data;
		const flat = [];
		const walk = (nodes) => {
			for (const n of nodes) {
				flat.push(n.entry);
				walk(n.children ?? []);
			}
		};
		walk(tree.tree);
		const firstAssistant = flat.find((e) => e.type === "message" && e.message.role === "assistant");
		assert(firstAssistant, "assistant entry in tree", flat.map((e) => e.type));
		const labelled = await api.post(`/conversations/${convId}/label`, { entryId: firstAssistant.id, label: "e2e-mark" });
		assert(labelled.ok === true, "label", labelled);
		const nav = await api.post(`/conversations/${convId}/navigate`, { targetId: firstAssistant.id });
		assert(nav.ok === true && !nav.cancelled, "navigate", nav);
		const after = await api.post(`/conversations/${convId}/rpc`, { command: { type: "get_tree" } });
		assert(after.success && after.data.leafId === firstAssistant.id, `leaf after navigate: ${after.data?.leafId} (want ${firstAssistant.id})`);
		const flatAfter = [];
		const walk2 = (nodes) => {
			for (const n of nodes) {
				flatAfter.push(n);
				walk2(n.children ?? []);
			}
		};
		walk2(after.data.tree);
		assert(flatAfter.some((n) => n.entry.id === firstAssistant.id && n.label === "e2e-mark"), "label visible in tree");
		const reload = await api.post(`/conversations/${convId}/reload`);
		assert(reload.ok === true, "reload", reload);
		const cmds = await api.post(`/conversations/${convId}/rpc`, { command: { type: "get_commands" } });
		assert(cmds.success && cmds.data.commands.some((c) => c.name === "e2e-hello"), "extension still loaded after reload");
		// Back to the latest leaf so the fork below sees both user messages.
		const back = await api.post(`/conversations/${convId}/navigate`, { targetId: tree.leafId });
		assert(back.ok === true, "navigate back", back);
	});

	let forkFile;
	await step(S3, "fork creates a new session", async () => {
		const forkable = await api.post(`/conversations/${convId}/rpc`, { command: { type: "get_fork_messages" } });
		assert(forkable.success && forkable.data.messages.length >= 2, "get_fork_messages", forkable);
		const target = forkable.data.messages.find((m) => m.text.includes("run: echo"));
		assert(target, "fork target", forkable.data.messages);
		const fromIndex = events.list(topic()).length;
		const res = await api.post(`/conversations/${convId}/rpc`, { command: { type: "fork", entryId: target.entryId } });
		assert(res.success && res.data && !res.data.cancelled, "fork", res);
		assert(res.data.text === "run: echo pi-web-e2e", "fork returns the forked text", res.data);
		const changed = await events.waitFor(topic(), (e) => e.record.type === "pi_web_session_changed", { fromIndex, timeoutMs: 10_000 });
		forkFile = changed.record.sessionFile;
		assert(forkFile && forkFile !== originalSessionFile, "session changed to a new file", changed.record);
		// The fork only holds the history before the forked message; continue it so pi writes the file.
		await prompt("继续");
		const { sessions } = await api.get(`/workspaces/${wsId}/sessions`);
		const files = sessions.map((s) => s.file);
		assert(files.includes(originalSessionFile) && files.includes(forkFile), "both sessions listed", sessions);
		const fork = sessions.find((s) => s.file === forkFile);
		assert(fork.runningConvId === convId, "fork is served by the conversation process", fork);
		const original = sessions.find((s) => s.file === originalSessionFile);
		assert(!original.runningConvId, "original session no longer served", original);
	});

	await step(S3, "sessions/read on the original session file", async () => {
		const read = await api.get(`/sessions/read?serverId=${serverId}&file=${encodeURIComponent(originalSessionFile)}`);
		assert(read.header?.type === "session" && read.header.cwd === wsPath, "header", read.header);
		const messages = read.entries.filter((e) => e.type === "message");
		assert(messages.length >= 6, `message entries: ${messages.length}`);
		assert(read.entries.some((e) => e.type === "label" && e.label === "e2e-mark"), "label entry persisted");
		assert(read.leafId && read.branchIds.at(-1) === read.leafId, "leaf / branch", { leafId: read.leafId, branch: read.branchIds });
		const texts = messages.map((e) => textOf(e.message.content));
		assert(texts.includes("收到：你好"), "first reply persisted", texts);
	});

	/** The host's archive records of the server (state.json, written before the route answers). */
	const archiveRecords = async () => JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"))[`archived:${serverId}`] ?? {};

	await step(S3, "archive: a session is hidden by a host-side mark, refused while running, restored", async () => {
		assert(originalSessionFile && forkFile, "no sessions to archive (earlier conversation steps failed)");
		events.subscribe("sessions");
		const fromIndex = events.list("sessions").length;
		const archived = await api.post("/sessions/archive", { serverId, file: originalSessionFile });
		assert(archived.ok === true && typeof archived.archivedAt === "number", "archive", archived);
		await events.waitFor("sessions", (e) => e.file === originalSessionFile && e.archivedAt === archived.archivedAt, {
			fromIndex,
			timeoutMs: 5000,
			what: "sessions topic event for the archive",
		});
		const { sessions } = await api.get(`/workspaces/${wsId}/sessions`);
		assert(sessions.find((s) => s.file === originalSessionFile)?.archivedAt === archived.archivedAt, "the list marks the archived session", sessions);
		assert(sessions.find((s) => s.file === forkFile)?.archivedAt === undefined, "other sessions are not marked", sessions);
		const { workspaces } = await api.get(`/servers/${serverId}/workspaces`);
		const ws = workspaces.find((w) => w.config.id === wsId);
		assert(ws?.sessionCount === sessions.length - 1, `workspace sessionCount ${ws?.sessionCount} skips the archived session (${sessions.length} listed)`, ws);
		// Only Pi-Web hides it: the file stays where pi's own /resume finds it, and the mark lives on the host.
		assert(runAsTestUser(`test -f '${originalSessionFile}' && echo yes`).stdout.trim() === "yes", "the session file is left in place");
		assert((await archiveRecords())[originalSessionFile]?.archivedAt === archived.archivedAt, "archive record persisted in state.json");

		// The session of a running conversation cannot be archived (the fork is served by the main conversation).
		const run = prompt("run: sleep 3; echo archive-busy");
		run.catch(() => {}); // awaited below; a failure before that must not be unhandled
		await waitUntil("conversation running", async () => (await api.get("/conversations")).conversations.find((c) => c.convId === convId)?.info.status === "running", {
			timeoutMs: 15_000,
		});
		const busy = await api.call("POST", "/sessions/archive", { serverId, file: forkFile }, { expectStatus: 409 });
		assert(busy?.error?.code === "BUSY" && busy.error.message === "会话正在运行，无法归档", "archive while running → 409 BUSY", busy);
		await run;
		assert((await archiveRecords())[forkFile] === undefined, "nothing recorded for the refused archive");

		const restored = await api.post("/sessions/unarchive", { serverId, file: originalSessionFile });
		assert(restored.ok === true, "unarchive", restored);
		const after = await api.get(`/workspaces/${wsId}/sessions`);
		assert(after.sessions.every((s) => s.archivedAt === undefined), "no session is archived after the restore", after.sessions);
		assert((await archiveRecords())[originalSessionFile] === undefined, "archive record removed");
		const bad = await api.call("POST", "/sessions/archive", { serverId, file: "relative.jsonl" }, { expectStatus: 400 });
		assert(bad?.error?.code === "BAD_REQUEST", "relative path → 400", bad);
	});

	await step(S3, "export a session as JSONL, then delete it to the trash (stopping its process first)", async () => {
		const view = await api.post(`/workspaces/${wsId}/conversations`, {});
		const cid = view.convId;
		events.subscribe(`conv:${cid}`);
		await promptOn(cid, { last: view.info.lastSeq ?? 0 }, "临时会话");
		const snap = await api.get(`/conversations/${cid}/snapshot`);
		const file = snap.snapshot.state.sessionFile;
		assert(file?.endsWith(".jsonl") && file !== originalSessionFile, "throwaway session file", snap.snapshot.state);
		// JSONL export: the browser downloads the raw session file through the workspace file route.
		const res = await fetch(`${api.base}/api/workspaces/${wsId}/fs/download?path=${encodeURIComponent(file)}`);
		const body = await res.text();
		assert(res.ok, `JSONL download → HTTP ${res.status}: ${body.slice(0, 300)}`);
		const lines = body.trim().split("\n").map((line) => JSON.parse(line));
		assert(lines[0].type === "session", "JSONL starts with the session header", lines[0]);
		assert(lines.some((e) => e.type === "message" && textOf(e.message.content) === "临时会话"), "JSONL holds the prompt", lines.length);
		// The file of a running process cannot be deleted (409 BUSY); the UI stops the process first.
		const deleteUrl = `/sessions?serverId=${serverId}&file=${encodeURIComponent(file)}`;
		const busy = await api.call("DELETE", deleteUrl, undefined, { expectStatus: 409 });
		assert(busy?.error?.code === "BUSY", "delete while running → BUSY", busy);
		const fromIndex = events.list(`conv:${cid}`).length;
		await api.post(`/conversations/${cid}/stop`, {});
		await events.waitFor(`conv:${cid}`, (e) => e.record.type === "pi_web_exit", { fromIndex, timeoutMs: 20_000 });
		// Archived first: deleting the session also drops its archive record.
		await api.post("/sessions/archive", { serverId, file });
		assert((await archiveRecords())[file], "the throwaway session is archived");
		events.subscribe("sessions");
		const sessionsFrom = events.list("sessions").length;
		const trashed = await api.call("DELETE", deleteUrl);
		assert(trashed?.trashedTo?.startsWith(`${fixture.home}/.pi-web/trash/sessions/`), "moved to the trash", trashed);
		assert((await archiveRecords())[file] === undefined, "deleting the session removed its archive record");
		// Told as a deletion, not a restore (the web must not show it as active meanwhile).
		await events.waitFor("sessions", (e) => e.file === file && e.archivedAt === null && e.deleted === true, {
			fromIndex: sessionsFrom,
			timeoutMs: 5000,
			what: "sessions topic event for the deletion",
		});
		assert(runAsTestUser(`test -f '${trashed.trashedTo}' && echo yes`).stdout.trim() === "yes", "trashed file exists", trashed);
		const { sessions } = await api.get(`/workspaces/${wsId}/sessions`);
		assert(!sessions.some((s) => s.file === file), "deleted session no longer listed", sessions);
		const { workspaces } = await api.get(`/servers/${serverId}/workspaces`);
		const ws = workspaces.find((w) => w.config.id === wsId);
		assert(ws?.sessionCount === sessions.length, `workspace sessionCount ${ws?.sessionCount} (want ${sessions.length})`, ws);
	});

	// ---------------------------------------------------------------- files & git
	const S4 = "files+git";
	await step(S4, "fs/list + fs/read", async () => {
		const root = await api.get(`/workspaces/${wsId}/fs/list`);
		assert(root.path === wsPath, "list path", root);
		const names = root.entries.map((e) => e.name);
		assert(names.includes("README.md") && names.includes("src") && names.includes("notes.txt"), "entries", names);
		assert(!names.includes(".git") && !names.includes(".gitignore"), "hidden entries are hidden by default", names);
		assert(root.entries[0].type === "dir", "directories first", root.entries);
		const hidden = await api.get(`/workspaces/${wsId}/fs/list?showHidden=true`);
		assert(hidden.entries.some((e) => e.name === ".gitignore"), "showHidden lists dotfiles");
		const src = await api.get(`/workspaces/${wsId}/fs/list?path=src`);
		assert(src.entries.length === 1 && src.entries[0].name === "main.js", "src listing", src);
		const file = await api.get(`/workspaces/${wsId}/fs/read?path=README.md`);
		assert(file.encoding === "utf8" && !file.binary && file.content.includes("# E2E workspace") && file.content.includes("changed line"), "README content", file);
		const dl = await fetch(`${api.base}/api/workspaces/${wsId}/fs/download?path=src/main.js`);
		assert(dl.ok && (await dl.text()) === 'console.log("hi");\n', `download → ${dl.status}`);
	});

	await step(S4, "git/status + git/diff + git/log", async () => {
		const status = await api.get(`/workspaces/${wsId}/git/status`);
		assert(status.isRepo && status.root === wsPath, "is repo", status);
		const readme = status.files.find((f) => f.path === "README.md");
		assert(readme && readme.area === "unstaged" && readme.code === "M" && readme.additions === 1, "README modified", status.files);
		assert(status.files.some((f) => f.path === "notes.txt" && f.area === "untracked"), "notes.txt untracked", status.files);
		const diff = await api.get(`/workspaces/${wsId}/git/diff?path=README.md&area=unstaged`);
		assert(diff.diff.includes("+changed line") && !diff.truncated, "unstaged diff", diff);
		const untracked = await api.get(`/workspaces/${wsId}/git/diff?path=notes.txt&area=untracked`);
		assert(untracked.diff.includes("+untracked"), "untracked diff", untracked);
		const log = await api.get(`/workspaces/${wsId}/git/log?limit=10`);
		assert(log.commits.length === 1 && log.commits[0].subject === "initial commit" && log.commits[0].author === "E2E", "git log", log);
	});

	// ---------------------------------------------------------------- terminal
	const S5 = "terminal";
	await step(S5, "/ws/term: open, run, resize, close", async () => {
		const url = `ws://127.0.0.1:${port}/ws/term?serverId=${encodeURIComponent(serverId)}&cwd=${encodeURIComponent(wsPath)}&cols=80&rows=24`;
		const socket = new WebSocket(url, { origin: api.origin });
		let output = "";
		const controls = [];
		let closed = false;
		socket.on("message", (data, isBinary) => {
			if (isBinary) output += data.toString("utf8");
			else controls.push(JSON.parse(data.toString("utf8")));
		});
		socket.on("close", () => (closed = true));
		await new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		try {
			await waitUntil("terminal ready", () => controls.some((c) => c.type === "ready"), { timeoutMs: 15_000, intervalMs: 50 });
			socket.send(Buffer.from("echo $((40+2))\n"), { binary: true });
			await waitUntil("42 in the terminal output", () => /[\r\n]42\r?\n/.test(output), { timeoutMs: 15_000, intervalMs: 50 });
			socket.send(Buffer.from("pwd; command -v pi\n"), { binary: true });
			await waitUntil("pwd = workspace and pi on PATH", () => output.includes(`${wsPath}\r\n`) && output.includes(`${fixture.home}/.pi-web/bin/pi\r\n`), {
				timeoutMs: 10_000,
				intervalMs: 50,
			});
			socket.send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
			await sleep(200);
			socket.send(Buffer.from("stty size\n"), { binary: true });
			await waitUntil("stty size 40 132", () => output.includes("40 132"), { timeoutMs: 10_000, intervalMs: 50 });
			socket.send(Buffer.from("exit\n"), { binary: true });
			await waitUntil("terminal exit + close", () => closed && controls.some((c) => c.type === "exit"), { timeoutMs: 10_000, intervalMs: 50 });
			assert(!controls.some((c) => c.type === "error"), "no terminal errors", controls);
		} catch (err) {
			throw new AssertionError(`${err.message}\n      output: ${JSON.stringify(output.slice(-800))}\n      controls: ${JSON.stringify(controls)}`);
		} finally {
			if (!closed) socket.terminate();
		}
	});

	// ---------------------------------------------------------------- server-level env
	const S5a = "server env";
	const SRV_ENV_VALUE = "srv value with 'quotes' $HOME";
	await step(S5a, "server env: Pi-Web managed and invalid variables are rejected with 400", async () => {
		for (const env of [{ HTTPS_PROXY: "http://127.0.0.1:1" }, { https_proxy: "http://127.0.0.1:1" }, { PI_CODING_AGENT_DIR: "/tmp/x" }, { UID: "1000" }, { "BAD-NAME": "x" }]) {
			const res = await api.raw("PUT", `/servers/${serverId}`, { env });
			const body = await res.json();
			assert(res.status === 400 && body.error?.code === "BAD_REQUEST", `PUT env ${Object.keys(env)[0]} → HTTP ${res.status}`, body);
		}
		const view = await api.get(`/servers/${serverId}`);
		assert(view.config.env && Object.keys(view.config.env).length === 0, "env unchanged by the rejected updates", view.config.env);
	});

	await step(S5a, "server env reaches a new pi process (workspace value wins) and run/env.sh (0600)", async () => {
		const view = await api.put(`/servers/${serverId}`, { env: { PIWEB_SRV_ENV: SRV_ENV_VALUE, SHARED_VAR: "server" } });
		assert(view.config.env.PIWEB_SRV_ENV === SRV_ENV_VALUE && view.config.env.SHARED_VAR === "server", "server env saved", view.config.env);
		const ws = await api.put(`/workspaces/${wsId}`, { env: { SHARED_VAR: "workspace" } });
		assert(ws.config.env.SHARED_VAR === "workspace", "workspace env saved", ws.config.env);
		// The agent wrote R/run/env.sh while handling the reconfigure; the deployed wrapper sources it before proxy.env.
		const file = runAsTestUser(`stat -c %a ~/.pi-web/run/env.sh; . ~/.pi-web/run/env.sh; printf '%s|%s\\n' "$PIWEB_SRV_ENV" "$SHARED_VAR"`).stdout.trim().split("\n");
		assert(file[0] === "600", "run/env.sh mode", file);
		assert(file[1] === `${SRV_ENV_VALUE}|server`, "run/env.sh round-trips the values", file);
		const wrapper = runAsTestUser("cat ~/.pi-web/bin/pi").stdout;
		const envLine = wrapper.indexOf("/run/env.sh");
		assert(envLine > 0 && envLine < wrapper.indexOf("/run/proxy.env"), "bin/pi sources run/env.sh before proxy.env", wrapper);

		const conv = await api.post(`/workspaces/${wsId}/conversations`, {});
		const cid = conv.convId;
		events.subscribe(`conv:${cid}`);
		try {
			const run = await promptOn(cid, { last: conv.info.lastSeq ?? 0 }, `run: printf '[%s][%s]\\n' "$PIWEB_SRV_ENV" "$SHARED_VAR"`);
			const end = run.find((e) => e.record.type === "tool_execution_end");
			const output = textOf(end?.record.result?.content);
			assert(end && !end.record.isError, "bash tool finished without error", end?.record);
			assert(output.includes(`[${SRV_ENV_VALUE}][workspace]`), "bash sees the exact server value and the workspace override", output);
		} finally {
			const fromIndex = events.list(`conv:${cid}`).length;
			await api.post(`/conversations/${cid}/stop`, {});
			await events.waitFor(`conv:${cid}`, (e) => e.record.type === "pi_web_exit", { fromIndex, timeoutMs: 20_000 }).catch(() => {});
		}
	});

	await step(S5a, "/ws/term: a new terminal has the server env", async () => {
		const url = `ws://127.0.0.1:${port}/ws/term?serverId=${encodeURIComponent(serverId)}&cwd=${encodeURIComponent(wsPath)}&cols=120&rows=24`;
		const socket = new WebSocket(url, { origin: api.origin });
		let output = "";
		const controls = [];
		let closed = false;
		socket.on("message", (data, isBinary) => {
			if (isBinary) output += data.toString("utf8");
			else controls.push(JSON.parse(data.toString("utf8")));
		});
		socket.on("close", () => (closed = true));
		await new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		try {
			await waitUntil("terminal ready", () => controls.some((c) => c.type === "ready"), { timeoutMs: 15_000, intervalMs: 50 });
			socket.send(Buffer.from(`printf '<%s>\\n' "$PIWEB_SRV_ENV"\n`), { binary: true });
			await waitUntil("server env in the terminal output", () => output.includes(`<${SRV_ENV_VALUE}>\r\n`), { timeoutMs: 15_000, intervalMs: 50 });
			socket.send(Buffer.from("exit\n"), { binary: true });
			await waitUntil("terminal closed", () => closed, { timeoutMs: 10_000, intervalMs: 50 });
		} catch (err) {
			throw new AssertionError(`${err.message}\n      output: ${JSON.stringify(output.slice(-800))}\n      controls: ${JSON.stringify(controls)}`);
		} finally {
			if (!closed) socket.terminate();
		}
	});

	// ---------------------------------------------------------------- sync
	const S6 = "sync";
	const remoteAgentDir = `${fixture?.home ?? "/home/pitest"}/.pi-web/agent`;
	await step(S6, "sync status, preview and run", async () => {
		const status = await api.get("/sync/status");
		assert(status.hostAgentDir === hostAgentDir && status.watching === true, "sync status host dir + watching", status);
		const mine = status.servers.find((s) => s.serverId === serverId);
		assert(mine && mine.online && mine.auto, "server in sync status", status);
		const inventory = await api.get("/sync/inventory");
		const byKey = Object.fromEntries(inventory.items.map((i) => [i.key, i]));
		assert(byKey.extensions?.present && byKey.skills?.present && byKey.prompts?.present && byKey.auth?.present, "inventory", inventory.items);
		const preview = await api.post("/sync/preview", { serverId });
		assert(preview.serverId === serverId && Array.isArray(preview.entries), "preview", preview);
		assert(preview.summary.add === 0 && preview.summary.update === 0 && preview.summary.delete === 0, "deploy already synced everything", preview);
		const run = await api.post("/sync/run", { serverIds: [serverId] });
		assert(run.records.length === 1 && run.records[0].status === "ok", "sync run", run);
		const history = await api.get("/sync/history?limit=20");
		assert(history.records.some((r) => r.serverId === serverId && r.trigger === "deploy" && r.status === "ok"), "deploy sync recorded", history);
		for (const rel of ["models.json", "settings.json", "extensions/e2e-ext.ts", "skills/demo/SKILL.md", "prompts/e2e-review.md", "auth.json"]) {
			assert(runAsTestUser(`test -f ${remoteAgentDir}/${rel}`).status === 0, `remote ${rel} exists`);
		}
		const remoteSettings = JSON.parse(runAsTestUser(`cat ${remoteAgentDir}/settings.json`).stdout);
		assert(remoteSettings.defaultProvider === "mock" && remoteSettings.transport === "sse", "settings transform (transport sse)", remoteSettings);
		assert(String(remoteSettings.shellCommandPrefix ?? "").includes("unset HTTP_PROXY"), "settings transform (llm scope prefix)", remoteSettings);
	});

	await step(S6, "auto-sync pushes a modified host extension within 15s", async () => {
		const marker = `// e2e-marker-${Date.now()}`;
		const fromIndex = events.list("sync").length;
		await appendFile(path.join(hostAgentDir, "extensions", "e2e-ext.ts"), `${marker}\n`);
		const started = Date.now();
		await waitUntil(
			"remote extension updated",
			() => runAsTestUser(`cat ${remoteAgentDir}/extensions/e2e-ext.ts`).stdout.includes(marker),
			{ timeoutMs: 15_000, intervalMs: 300 },
		);
		info(`auto-sync propagated in ${Date.now() - started} ms`);
		const record = await events.waitFor("sync", (e) => e.kind === "record" && e.record.serverId === serverId && e.record.trigger === "auto", {
			fromIndex,
			timeoutMs: 5000,
			what: "auto sync record on the sync topic",
		});
		assert(record.record.status === "ok" && record.record.updated >= 1, "auto sync record", record.record);
		const snap = await api.get(`/conversations/${convId}/snapshot`);
		assert(snap.configStale === true, "running conversation is marked configStale after the sync", { configStale: snap.configStale });
	});

	await step(S6, "remote auth.json: OAuth refresh token replaced, access kept", async () => {
		const remote = JSON.parse(runAsTestUser(`cat ${remoteAgentDir}/auth.json`).stdout);
		const host = JSON.parse(await readFile(path.join(hostAgentDir, "auth.json"), "utf8"));
		assert(remote["e2e-oauth"]?.type === "oauth", "oauth entry present", remote);
		assert(remote["e2e-oauth"].refresh === "pi-web-managed", "refresh replaced", remote["e2e-oauth"]);
		assert(remote["e2e-oauth"].access === "acc" && remote["e2e-oauth"].expires === host["e2e-oauth"].expires, "access/expires kept", remote["e2e-oauth"]);
		assert(remote["e2e-apikey"]?.key === "sk-e2e-test", "api key entry synced as is", remote["e2e-apikey"]);
		assert(host["e2e-oauth"].refresh === "host-refresh-token", "host keeps its refresh token");
		const mode = runAsTestUser(`stat -c %a ${remoteAgentDir}/auth.json`).stdout.trim();
		assert(mode === "600", `remote auth.json mode ${mode}`);
		const oauth = await api.get("/oauth");
		assert(oauth.providers.some((p) => p.provider === "e2e-oauth"), "oauth status lists the provider", oauth);
	});

	// ---------------------------------------------------------------- export & stop
	const S7 = "export+stop";
	await step(S7, "export HTML downloads a non-empty page", async () => {
		const res = await fetch(`${api.base}/api/conversations/${convId}/export`);
		const body = await res.text();
		assert(res.ok, `export → HTTP ${res.status}: ${body.slice(0, 500)}`);
		assert((res.headers.get("content-type") ?? "").startsWith("text/html"), "content-type", res.headers.get("content-type"));
		assert(/attachment; filename=/.test(res.headers.get("content-disposition") ?? ""), "content-disposition", res.headers.get("content-disposition"));
		assert(body.length > 1000 && /<html/i.test(body), `html body (${body.length} bytes)`);
		await waitUntil("exported file removed remotely", () => runAsTestUser(`ls ${fixture.home}/.pi-web/state/exports/ 2>/dev/null | wc -l`).stdout.trim() === "0", {
			timeoutMs: 10_000,
		});
	});

	await step(S7, "stop the conversation", async () => {
		const fromIndex = events.list(topic()).length;
		const res = await api.post(`/conversations/${convId}/stop`, {});
		assert(res.ok === true, "stop", res);
		const exit = await events.waitFor(topic(), (e) => e.record.type === "pi_web_exit", { fromIndex, timeoutMs: 20_000 });
		assert(exit.record.signal === null || exit.record.code === 0 || typeof exit.record.code === "number", "exit record", exit.record);
		await waitUntil("conversation exited in the list", async () => {
			const { conversations } = await api.get("/conversations");
			return conversations.find((c) => c.convId === convId)?.info.status === "exited";
		});
		const { sessions } = await api.get(`/workspaces/${wsId}/sessions`);
		assert(sessions.every((s) => !s.runningConvId), "no session is served any more", sessions);
	});

	// ---------------------------------------------------------------- reconnect
	const S8 = "reconnect";
	let liveConvId;
	let livePid;
	await step(S8, "resume the original session in a new process", async () => {
		assert(originalSessionFile, "no original session file (conversation section failed)");
		const view = await api.post(`/workspaces/${wsId}/conversations`, { sessionFile: originalSessionFile });
		liveConvId = view.convId;
		livePid = view.info.pid;
		assert(view.info.sessionFile === originalSessionFile, "resumed the requested file", view.info);
		events.subscribe(`conv:${liveConvId}`);
		const snap = await api.get(`/conversations/${liveConvId}/snapshot`);
		assert(snap.snapshot.messages.length >= 2, "resumed session has history", snap.snapshot.messages.length);
	});

	await step(S8, "disconnect + connect: agent and conversation survive, replay works", async () => {
		const down = await api.post(`/servers/${serverId}/disconnect`);
		assert(down.status.connection === "disconnected", "disconnected", down.status);
		const alive = runAsTestUser(`kill -0 ${agentPid} && echo alive`).stdout.trim();
		assert(alive === "alive", `agent daemon (pid ${agentPid}) keeps running while the host is disconnected`);
		if (livePid) assert(runAsTestUser(`kill -0 ${livePid} && echo alive`).stdout.trim() === "alive", "pi process keeps running");
		const up = await api.post(`/servers/${serverId}/connect`);
		assert(up.status.connection === "connected", "reconnected", up.status);
		const view = await waitUntil("agent after reconnect", async () => {
			const v = await api.get(`/servers/${serverId}`);
			return v.status.agent ? v : null;
		});
		assert(view.status.agent.pid === agentPid, `same agent pid after reconnect (${view.status.agent.pid} vs ${agentPid})`);
		const convs = await waitUntil("conversation listed after reconnect", async () => {
			const { conversations } = await api.get("/conversations");
			return conversations.find((c) => c.convId === liveConvId && c.info.status !== "exited");
		});
		assert(convs.workspaceId === wsId, "conversation workspace after reconnect", convs);
		const replay = await api.get(`/conversations/${liveConvId}/replay?afterSeq=0`);
		assert(replay.complete && replay.lastSeq >= 1, "replay after reconnect", { ...replay, events: replay.events.length });
		const { sessions } = await api.get(`/workspaces/${wsId}/sessions`);
		assert(sessions.find((s) => s.file === originalSessionFile)?.runningConvId === liveConvId, "session list after reconnect", sessions);
		const run = await (async () => {
			const fromIndex = events.list(`conv:${liveConvId}`).length;
			const r = await api.post(`/conversations/${liveConvId}/rpc`, { command: { type: "prompt", message: "重连后" } });
			assert(r.success, "prompt after reconnect", r);
			await events.waitFor(`conv:${liveConvId}`, (e) => e.record.type === "agent_settled", { fromIndex, timeoutMs: 60_000 });
			return events.list(`conv:${liveConvId}`).slice(fromIndex);
		})();
		const reply = run.filter((e) => e.record.type === "message_end" && e.record.message.role === "assistant").at(-1);
		assert(reply && textOf(reply.record.message.content) === "收到：重连后", "conversation works after reconnect", reply?.record);
	});

	await step(S8, "archive works while the server is disconnected; the mark shows after reconnecting", async () => {
		assert(forkFile, "no fork session (conversation section failed)");
		const down = await api.post(`/servers/${serverId}/disconnect`);
		assert(down.status.connection === "disconnected", "disconnected", down.status);
		let archived;
		try {
			archived = await api.post("/sessions/archive", { serverId, file: forkFile });
			assert(archived.ok === true && typeof archived.archivedAt === "number", "archive while disconnected", archived);
			// Listing still needs the agent (unchanged offline behavior).
			const offline = await api.call("GET", `/workspaces/${wsId}/sessions`, undefined, { expectStatus: 409 });
			assert(offline?.error?.code === "NOT_CONNECTED", "session list while disconnected → 409 NOT_CONNECTED", offline);
		} finally {
			const up = await api.post(`/servers/${serverId}/connect`);
			assert(up.status.connection === "connected", "reconnected", up.status);
		}
		await waitUntil("agent after reconnect", async () => ((await api.get(`/servers/${serverId}`)).status.agent ? true : null));
		const { sessions } = await api.get(`/workspaces/${wsId}/sessions`);
		assert(sessions.find((s) => s.file === forkFile)?.archivedAt === archived.archivedAt, "the offline archive shows in the list", sessions);
		await api.post("/sessions/unarchive", { serverId, file: forkFile });
		const after = await api.get(`/workspaces/${wsId}/sessions`);
		assert(after.sessions.every((s) => s.archivedAt === undefined), "restored", after.sessions);
	});

	// ---------------------------------------------------------------- host restart
	const S8a = "host restart";
	await step(S8a, "pi-web restarts while a tool runs: the tool keeps running and the browser catches up", async () => {
		assert(liveConvId, "no live conversation (reconnect section failed)");
		const t = `conv:${liveConvId}`;
		const fromIndex = events.list(t).length;
		const command = "for i in 1 2 3 4 5 6; do echo tick$i; sleep 1; done";
		const res = await api.post(`/conversations/${liveConvId}/rpc`, { command: { type: "prompt", message: `run: ${command}` } });
		assert(res.success === true, "prompt", res);
		await events.waitFor(t, (e) => e.record.type === "tool_execution_start" && e.record.toolName === "bash", {
			fromIndex,
			timeoutMs: 15_000,
			what: "bash tool start",
		});
		const seenBefore = events.list(t).slice(fromIndex);
		const lastSeenSeq = events.list(t).at(-1).seq;

		// Host goes down (as if the user restarted Pi-Web).
		events.close();
		await stopChild(piWebChild);
		assert(piWebChild.exitCode !== null || piWebChild.signalCode !== null, "pi-web exited");
		assert(runAsTestUser(`kill -0 ${agentPid} && echo alive`).stdout.trim() === "alive", "agent daemon survives the host restart");
		assert(runAsTestUser(`pgrep -u ${fixture.user} -f '[e]cho tick' >/dev/null && echo running || echo gone`).stdout.trim() === "running", "the tool keeps running");
		await sleep(1500);

		// Host comes back with the same data dir; the browser reconnects and resubscribes.
		await startPiWeb();
		events.subscribe("servers", "convs", "sync", `proxy:${serverId}`, t);
		const view = await waitUntil(
			"server reconnected automatically after the restart",
			async () => {
				const v = await api.get(`/servers/${serverId}`);
				return v.status.connection === "connected" && v.status.agent ? v : null;
			},
			{ timeoutMs: 30_000 },
		);
		assert(view.status.agent.pid === agentPid, `same agent pid after the host restart (${view.status.agent.pid} vs ${agentPid})`);
		const listed = await waitUntil("conversation listed after the restart", async () => {
			const { conversations } = await api.get("/conversations");
			return conversations.find((c) => c.convId === liveConvId);
		});
		assert(listed.workspaceId === wsId && listed.info.status !== "exited", "conversation after the restart", listed);

		// Like the web store: replay the gap, then apply live events with a higher seq.
		const gap = await api.get(`/conversations/${liveConvId}/replay?afterSeq=${lastSeenSeq}`);
		assert(gap.complete === true, "replay after the restart is complete", { ...gap, events: gap.events.length });
		info(`replayed ${gap.events.length} events missed while pi-web was down (${[...new Set(gap.events.map((e) => e.record.type))].join(", ")})`);
		assert(gap.events.some((e) => e.record.type === "tool_execution_update"), "tool output produced while the host was down is replayed", gap.events.map((e) => e.record.type));
		assert(gap.events[0].seq === lastSeenSeq + 1, "replay continues right after the last seen seq", gap.events.slice(0, 2));
		const settledLive = () => events.list(t).some((e) => e.record.type === "agent_settled");
		await waitUntil(
			"agent_settled (live or replayed)",
			async () => settledLive() || (await api.get(`/conversations/${liveConvId}/replay?afterSeq=${lastSeenSeq}`)).events.some((e) => e.record.type === "agent_settled"),
			{ timeoutMs: 60_000, intervalMs: 500 },
		);
		const full = await api.get(`/conversations/${liveConvId}/replay?afterSeq=${lastSeenSeq}`);
		const bySeq = new Map();
		for (const e of [...full.events, ...events.list(t)]) if (e.seq > lastSeenSeq) bySeq.set(e.seq, e);
		const after = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
		after.forEach((e, i) => assert(e.seq === lastSeenSeq + 1 + i, `seq gap after the restart at ${e.seq}`));
		const run = [...seenBefore, ...after];
		const end = run.find((e) => e.record.type === "tool_execution_end");
		const output = textOf(end?.record.result?.content);
		assert(end && !end.record.isError && /tick1\s+tick2\s+tick3\s+tick4\s+tick5\s+tick6/.test(output), "tool output complete", end?.record);
		assert(lastAssistantText(run) === "工具执行完成：tick1 tick2 tick3 tick4 tick5 tick6", `reply after the restart: ${lastAssistantText(run)}`);
		const snap = await api.get(`/conversations/${liveConvId}/snapshot`);
		assert(!snap.snapshot.isRunning && snap.snapshot.runningTools.length === 0, "nothing running after the catch-up", snap.snapshot);
		assert(snap.snapshot.seq >= after.at(-1).seq, "snapshot seq covers the replayed events", { snap: snap.snapshot.seq, last: after.at(-1).seq });
	});

	// ---------------------------------------------------------------- extensions, dialogs, templates, skills
	const S8b = "extensions";
	const liveSeqs = { last: 0 };
	const liveTopic = () => `conv:${liveConvId}`;
	const lastLiveSeq = () => events.list(liveTopic()).at(-1)?.seq ?? 0;

	await step(S8b, 'extension command "/e2e-hello" notifies the browser', async () => {
		assert(liveConvId, "no live conversation (reconnect section failed)");
		const completionsBefore = mockRequests.filter((r) => r.method === "POST").length;
		const fromIndex = events.list(liveTopic()).length;
		const res = await api.post(`/conversations/${liveConvId}/rpc`, { command: { type: "prompt", message: "/e2e-hello pi-web" } });
		assert(res.success === true && res.data?.disposition === "handled", "extension command handled by pi", res);
		const notify = await events.waitFor(liveTopic(), (e) => e.record.type === "extension_ui_request" && e.record.method === "notify", {
			fromIndex,
			timeoutMs: 10_000,
			what: "notify extension_ui_request",
		});
		assert(notify.record.message === "e2e hello pi-web" && (notify.record.notifyType ?? "info") === "info", "notify payload", notify.record);
		assert(mockRequests.filter((r) => r.method === "POST").length === completionsBefore, "an extension command does not call the LLM");
		const snap = await api.get(`/conversations/${liveConvId}/snapshot`);
		assert(snap.snapshot.info.pendingUi.length === 0, "fire-and-forget UI requests are not pending", snap.snapshot.info.pendingUi);
	});

	await step(S8b, 'extension dialog: "/e2e-ask" confirm → ui-response → resolved', async () => {
		const fromIndex = events.list(liveTopic()).length;
		// pi answers an extension command only after its handler returned, i.e. after the dialog.
		const pending = api.post(`/conversations/${liveConvId}/rpc`, { command: { type: "prompt", message: "/e2e-ask" } });
		pending.catch(() => {});
		const dialog = await events.waitFor(liveTopic(), (e) => e.record.type === "extension_ui_request" && e.record.method === "confirm", {
			fromIndex,
			timeoutMs: 10_000,
			what: "confirm extension_ui_request",
		});
		assert(dialog.record.title === "E2E 确认" && dialog.record.message === "继续吗？" && dialog.record.id, "confirm payload", dialog.record);
		// A reloading browser restores open dialogs from the snapshot.
		const during = await api.get(`/conversations/${liveConvId}/snapshot`);
		assert(during.snapshot.info.pendingUi.some((r) => r.id === dialog.record.id), "dialog is pending in the snapshot", during.snapshot.info);
		const answered = await api.post(`/conversations/${liveConvId}/ui-response`, {
			response: { type: "extension_ui_response", id: dialog.record.id, confirmed: true },
		});
		assert(answered.ok === true && answered.delivered === true, "ui-response", answered);
		// A second answer (another tab) is not passed to pi, and says so.
		const again = await api.post(`/conversations/${liveConvId}/ui-response`, {
			response: { type: "extension_ui_response", id: dialog.record.id, confirmed: false },
		});
		assert(again.ok === true && again.delivered === false, "a repeated ui-response is not delivered", again);
		const res = await pending;
		assert(res.success === true, "the extension command completed", res);
		const notify = await events.waitFor(liveTopic(), (e) => e.record.type === "extension_ui_request" && e.record.method === "notify", {
			fromIndex,
			timeoutMs: 10_000,
			what: "notify after the confirmation",
		});
		assert(notify.record.message === "e2e confirmed: true", "the handler saw the confirmation", notify.record);
		const after = await api.get(`/conversations/${liveConvId}/snapshot`);
		assert(after.snapshot.info.pendingUi.length === 0, "no pending dialog after the answer", after.snapshot.info.pendingUi);
	});

	await step(S8b, 'prompt template "/e2e-review security" expands remotely', async () => {
		liveSeqs.last = Math.max(liveSeqs.last, lastLiveSeq());
		const run = await promptOn(liveConvId, liveSeqs, "/e2e-review security");
		const user = run.find((e) => e.record.type === "message_end" && e.record.message.role === "user");
		assert(user && textOf(user.record.message.content).startsWith("Review the workspace. Focus on security."), "expanded user message", user?.record);
		const reply = lastAssistantText(run);
		assert(reply?.startsWith("收到：Review the workspace. Focus on security."), `assistant reply: ${reply}`);
	});

	await step(S8b, 'skill "/skill:demo" expands from the synced skill file', async () => {
		const run = await promptOn(liveConvId, liveSeqs, "/skill:demo 介绍一下");
		const reply = lastAssistantText(run) ?? "";
		assert(reply.startsWith(`收到：<skill name="demo" location="${remoteAgentDir}/skills/demo/SKILL.md">`), `skill block in the reply: ${reply}`);
		assert(reply.includes("Answer with the word DEMO."), `skill body in the reply: ${reply}`);
	});

	// ---------------------------------------------------------------- more tools: write, abort
	const S8c = "tools";
	await step(S8c, 'write tool creates a file the workspace browser and git see', async () => {
		assert(liveConvId, "no live conversation");
		liveSeqs.last = Math.max(liveSeqs.last, lastLiveSeq());
		const run = await promptOn(liveConvId, liveSeqs, "write: e2e-written.txt");
		const start = run.find((e) => e.record.type === "tool_execution_start");
		assert(start?.record.toolName === "write" && start.record.args?.path === "e2e-written.txt", "write tool started", start?.record);
		const end = run.find((e) => e.record.type === "tool_execution_end");
		assert(end && !end.record.isError, "write tool succeeded", end?.record);
		const file = await api.get(`/workspaces/${wsId}/fs/read?path=e2e-written.txt`);
		assert(file.content === "hello from mock-llm\n", "written content", file);
		const status = await api.get(`/workspaces/${wsId}/git/status`);
		assert(status.files.some((f) => f.path === "e2e-written.txt" && f.area === "untracked"), "new file is untracked in git", status.files);
	});

	await step(S8c, "abort stops a long-running bash tool", async () => {
		const t = liveTopic();
		const fromIndex = events.list(t).length;
		const res = await api.post(`/conversations/${liveConvId}/rpc`, { command: { type: "prompt", message: "run: sleep 300; echo never" } });
		assert(res.success === true, "prompt", res);
		await events.waitFor(t, (e) => e.record.type === "tool_execution_start", { fromIndex, timeoutMs: 15_000, what: "bash tool start" });
		await waitUntil("sleep 300 running remotely", () => runAsTestUser(`pgrep -u ${fixture.user} -f '[s]leep 300' >/dev/null && echo y || echo n`).stdout.trim() === "y", {
			timeoutMs: 5000,
		});
		const started = Date.now();
		const aborted = await api.post(`/conversations/${liveConvId}/rpc`, { command: { type: "abort" } });
		assert(aborted.success === true, "abort", aborted);
		await events.waitFor(t, (e) => e.record.type === "agent_settled", { fromIndex, timeoutMs: 15_000, what: "agent_settled after abort" });
		await events.waitFor(t, (e) => e.record.type === "pi_web_status" && e.record.status === "idle", { fromIndex, timeoutMs: 10_000, what: "idle after abort" });
		info(`abort settled in ${Date.now() - started} ms`);
		const run = events.list(t).slice(fromIndex);
		const end = run.find((e) => e.record.type === "tool_execution_end");
		assert(end?.record.isError === true, "the tool ended as an error (aborted)", end?.record);
		await waitUntil("sleep 300 killed", () => runAsTestUser(`pgrep -u ${fixture.user} -f '[s]leep 300' >/dev/null && echo y || echo n`).stdout.trim() === "n", {
			timeoutMs: 10_000,
		});
		const snap = await api.get(`/conversations/${liveConvId}/snapshot`);
		assert(!snap.snapshot.isRunning && snap.snapshot.runningTools.length === 0 && snap.snapshot.info.status === "idle", "idle after abort", snap.snapshot.info);
		// The conversation still works afterwards.
		liveSeqs.last = Math.max(liveSeqs.last, lastLiveSeq());
		const next = await promptOn(liveConvId, liveSeqs, "中止之后");
		assert(lastAssistantText(next) === "收到：中止之后", "prompt after abort", lastAssistantText(next));
	});

	// ---------------------------------------------------------------- generation timing, rpiv-todo list
	const S8d = "timing+todos";
	const TODO_KEY = "pi-web:todos";
	const todoSnapshot = async () => {
		const snap = await api.get(`/conversations/${liveConvId}/snapshot`);
		const text = snap.snapshot.ui.statuses[TODO_KEY];
		return { snap, todos: text ? JSON.parse(text) : null };
	};

	await step(S8d, "generation timing: the snapshot keeps time to first token and decode time of each reply", async () => {
		assert(liveConvId, "no live conversation");
		liveSeqs.last = Math.max(liveSeqs.last, lastLiveSeq());
		// The mock streams 3 characters every 15 ms: about 20 chunks, 300 ms of decoding.
		const run = await promptOn(liveConvId, liveSeqs, "吞吐速率测试".repeat(10));
		const end = run.findLast((e) => e.record.type === "message_end" && e.record.message.role === "assistant");
		const message = end?.record.message;
		assert(message && message.durationMs > 0 && message.usage.output === 7, "pi reports durationMs and usage", message);
		const snap = await api.get(`/conversations/${liveConvId}/snapshot`);
		const timing = snap.snapshot.timing?.messages?.[String(message.timestamp)];
		assert(timing && timing.decodeMs >= 200 && timing.ttftMs >= 0, "timing of the reply", { timing, durationMs: message.durationMs });
		assert(timing.ttftMs + timing.decodeMs <= message.durationMs + 250, "timing fits in pi's own duration", { timing, durationMs: message.durationMs });
		assert(snap.snapshot.timing.streaming === null, "nothing is streaming", snap.snapshot.timing);
	});

	await step(S8d, "rpiv-todo: the companion extension publishes the todo list as the pi-web:todos status", async () => {
		const fromIndex = events.list(liveTopic()).length;
		const run = await promptOn(liveConvId, liveSeqs, 'todo: {"action":"create","tasks":[{"subject":"调研"},{"subject":"实现"},{"subject":"测试"}]}');
		const end = run.find((e) => e.record.type === "tool_execution_end");
		assert(end?.record.toolName === "todo" && !end.record.isError && end.record.result.details.tasks.length === 3, "the todo tool ran", end?.record);
		const status = await events.waitFor(liveTopic(), (e) => e.record.type === "extension_ui_request" && e.record.method === "setStatus" && e.record.statusKey === TODO_KEY, {
			fromIndex,
			timeoutMs: 10_000,
			what: "pi-web:todos setStatus",
		});
		const pushed = JSON.parse(status.record.statusText);
		assert(pushed.v === 1 && pushed.tasks.map((t) => `${t.id}:${t.subject}:${t.status}`).join(",") === "1:调研:pending,2:实现:pending,3:测试:pending", "pushed list", pushed);
		const { todos } = await todoSnapshot();
		assert(todos?.tasks.length === 3 && todos.hidden.length === 0, "the list is in the snapshot", todos);
	});

	await step(S8d, "rpiv-todo: updates are published; completed tasks of earlier prompts are marked hidden", async () => {
		await promptOn(liveConvId, liveSeqs, 'todo: {"action":"update","id":1,"status":"in_progress","activeForm":"调研中"}');
		let { todos } = await todoSnapshot();
		assert(todos.tasks[0].status === "in_progress" && todos.tasks[0].activeForm === "调研中", "in progress", todos);
		await promptOn(liveConvId, liveSeqs, 'todo: {"action":"update","id":1,"status":"completed"}');
		({ todos } = await todoSnapshot());
		assert(todos.tasks[0].status === "completed" && todos.hidden.length === 0, "completed in this prompt: still shown", todos);
		await promptOn(liveConvId, liveSeqs, "继续下一项");
		await waitUntil("task #1 hidden after the next prompt", async () => (await todoSnapshot()).todos?.hidden.join(",") === "1", { timeoutMs: 10_000 });
	});

	await step(S8d, "rpiv-todo: the list survives a compaction that drops the todo tool results from the context", async () => {
		// Push the todo calls out of the kept tail (keepRecentTokens is 40 in the E2E settings).
		await promptOn(liveConvId, liveSeqs, `填充上下文 ${"x".repeat(400)}`);
		await promptOn(liveConvId, liveSeqs, `填充上下文 ${"y".repeat(400)}`);
		const fromIndex = events.list(liveTopic()).length;
		const res = await api.post(`/conversations/${liveConvId}/rpc`, { command: { type: "compact" }, timeoutMs: 120_000 });
		assert(res.success === true, "compact", res);
		await events.waitFor(liveTopic(), (e) => e.record.type === "compaction_end", { fromIndex, timeoutMs: 60_000, what: "compaction_end" });
		const { snap, todos } = await todoSnapshot();
		const todoResults = snap.snapshot.messages.filter((m) => m.role === "toolResult" && m.toolName === "todo");
		assert(snap.snapshot.messages.some((m) => m.role === "compactionSummary"), "the context was compacted", snap.snapshot.messages.map((m) => m.role));
		assert(todoResults.length === 0, "the todo results are no longer in the context", todoResults.length);
		assert(todos?.tasks.map((t) => t.status).join(",") === "completed,pending,pending" && todos.hidden.join(",") === "1", "the list is unchanged", todos);
		liveSeqs.last = Math.max(liveSeqs.last, lastLiveSeq());
	});

	// ---------------------------------------------------------------- uninstall
	const S9 = "uninstall";
	await step(S9, "uninstall keeps sessions when requested", async () => {
		// Keep the remote agent log for post-mortems (uninstall removes ~/.pi-web).
		await writeFile(path.join(tmp, "remote-agent.log"), runAsTestUser("cat ~/.pi-web/logs/agent.log 2>/dev/null").stdout).catch(() => {});
		const res =await api.post(`/servers/${serverId}/uninstall`, { keepSessions: true });
		assert(res.ok === true, "uninstall", res);
		assert(runAsTestUser(`test -e ${fixture.home}/.pi-web && echo yes || echo no`).stdout.trim() === "no", "~/.pi-web removed");
		const backups = runAsTestUser(`ls -d ${fixture.home}/pi-web-backups/sessions-*`).stdout.trim().split("\n").filter(Boolean);
		assert(backups.length === 1, "one sessions backup", backups);
		const files = runAsTestUser(`find ${backups[0]} -name '*.jsonl'`).stdout.trim().split("\n").filter(Boolean);
		assert(files.length >= 2, `backed up session files: ${files.length}`, files);
		const view = await api.get(`/servers/${serverId}`);
		assert(!view.config.deployed && view.status.deployState === "not_deployed", "server no longer deployed", view);
		// "[.]pi-web/" so pgrep does not match the `sh -c` running it; covers the daemon and its pi children.
		const leftovers = await waitUntil(
			"agent daemon and pi processes gone",
			() => {
				const out = runAsTestUser(`pgrep -u ${fixture.user} -af '[.]pi-web/' || true`).stdout.trim();
				return out === "" ? "none" : null;
			},
			{ timeoutMs: 10_000 },
		).catch(() => runAsTestUser(`pgrep -u ${fixture.user} -af '[.]pi-web/' || true`).stdout.trim());
		assert(leftovers === "none", "agent daemon and pi processes stopped", leftovers);
	});

	// ---------------------------------------------------------------- diagnostics on failure
	if (results.some((r) => r.status === "FAIL")) {
		console.log("\n---- pi-web output (tail) ----");
		console.log(tailFile(serverLog.file, 80));
		if (dataDir) {
			console.log("\n---- pi-web.log (tail) ----");
			console.log(tailFile(path.join(dataDir, "logs", "pi-web.log"), 80));
		}
		console.log("\n---- remote agent.log at the first failure (tail) ----");
		console.log(firstFailureDiagnostics);
		if (tmp) console.log(`\n(temp dir: ${tmp}${KEEP ? "" : " — set E2E_KEEP=1 to keep it"})`);
	}
}

let exitCode = 0;
try {
	await main();
} catch (err) {
	console.error(`unexpected error: ${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await cleanup();
}

exitCode = Math.max(exitCode, runner.summary("Pi-Web API E2E summary"));
console.log(exitCode === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(exitCode);
