import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FsStatResult, WorkspaceView } from "@pi-web/shared";
import { contentDisposition } from "../../src/routes/files.js";
import { resolveWorkspacePath } from "../../src/routes/util.js";
import { FakeAgent, makeServer, makeWorkspace } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import type { TestApp } from "./helpers.js";

let t: TestApp;
let agent: FakeAgent;
/** Remote "filesystem" for fs.stat / fs.realpath. */
let dirs: Map<string, FsStatResult["type"]>;

beforeEach(async () => {
	t = await createTestApp();
	await t.store.saveServer(makeServer());
	agent = new FakeAgent();
	dirs = new Map([
		["/home/dev/project", "dir"],
		["/home/dev/file.txt", "file"],
	]);
	const real = (p: string) => p.replace(/^~/, "/home/dev").replace(/(.)\/+$/, "$1").replace(/^\/link$/, "/home/dev/project");
	agent.handle("fs.stat", (p) => {
		const path = real(p.path);
		const type = dirs.get(path);
		return type ? { path, exists: true, type } : { path, exists: false };
	});
	agent.handle("fs.realpath", (p) => ({ path: real(p.path) }));
	agent.handle("fs.mkdir", (p) => {
		dirs.set(real(p.path), "dir");
		return { ok: true };
	});
	const conn = t.connections.get("srv1");
	conn.state = "connected";
	conn.agentClient = agent.connect();
});

afterEach(async () => {
	await t.app.close();
});

describe("workspaces", () => {
	it("creates a workspace at the canonical path with server defaults", async () => {
		const res = await t.request("POST", "/api/servers/srv1/workspaces", { path: "/link" });
		expect(res.statusCode).toBe(200);
		const view = res.json() as WorkspaceView;
		expect(view.config).toMatchObject({
			serverId: "srv1",
			path: "/home/dev/project",
			alias: "project",
			trust: "approve",
			defaults: {},
			env: {},
		});
		expect(view.runningCount).toBe(0);
		expect(t.store.listWorkspaces("srv1")).toHaveLength(1);

		const dup = await t.request("POST", "/api/servers/srv1/workspaces", { path: "/home/dev/project/" });
		expect(dup.statusCode).toBe(409);
		expect(dup.json().error).toEqual({ code: "WORKSPACE_EXISTS", message: "该工作区已存在" });
	});

	it("creates the directory when asked, otherwise reports it missing", async () => {
		const missing = await t.request("POST", "/api/servers/srv1/workspaces", { path: "~/new" });
		expect(missing.statusCode).toBe(400);
		expect(missing.json().error).toEqual({ code: "PATH_NOT_FOUND", message: "目录不存在：~/new" });

		const res = await t.request("POST", "/api/servers/srv1/workspaces", {
			path: "~/new",
			create: true,
			alias: "New",
			trust: "no-approve",
			defaults: { provider: "anthropic", modelId: "m", thinkingLevel: "high" },
			env: { API_BASE: "http://x" },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().config).toMatchObject({
			path: "/home/dev/new",
			alias: "New",
			trust: "no-approve",
			defaults: { provider: "anthropic", modelId: "m", thinkingLevel: "high" },
			env: { API_BASE: "http://x" },
		});
		expect(agent.callsOf("fs.mkdir")).toEqual([{ path: "~/new", recursive: true }]);
	});

	it("validates the path and fields", async () => {
		const cases: Array<[unknown, number, string]> = [
			[{ path: "relative/dir" }, 400, "工作区路径必须是绝对路径或以 ~ 开头"],
			[{ path: "/home/dev/file.txt" }, 400, "不是目录：/home/dev/file.txt"],
			[{ path: "/home/dev/project", env: { "BAD-NAME": "x" } }, 400, "环境变量名无效：BAD-NAME"],
			// Same rules as the server-level env.
			[{ path: "/home/dev/project", env: { https_proxy: "x" } }, 400, "https_proxy 由 Pi-Web 管理，请在服务器设置的“LLM 代理”中配置"],
			[{ path: "/home/dev/project", defaults: { provider: "only" } }, 400, "默认模型需要同时指定 provider 和 modelId"],
			[{ path: "/home/dev/project", trust: "maybe" }, 400, "字段 trust 的取值必须是 approve / no-approve 之一"],
		];
		for (const [body, status, message] of cases) {
			const res = await t.request("POST", "/api/servers/srv1/workspaces", body);
			expect(res.statusCode, JSON.stringify(body)).toBe(status);
			expect(res.json().error.message).toBe(message);
		}
		expect((await t.request("POST", "/api/servers/nope/workspaces", { path: "/x" })).statusCode).toBe(404);
	});

	it("lists, updates and deletes workspaces", async () => {
		await t.store.saveWorkspace(makeWorkspace());
		await t.store.saveWorkspace(makeWorkspace({ id: "ws-other", serverId: "srv2" }));
		expect((await t.request("GET", "/api/workspaces")).json().workspaces).toHaveLength(2);
		expect((await t.request("GET", "/api/servers/srv1/workspaces")).json().workspaces.map((w: WorkspaceView) => w.config.id)).toEqual(["ws1"]);

		const updated = await t.request("PUT", "/api/workspaces/ws1", { alias: "Renamed", env: { A: "1" }, defaults: { thinkingLevel: "low" } });
		expect(updated.json().config).toMatchObject({ alias: "Renamed", env: { A: "1" }, defaults: { thinkingLevel: "low" }, path: "/home/dev/project" });
		expect((await t.request("PUT", "/api/workspaces/ws1", { path: "/elsewhere" })).statusCode).toBe(400);

		expect((await t.request("DELETE", "/api/workspaces/ws1")).json()).toEqual({ ok: true });
		expect((await t.request("DELETE", "/api/workspaces/ws1")).statusCode).toBe(404);
	});

	it("counts running conversations per workspace", async () => {
		await t.store.saveWorkspace(makeWorkspace());
		agent.addConv({ convId: "c1", cwd: "/home/dev/project", status: "running" });
		agent.addConv({ convId: "c2", cwd: "/home/dev/project", status: "exited" });
		await t.ctx.conversations.attach("srv1", t.connections.get("srv1").agentClient!);
		const list = await t.request("GET", "/api/workspaces");
		expect(list.json().workspaces[0].runningCount).toBe(1);
	});

	it("reports the last known session count per workspace", async () => {
		await t.store.saveWorkspace(makeWorkspace());
		await t.store.saveWorkspace(makeWorkspace({ id: "ws2", path: "/home/dev/other" }));
		const session = (cwd: string, id: string) => ({ file: `/s/${id}.jsonl`, id, cwd, createdMs: 1, modifiedMs: 2, messageCount: 3, firstMessage: "hi" });
		agent.handle("sessions.list", (p) =>
			p.cwd === "/home/dev/project" ? { sessions: [session(p.cwd, "a"), session(p.cwd, "b")] } : { sessions: [] },
		);
		expect((await t.request("GET", "/api/workspaces")).json().workspaces[0].sessionCount).toBeUndefined();
		const byServer = (await t.request("GET", "/api/servers/srv1/workspaces")).json().workspaces as WorkspaceView[];
		expect(byServer.map((w) => [w.config.id, w.sessionCount])).toEqual([
			["ws1", 2],
			["ws2", 0],
		]);
		agent.handle("sessions.list", (p) => ({ sessions: [session(p.cwd, "c")] }));
		await t.request("GET", "/api/workspaces/ws1/sessions");
		const all = (await t.request("GET", "/api/workspaces")).json().workspaces as WorkspaceView[];
		expect(all.find((w) => w.config.id === "ws1")?.sessionCount).toBe(1);
		expect(all.find((w) => w.config.id === "ws2")?.sessionCount).toBe(0);
	});

	it("lists the workspace's sessions", async () => {
		await t.store.saveWorkspace(makeWorkspace());
		agent.handle("sessions.list", (p) => ({ sessions: [{ file: "/s/a.jsonl", id: "a", cwd: p.cwd, createdMs: 1, modifiedMs: 2, messageCount: 3, firstMessage: "hi" }] }));
		const res = await t.request("GET", "/api/workspaces/ws1/sessions");
		expect(res.json()).toEqual({ sessions: [{ file: "/s/a.jsonl", id: "a", cwd: "/home/dev/project", createdMs: 1, modifiedMs: 2, messageCount: 3, firstMessage: "hi" }] });
	});
});

describe("workspace files", () => {
	beforeEach(async () => {
		await t.store.saveWorkspace(makeWorkspace());
	});

	it("resolves paths against the workspace", () => {
		expect(resolveWorkspacePath("/w", undefined)).toBe("/w");
		expect(resolveWorkspacePath("/w", "src/a.ts")).toBe("/w/src/a.ts");
		expect(resolveWorkspacePath("/w", "../up")).toBe("/up");
		expect(resolveWorkspacePath("/w", "/etc//hosts")).toBe("/etc/hosts");
		expect(resolveWorkspacePath("/w", "~/x")).toBe("~/x");
		expect(resolveWorkspacePath("/w", "~/x", "/home/dev")).toBe("/home/dev/x");
		expect(resolveWorkspacePath("/w", "~", "/home/dev")).toBe("/home/dev");
	});

	it("lists and reads files", async () => {
		agent.handle("fs.list", (p) => ({ path: p.path, parent: null, entries: [], opts: p }));
		agent.handle("fs.read", (p) => ({ path: p.path, size: 2, mtimeMs: 1, encoding: "utf8", content: "hi", truncated: false, binary: false, max: p.maxBytes }));

		const root = await t.request("GET", "/api/workspaces/ws1/fs/list");
		expect(root.json().opts).toEqual({ path: "/home/dev/project", showHidden: false, respectGitignore: true, hideIgnored: false });
		const sub = await t.request("GET", "/api/workspaces/ws1/fs/list?path=src&showHidden=1&hideIgnored=true");
		expect(sub.json().opts).toEqual({ path: "/home/dev/project/src", showHidden: true, respectGitignore: true, hideIgnored: true });

		const file = await t.request("GET", "/api/workspaces/ws1/fs/read?path=README.md&maxBytes=1024");
		expect(file.json()).toMatchObject({ path: "/home/dev/project/README.md", content: "hi", max: 1024 });
		expect((await t.request("GET", "/api/workspaces/ws1/fs/read")).statusCode).toBe(400);
		expect((await t.request("GET", "/api/workspaces/ws1/fs/read?path=a&maxBytes=0")).statusCode).toBe(400);
	});

	it("downloads files as attachments", async () => {
		const conn = t.connections.get("srv1");
		conn.files.set("/home/dev/project/报告 1.pdf", Buffer.from("PDFDATA"));
		const res = await t.request("GET", `/api/workspaces/ws1/fs/download?path=${encodeURIComponent("报告 1.pdf")}`);
		expect(res.statusCode).toBe(200);
		expect(res.body).toBe("PDFDATA");
		expect(res.headers["content-type"]).toBe("application/octet-stream");
		expect(res.headers["content-length"]).toBe("7");
		expect(res.headers["content-disposition"]).toBe(contentDisposition("报告 1.pdf"));
		expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A%201.pdf");

		conn.files.set("/home/dev/notes.txt", Buffer.from("n"));
		expect((await t.request("GET", "/api/workspaces/ws1/fs/download?path=~/notes.txt")).body).toBe("n");
		expect((await t.request("GET", "/api/workspaces/ws1/fs/download?path=missing")).statusCode).toBe(404);
	});

	it("needs a connected server", async () => {
		t.connections.get("srv1").state = "disconnected";
		t.connections.get("srv1").agentClient = null;
		const res = await t.request("GET", "/api/workspaces/ws1/fs/list");
		expect(res.statusCode).toBe(409);
		expect((await t.request("GET", "/api/workspaces/ws1/fs/download?path=a")).statusCode).toBe(409);
		expect((await t.request("GET", "/api/workspaces/nope/fs/list")).statusCode).toBe(404);
	});
});

describe("git and sessions", () => {
	beforeEach(async () => {
		await t.store.saveWorkspace(makeWorkspace());
	});

	it("queries git status, diff and log", async () => {
		agent.handle("git.status", (p) => ({ isRepo: true, ahead: 0, behind: 0, files: [], cwd: p.cwd }));
		agent.handle("git.diff", (p) => ({ diff: "", truncated: false, params: p }));
		agent.handle("git.log", (p) => ({ commits: [], params: p }));

		expect((await t.request("GET", "/api/workspaces/ws1/git/status")).json()).toMatchObject({ isRepo: true, cwd: "/home/dev/project" });
		expect((await t.request("GET", "/api/workspaces/ws1/git/diff")).json().params).toEqual({ cwd: "/home/dev/project", area: "unstaged" });
		expect((await t.request("GET", "/api/workspaces/ws1/git/diff?path=a.ts&area=staged&context=5")).json().params).toEqual({
			cwd: "/home/dev/project",
			area: "staged",
			path: "a.ts",
			contextLines: 5,
		});
		expect((await t.request("GET", "/api/workspaces/ws1/git/diff?area=bogus")).statusCode).toBe(400);
		expect((await t.request("GET", "/api/workspaces/ws1/git/log?limit=20")).json().params).toEqual({ cwd: "/home/dev/project", limit: 20 });
		expect((await t.request("GET", "/api/workspaces/ws1/git/log")).json().params).toEqual({ cwd: "/home/dev/project" });
	});

	it("reads and deletes session files", async () => {
		agent.handle("sessions.read", (p) => ({ header: null, entries: [], leafId: null, branchIds: [], file: p.file }));
		agent.handle("sessions.delete", (p) => {
			if (p.file === "/s/busy.jsonl") throw Object.assign(new Error("会话正在运行"), { code: "BUSY" });
			return { trashedTo: `/trash/${p.file.split("/").pop()}` };
		});
		const read = await t.request("GET", "/api/sessions/read?serverId=srv1&file=/s/a.jsonl");
		expect(read.json()).toMatchObject({ file: "/s/a.jsonl", branchIds: [] });
		expect((await t.request("GET", "/api/sessions/read?serverId=srv1&file=rel.jsonl")).statusCode).toBe(400);
		expect((await t.request("GET", "/api/sessions/read?file=/s/a.jsonl")).statusCode).toBe(400);
		expect((await t.request("GET", "/api/sessions/read?serverId=nope&file=/s/a.jsonl")).statusCode).toBe(404);

		const del = await t.request("DELETE", "/api/sessions?serverId=srv1&file=/s/a.jsonl");
		expect(del.json()).toEqual({ trashedTo: "/trash/a.jsonl" });
		const busy = await t.request("DELETE", "/api/sessions?serverId=srv1&file=/s/busy.jsonl");
		expect(busy.statusCode).toBe(409);
		expect(busy.json().error).toEqual({ code: "BUSY", message: "会话正在运行" });
	});
});
