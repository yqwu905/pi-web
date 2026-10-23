import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionSummary, SessionsTopicEvent, WorkspaceView } from "@pi-web/shared";
import { archivedSessions } from "../../src/core/archive.js";
import { FakeAgent, makeServer, makeWorkspace } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import type { TestApp } from "./helpers.js";

let t: TestApp;
let agent: FakeAgent;
/** Session files the fake agent lists, per workspace path. */
let listed: Map<string, string[]>;

const FILE_A = "/home/dev/.pi-web/agent/sessions/--home-dev-project--/2026-01-01T00-00-00-000Z_a.jsonl";
const FILE_B = "/home/dev/.pi-web/agent/sessions/--home-dev-project--/2026-01-01T00-00-00-000Z_b.jsonl";
const FILE_OTHER = "/home/dev/.pi-web/agent/sessions/--home-dev-other--/2026-01-01T00-00-00-000Z_c.jsonl";

function summary(cwd: string, file: string): SessionSummary {
	const id = file.slice(file.lastIndexOf("_") + 1, -".jsonl".length);
	return { file, id, cwd, createdMs: 1, modifiedMs: 2, messageCount: 3, firstMessage: "hi" };
}

async function listSessions(wsId = "ws1"): Promise<SessionSummary[]> {
	const res = await t.request("GET", `/api/workspaces/${wsId}/sessions`);
	expect(res.statusCode).toBe(200);
	return (res.json() as { sessions: SessionSummary[] }).sessions;
}

const archive = (file: string, serverId = "srv1") => t.request("POST", "/api/sessions/archive", { serverId, file });
const unarchive = (file: string, serverId = "srv1") => t.request("POST", "/api/sessions/unarchive", { serverId, file });

beforeEach(async () => {
	t = await createTestApp();
	await t.store.saveServer(makeServer());
	await t.store.saveWorkspace(makeWorkspace());
	await t.store.saveWorkspace(makeWorkspace({ id: "ws2", path: "/home/dev/other", alias: "other" }));
	listed = new Map([
		["/home/dev/project", [FILE_A, FILE_B]],
		["/home/dev/other", [FILE_OTHER]],
	]);
	agent = new FakeAgent();
	agent.handle("sessions.list", (p) => ({ sessions: (listed.get(p.cwd) ?? []).map((file) => summary(p.cwd, file)) }));
	agent.handle("sessions.delete", (p) => ({ trashedTo: `/trash/${p.file.split("/").pop()}` }));
	const conn = t.connections.get("srv1");
	conn.state = "connected";
	conn.agentClient = agent.connect();
});

afterEach(async () => {
	await t.app.close();
});

describe("archived sessions", () => {
	it("archives a session: the list marks it, the count skips it and other tabs are told", async () => {
		const res = await archive(FILE_A);
		expect(res.statusCode).toBe(200);
		const { ok, archivedAt } = res.json() as { ok: boolean; archivedAt: number };
		expect(ok).toBe(true);
		expect(archivedAt).toBeGreaterThan(0);
		expect(t.hub.topic<SessionsTopicEvent>("sessions")).toEqual([{ serverId: "srv1", file: FILE_A, archivedAt }]);

		const sessions = await listSessions();
		expect(sessions.find((s) => s.file === FILE_A)?.archivedAt).toBe(archivedAt);
		expect(sessions.find((s) => s.file === FILE_B)).not.toHaveProperty("archivedAt");
		const workspaces = (await t.request("GET", "/api/servers/srv1/workspaces")).json().workspaces as WorkspaceView[];
		expect(workspaces.map((w) => [w.config.id, w.sessionCount])).toEqual([
			["ws1", 1],
			["ws2", 1],
		]);
		expect((await t.request("GET", "/api/workspaces")).json().workspaces[0].sessionCount).toBe(1);

		// Archiving again keeps the first archive time.
		expect((await archive(FILE_A)).json()).toEqual({ ok: true, archivedAt });
		// The agent never learns about archiving.
		expect(agent.calls.map((c) => c.method)).not.toContain("sessions.archive");
	});

	it("restores a session", async () => {
		await archive(FILE_A);
		t.hub.clear();
		const res = await unarchive(FILE_A);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });
		expect(t.hub.topic("sessions")).toEqual([{ serverId: "srv1", file: FILE_A, archivedAt: null }]);
		expect((await listSessions()).every((s) => s.archivedAt === undefined)).toBe(true);
		expect(t.store.getState("archived:srv1")).toBeUndefined();
		// Restoring a session that is not archived is a no-op.
		t.hub.clear();
		expect((await unarchive(FILE_B)).json()).toEqual({ ok: true });
		expect(t.hub.topic("sessions")).toEqual([]);
	});

	it("archives and restores while the server is offline", async () => {
		const conn = t.connections.get("srv1");
		conn.state = "disconnected";
		conn.agentClient = null;
		expect((await archive(FILE_A)).statusCode).toBe(200);
		expect(archivedSessions(t.store, "srv1")[FILE_A]?.archivedAt).toBeGreaterThan(0);
		// Listing still needs the agent (unchanged offline behavior).
		expect((await t.request("GET", "/api/workspaces/ws1/sessions")).statusCode).toBe(409);
		expect((await unarchive(FILE_A)).statusCode).toBe(200);
		expect(archivedSessions(t.store, "srv1")).toEqual({});
	});

	it("refuses to archive a session whose conversation is running or waiting for a dialog", async () => {
		agent.addConv({ convId: "c-run", cwd: "/home/dev/project", sessionFile: FILE_A, status: "running" });
		agent.addConv({ convId: "c-wait", cwd: "/home/dev/project", sessionFile: FILE_B, status: "waiting_ui" });
		agent.addConv({ convId: "c-idle", cwd: "/home/dev/other", sessionFile: FILE_OTHER, status: "idle" });
		await t.ctx.conversations.attach("srv1", t.connections.get("srv1").agentClient!);
		for (const file of [FILE_A, FILE_B]) {
			const res = await archive(file);
			expect(res.statusCode).toBe(409);
			expect(res.json().error).toEqual({ code: "BUSY", message: "会话正在运行，无法归档" });
		}
		expect(archivedSessions(t.store, "srv1")).toEqual({});
		// An idle process may keep running while its session is archived.
		expect((await archive(FILE_OTHER)).statusCode).toBe(200);
	});

	it("validates the request", async () => {
		const cases: Array<[unknown, number]> = [
			[{ file: FILE_A }, 400],
			[{ serverId: "srv1" }, 400],
			[{ serverId: "srv1", file: "relative/a.jsonl" }, 400],
			[{ serverId: "srv1", file: "/home/dev/a.txt" }, 400],
			[{ serverId: "srv1", file: "/home/dev/../etc/a.jsonl" }, 400],
			[{ serverId: "srv1", file: 42 }, 400],
			[[FILE_A], 400],
			[{ serverId: "nope", file: FILE_A }, 404],
		];
		for (const [body, status] of cases) {
			expect((await t.request("POST", "/api/sessions/archive", body)).statusCode, JSON.stringify(body)).toBe(status);
			expect((await t.request("POST", "/api/sessions/unarchive", body)).statusCode, JSON.stringify(body)).toBe(status);
		}
		expect(t.store.getState("archived:srv1")).toBeUndefined();
	});

	it("drops the record when the session is deleted", async () => {
		await archive(FILE_A);
		await archive(FILE_B);
		t.hub.clear();
		const res = await t.request("DELETE", `/api/sessions?serverId=srv1&file=${encodeURIComponent(FILE_A)}`);
		expect(res.statusCode).toBe(200);
		expect(Object.keys(archivedSessions(t.store, "srv1"))).toEqual([FILE_B]);
		// Marked as a deletion, so the web does not show the session as restored meanwhile.
		expect(t.hub.topic("sessions")).toEqual([{ serverId: "srv1", file: FILE_A, archivedAt: null, deleted: true }]);
	});

	it("drops every record of a deleted server", async () => {
		await archive(FILE_A);
		expect(t.store.getState("archived:srv1")).toBeDefined();
		expect((await t.request("DELETE", "/api/servers/srv1")).statusCode).toBe(200);
		expect(t.store.getState("archived:srv1")).toBeUndefined();
	});

	it("prunes records whose file a successful list of their workspace no longer returns", async () => {
		await archive(FILE_A);
		await archive(FILE_OTHER);
		const never = "/home/dev/.pi-web/agent/sessions/--x--/never-listed.jsonl";
		await archive(never);
		await listSessions("ws1");
		await listSessions("ws2");
		expect(archivedSessions(t.store, "srv1")[FILE_A]?.cwd).toBe("/home/dev/project");

		// FILE_A disappears from the server (e.g. deleted with pi itself).
		listed.set("/home/dev/project", [FILE_B]);
		// A failed list prunes nothing.
		agent.handle("sessions.list", () => {
			throw Object.assign(new Error("boom"), { code: "INTERNAL" });
		});
		expect((await t.request("GET", "/api/workspaces/ws1/sessions")).statusCode).toBe(500);
		expect(Object.keys(archivedSessions(t.store, "srv1")).sort()).toEqual([FILE_A, FILE_OTHER, never].sort());

		agent.handle("sessions.list", (p) => ({ sessions: (listed.get(p.cwd) ?? []).map((file) => summary(p.cwd, file)) }));
		const sessions = await listSessions("ws1");
		expect(sessions.map((s) => s.file)).toEqual([FILE_B]);
		// Only ws1's record went away: the other workspace's and the never listed one stay.
		expect(Object.keys(archivedSessions(t.store, "srv1")).sort()).toEqual([FILE_OTHER, never].sort());

		// The workspace list's count refresh prunes the same way.
		const FILE_D = FILE_OTHER.replace("_c.jsonl", "_d.jsonl");
		listed.set("/home/dev/other", [FILE_D]);
		const workspaces = (await t.request("GET", "/api/servers/srv1/workspaces")).json().workspaces as WorkspaceView[];
		expect(workspaces.map((w) => w.sessionCount)).toEqual([1, 1]);
		expect(Object.keys(archivedSessions(t.store, "srv1"))).toEqual([never]);
	});

	it("keeps the records when the agent lists another session directory", async () => {
		await archive(FILE_A);
		await listSessions("ws1");
		// e.g. the server switched agentDirMode: the agent reads ~/.pi/agent/sessions now; FILE_A is still on disk.
		const moved = "/home/dev/.pi/agent/sessions/--home-dev-project--/2026-02-01T00-00-00-000Z_e.jsonl";
		listed.set("/home/dev/project", [moved]);
		expect((await listSessions("ws1")).map((s) => s.file)).toEqual([moved]);
		listed.set("/home/dev/project", []);
		await listSessions("ws1");
		expect(archivedSessions(t.store, "srv1")[FILE_A]).toBeDefined();
		// Switching back shows it archived again.
		listed.set("/home/dev/project", [FILE_A, FILE_B]);
		expect((await listSessions("ws1")).find((s) => s.file === FILE_A)?.archivedAt).toBeGreaterThan(0);
	});

	it("counts sessions without the archived ones as soon as they are archived or restored, also offline", async () => {
		const counts = async () => ((await t.request("GET", "/api/workspaces")).json().workspaces as WorkspaceView[]).map((w) => w.sessionCount);
		expect(((await t.request("GET", "/api/servers/srv1/workspaces")).json().workspaces as WorkspaceView[]).map((w) => w.sessionCount)).toEqual([2, 1]);
		const conn = t.connections.get("srv1");
		conn.state = "disconnected";
		conn.agentClient = null;
		await archive(FILE_A);
		expect(await counts()).toEqual([1, 1]);
		expect(((await t.request("GET", "/api/servers/srv1/workspaces")).json().workspaces as WorkspaceView[]).map((w) => w.sessionCount)).toEqual([1, 1]);
		await unarchive(FILE_A);
		expect(await counts()).toEqual([2, 1]);
	});

	it("keeps a record archived after a list started that predates its file", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		agent.handle("sessions.list", async (p) => {
			calls++;
			// The first (slow) list read the directory before FILE_A existed.
			if (calls === 1) {
				await gate;
				return { sessions: [summary(p.cwd, FILE_B)] };
			}
			return { sessions: [FILE_A, FILE_B].map((file) => summary(p.cwd, file)) };
		});
		const slow = t.request("GET", "/api/workspaces/ws1/sessions");
		await new Promise((r) => setTimeout(r, 20));
		await archive(FILE_A);
		await listSessions("ws1");
		expect(archivedSessions(t.store, "srv1")[FILE_A]?.cwd).toBe("/home/dev/project");
		release();
		expect((await slow).statusCode).toBe(200);
		expect(archivedSessions(t.store, "srv1")[FILE_A]).toBeDefined();
	});
});
