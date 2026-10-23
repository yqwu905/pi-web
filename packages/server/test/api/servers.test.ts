import { afterEach, describe, expect, it } from "vitest";
import type { ServerView } from "@pi-web/shared";
import { FakeAgent, makeServer, makeWorkspace } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import type { TestApp } from "./helpers.js";

let t: TestApp;
afterEach(async () => {
	await t?.app.close();
});

async function withServer(): Promise<TestApp> {
	t = await createTestApp();
	await t.store.saveServer(makeServer());
	return t;
}

/** Marks the server connected with an agent link to a FakeAgent. */
function connectAgent(app: TestApp): FakeAgent {
	const agent = new FakeAgent();
	const conn = app.connections.get("srv1");
	conn.state = "connected";
	conn.agentClient = agent.connect();
	return agent;
}

describe("server CRUD", () => {
	it("creates a server with defaults and stores the secret encrypted, not in the config", async () => {
		t = await createTestApp();
		const res = await t.request("POST", "/api/servers", {
			name: "GPU box",
			host: "gpu.lan",
			username: "dev",
			auth: { method: "password", secret: "hunter2" },
		});
		expect(res.statusCode).toBe(200);
		const view = res.json() as ServerView;
		expect(view.config).toMatchObject({
			name: "GPU box",
			host: "gpu.lan",
			port: 22,
			username: "dev",
			auth: { method: "password", hasSecret: true },
			jumpServerIds: [],
			remoteRoot: "~/.pi-web",
			agentDirMode: "isolated",
			proxy: { mode: "tunnel", scope: "llm", toolsPolicy: "allowlist", extraDomains: [], noProxy: [] },
			idleTimeoutMin: 30,
		});
		expect(view.config.proxy.port).toBeGreaterThanOrEqual(30000);
		expect(view.config.sync.items.settings).toBe(true);
		expect(view.config.sync.items.keybindings).toBe(false);
		expect(JSON.stringify(view)).not.toContain("hunter2");
		expect(view.status).toMatchObject({ serverId: view.config.id, connection: "disconnected" });
		expect(await t.secrets.get(`server:${view.config.id}:secret`)).toBe("hunter2");

		const list = await t.request("GET", "/api/servers");
		expect(list.json().servers).toHaveLength(1);
		expect((await t.request("GET", `/api/servers/${view.config.id}`)).json().config.name).toBe("GPU box");
	});

	it("validates create requests", async () => {
		t = await createTestApp();
		const cases: Array<[unknown, string]> = [
			[{ host: "h", username: "u", auth: { method: "agent" } }, "缺少字段 name"],
			[{ name: "n", host: "h", username: "u", auth: { method: "key" } }, "私钥认证需要填写私钥路径"],
			[{ name: "n", host: "h", username: "u", auth: { method: "magic" } }, "字段 method 的取值必须是 key / password / agent 之一"],
			[{ name: "n", host: "h", username: "u", port: 70000, auth: { method: "agent" } }, "字段 port 必须是 1 到 65535 之间的整数"],
			[{ name: "n", host: "h", username: "u", auth: { method: "agent" }, jumpServerIds: ["nope"] }, "跳板机不存在：nope"],
			[{ name: "n", host: "h", username: "u", auth: { method: "agent" }, remoteRoot: "rel/path" }, "远端安装目录必须是绝对路径或以 ~/ 开头"],
			// Normalized before validation: "~/" is the home directory itself.
			[{ name: "n", host: "h", username: "u", auth: { method: "agent" }, remoteRoot: "~/" }, "远端安装目录不能是家目录本身"],
			[{ name: "n", host: "h", username: "u", auth: { method: "agent" }, remoteRoot: "//" }, "远端安装目录不能是 /"],
			[{ name: "n", host: "h", username: "u", auth: { method: "agent" }, remoteRoot: "~/x/../.." }, "远端安装目录不能包含 .."],
			[{ name: "n", host: "h", username: "u", auth: { method: "agent" }, proxy: { extraDomains: ["bad domain"] } }, "域名格式无效：bad domain"],
			[{ name: "n", host: "h", username: "u", auth: { method: "agent" }, sync: { items: { bogus: true } } }, "未知的同步项：bogus"],
			[[1, 2], "请求体必须是 JSON 对象"],
		];
		for (const [body, message] of cases) {
			const res = await t.request("POST", "/api/servers", body);
			expect(res.statusCode, JSON.stringify(body)).toBe(400);
			expect(res.json().error).toEqual({ code: "BAD_REQUEST", message });
		}
		expect(t.store.servers.size).toBe(0);
	});

	it("updates fields, merges nested config, clears secrets and drops the host key on endpoint change", async () => {
		await withServer();
		await t.secrets.set("server:srv1:secret", "old");
		const server = t.store.getServer("srv1")!;
		server.auth = { method: "password", hasSecret: true };
		server.hostKey = { algorithm: "ssh-ed25519", fingerprint: "SHA256:abc", trustedAt: 1 };
		await t.store.saveServer(server);

		const res = await t.request("PUT", "/api/servers/srv1", {
			name: "renamed",
			port: 2222,
			auth: { method: "password", secret: null },
			proxy: { scope: "tools", toolsPolicy: "all" },
			sync: { items: { keybindings: true }, auto: false },
		});
		expect(res.statusCode).toBe(200);
		const config = res.json().config;
		expect(config).toMatchObject({ name: "renamed", port: 2222, auth: { method: "password" } });
		expect(config.auth.hasSecret).toBeUndefined();
		expect(config.proxy).toMatchObject({ mode: "tunnel", port: 31000, scope: "tools", toolsPolicy: "all" });
		expect(config.sync.items).toMatchObject({ keybindings: true, settings: true });
		expect(config.sync.auto).toBe(false);
		expect(config.hostKey).toBeUndefined();
		expect(await t.secrets.get("server:srv1:secret")).toBeUndefined();
	});

	it("pushes a new agent config when agent-relevant settings change on a connected server", async () => {
		await withServer();
		const agent = connectAgent(t);
		agent.handle("agent.configure", () => ({ ok: true }));
		await t.request("PUT", "/api/servers/srv1", { idleTimeoutMin: 5 });
		expect(t.deployer.calls.map((c) => c.method)).toContain("buildAgentConfig");
		expect(t.deployer.calls.map((c) => c.method)).not.toContain("syncAgentDir");
		// The agent dir is baked into R/bin/pi as well.
		await t.request("PUT", "/api/servers/srv1", { agentDirMode: "shared" });
		expect(t.deployer.calls.filter((c) => c.method === "syncAgentDir")).toHaveLength(1);
		expect(agent.callsOf("agent.configure")).toHaveLength(2);
		await t.request("PUT", "/api/servers/srv1", { remoteRoot: "~/.pi-web-2/" });
		expect(t.store.getServer("srv1")!.remoteRoot).toBe("~/.pi-web-2");
		await t.request("PUT", "/api/servers/srv1", { name: "just a rename" });
		expect(agent.callsOf("agent.configure")).toHaveLength(3);
	});

	it("stores the server-level env on create and replaces it on update", async () => {
		t = await createTestApp();
		const created = await t.request("POST", "/api/servers", {
			name: "env box",
			host: "h",
			username: "u",
			auth: { method: "agent" },
			env: { OPENVIKING_URL: "http://10.0.0.2:1933", QUOTED: "it's \"$HOME\"\nline 2" },
		});
		expect(created.statusCode).toBe(200);
		const id = (created.json() as ServerView).config.id;
		expect(t.store.getServer(id)!.env).toEqual({ OPENVIKING_URL: "http://10.0.0.2:1933", QUOTED: "it's \"$HOME\"\nline 2" });
		const plain = await t.request("POST", "/api/servers", { name: "plain", host: "h2", username: "u", auth: { method: "agent" } });
		expect(plain.json().config.env).toEqual({});

		const renamed = await t.request("PUT", `/api/servers/${id}`, { name: "renamed" });
		expect(renamed.json().config.env).toEqual({ OPENVIKING_URL: "http://10.0.0.2:1933", QUOTED: "it's \"$HOME\"\nline 2" });
		const replaced = await t.request("PUT", `/api/servers/${id}`, { env: { ONLY: "1" } });
		expect(replaced.json().config.env).toEqual({ ONLY: "1" });
		const cleared = await t.request("PUT", `/api/servers/${id}`, { env: {} });
		expect(cleared.json().config.env).toEqual({});
	});

	it("rejects invalid and Pi-Web managed env variables", async () => {
		await withServer();
		const cases: Array<[unknown, string]> = [
			[{ "BAD-NAME": "x" }, "环境变量名无效：BAD-NAME"],
			[{ "1A": "x" }, "环境变量名无效：1A"],
			[{ HTTPS_PROXY: "http://p" }, "HTTPS_PROXY 由 Pi-Web 管理，请在服务器设置的“LLM 代理”中配置"],
			[{ no_proxy: "x" }, "no_proxy 由 Pi-Web 管理，请在服务器设置的“LLM 代理”中配置"],
			[{ PI_CODING_AGENT_DIR: "/x" }, "PI_CODING_AGENT_DIR 由服务器设置中的“Agent 目录”决定，不能在此设置"],
			[{ A: 1 }, "环境变量 A 的值必须是字符串"],
			[{ A: "x\u0000y" }, "环境变量 A 的值不能包含 NUL 字符"],
			[{ A: "x".repeat(32 * 1024 + 1) }, "环境变量 A 的值不能超过 32 KiB"],
			[Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`V${i}`, "x"])), "环境变量最多 100 个"],
			[{ UID: "1000" }, "UID 是 shell 只读变量，不能设置"],
			[{ ["N".repeat(257)]: "x" }, "环境变量名不能超过 256 个字符"],
			[Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`V${i}`, "x".repeat(32 * 1024 - 4)])), "环境变量总大小不能超过 256 KiB"],
			["A=1", "字段 env 必须是对象"],
		];
		for (const [env, message] of cases) {
			const res = await t.request("PUT", "/api/servers/srv1", { env });
			expect(res.statusCode, message).toBe(400);
			expect(res.json().error).toEqual({ code: "BAD_REQUEST", message });
		}
		const create = await t.request("POST", "/api/servers", { name: "n", host: "h", username: "u", auth: { method: "agent" }, env: { ALL_PROXY: "x" } });
		expect(create.statusCode).toBe(400);
		expect(t.store.getServer("srv1")!.env).toEqual({});
		expect(t.store.servers.size).toBe(1);
	});

	it("reconfigures the connected agent when the server env changes", async () => {
		await withServer();
		const agent = connectAgent(t);
		agent.handle("agent.configure", () => ({ ok: true }));
		await t.request("PUT", "/api/servers/srv1", { env: { OPENVIKING_URL: "http://10.0.0.2:1933" } });
		expect(agent.callsOf("agent.configure")).toHaveLength(1);
		await t.request("PUT", "/api/servers/srv1", { env: {} });
		expect(agent.callsOf("agent.configure")).toHaveLength(2);
		await t.request("PUT", "/api/servers/srv1", { defaultTrust: "no-approve" });
		expect(agent.callsOf("agent.configure")).toHaveLength(2);
	});

	it("deletes a server with its workspaces and secrets, unless it is used as a jump host", async () => {
		await withServer();
		await t.store.saveServer(makeServer({ id: "srv2", name: "inner", jumpServerIds: ["srv1"] }));
		const blocked = await t.request("DELETE", "/api/servers/srv1");
		expect(blocked.statusCode).toBe(409);
		expect(blocked.json().error).toEqual({ code: "SERVER_IN_USE", message: "该服务器被用作其他服务器的跳板机：inner" });

		await t.store.saveWorkspace(makeWorkspace({ id: "w2", serverId: "srv2" }));
		await t.secrets.set("server:srv2:secret", "x");
		await t.secrets.set("server:srv2:proxyToken", "y");
		const res = await t.request("DELETE", "/api/servers/srv2");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });
		expect(t.store.getServer("srv2")).toBeUndefined();
		expect(t.store.getWorkspace("w2")).toBeUndefined();
		expect(t.secrets.values.size).toBe(0);
		expect(t.connections.calls).toContainEqual({ method: "remove", args: ["srv2"] });
		expect((await t.request("GET", "/api/servers/srv2")).statusCode).toBe(404);
	});

	it("lists hosts from ssh config through the injected reader", async () => {
		t = await createTestApp({ app: { sshConfigHosts: async () => [{ alias: "gpu", hostName: "10.0.0.9", user: "me" }] } });
		const res = await t.request("GET", "/api/ssh-config");
		expect(res.json()).toEqual({ hosts: [{ alias: "gpu", hostName: "10.0.0.9", user: "me" }] });
	});
});

describe("connection actions", () => {
	it("tests unsaved and saved connections", async () => {
		await withServer();
		const res = await t.request("POST", "/api/servers/test", {
			host: "h",
			port: 2200,
			username: "u",
			auth: { method: "key", keyPath: "~/.ssh/id_ed25519", secret: "pp" },
			jumpServerIds: ["srv1"],
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true, hostKeyStatus: "trusted", latencyMs: 5 });
		expect(t.connections.calls[0]).toEqual({
			method: "testConnection",
			args: [{ host: "h", port: 2200, username: "u", auth: { method: "key", keyPath: "~/.ssh/id_ed25519", secret: "pp" }, jumpServerIds: ["srv1"] }],
		});
		await t.request("POST", "/api/servers/srv1/test");
		expect(t.connections.calls[1].args[0]).toMatchObject({ host: "10.0.0.5", serverId: "srv1", auth: { method: "agent" } });
	});

	it("tests unsaved edits of an existing server with its trusted key and stored secret", async () => {
		await withServer();
		const res = await t.request("POST", "/api/servers/test", {
			serverId: "srv1",
			host: "10.0.0.5",
			port: 22,
			username: "other",
			auth: { method: "password" },
			jumpServerIds: [],
		});
		expect(res.statusCode).toBe(200);
		expect(t.connections.calls[0]).toEqual({
			method: "testConnection",
			args: [{ host: "10.0.0.5", port: 22, username: "other", auth: { method: "password" }, jumpServerIds: [], serverId: "srv1" }],
		});
		const missing = await t.request("POST", "/api/servers/test", { serverId: "nope", host: "h", username: "u", auth: { method: "agent" } });
		expect(missing.statusCode).toBe(404);
		const selfJump = await t.request("POST", "/api/servers/test", {
			serverId: "srv1",
			host: "h",
			username: "u",
			auth: { method: "agent" },
			jumpServerIds: ["srv1"],
		});
		expect(selfJump.statusCode).toBe(400);
	});

	it("trusts host keys", async () => {
		await withServer();
		const bad = await t.request("POST", "/api/servers/srv1/trust-host-key", { algorithm: "ssh-ed25519", fingerprint: "md5:aa" });
		expect(bad.statusCode).toBe(400);
		const res = await t.request("POST", "/api/servers/srv1/trust-host-key", { algorithm: "ssh-ed25519", fingerprint: "SHA256:AbC+/1" });
		expect(res.statusCode).toBe(200);
		expect(res.json().config.hostKey).toMatchObject({ algorithm: "ssh-ed25519", fingerprint: "SHA256:AbC+/1" });
	});

	it("connects and disconnects", async () => {
		await withServer();
		t.connections.agentFactory = () => new FakeAgent().connect();
		const connected = await t.request("POST", "/api/servers/srv1/connect");
		expect(connected.json().status.connection).toBe("connected");
		const disconnected = await t.request("POST", "/api/servers/srv1/disconnect");
		expect(disconnected.json().status.connection).toBe("disconnected");
		expect(t.connections.calls.map((c) => c.method)).toEqual(["connect", "disconnect"]);
	});

	it("drives the deployer", async () => {
		await withServer();
		expect((await t.request("POST", "/api/servers/srv1/probe")).json().arch).toBe("x64");
		expect((await t.request("GET", "/api/servers/srv1/deploy")).json()).toEqual({ job: null });
		const started = await t.request("POST", "/api/servers/srv1/deploy", { force: true, piVersion: "v1.4.2", proxyMode: "off" });
		expect(started.json()).toMatchObject({ serverId: "srv1", state: "running" });
		expect(t.deployer.calls.at(-1)).toEqual({ method: "deploy", args: ["srv1", { force: true, piVersion: "1.4.2", proxyMode: "off" }] });
		expect((await t.request("GET", "/api/servers/srv1/deploy")).json().job.jobId).toBe("job1");
		expect((await t.request("POST", "/api/servers/srv1/deploy", { piVersion: "latest" })).statusCode).toBe(400);
		expect((await t.request("POST", "/api/servers/srv1/deploy/cancel")).json()).toEqual({ ok: true });
		expect((await t.request("POST", "/api/servers/srv1/restart-agent")).json()).toEqual({ ok: true });
		await t.request("POST", "/api/servers/srv1/uninstall", { keepSessions: false });
		await t.request("POST", "/api/servers/srv1/uninstall", {});
		expect(t.deployer.calls.filter((c) => c.method === "uninstall").map((c) => c.args[1])).toEqual([
			{ keepSessions: false },
			{ keepSessions: true },
		]);
		expect((await t.request("POST", "/api/servers/nope/probe")).statusCode).toBe(404);
	});

	it("requires a connection for agent-backed endpoints", async () => {
		await withServer();
		const res = await t.request("GET", "/api/servers/srv1/agent-status");
		expect(res.statusCode).toBe(409);
		expect(res.json().error).toEqual({ code: "NOT_CONNECTED", message: "服务器未连接，请先连接" });
	});

	it("reads agent status, logs and proxy stats", async () => {
		await withServer();
		const agent = connectAgent(t);
		agent.handle("agent.status", () => ({ agentVersion: "0.1.0", pid: 1, uptimeSec: 2, conversations: [], proxy: { listening: true, port: 1, activeConnections: 0 }, loadavg: [0, 0, 0] }));
		agent.handle("agent.logs", (p) => ({ lines: [`tail=${p.tail}`] }));
		expect((await t.request("GET", "/api/servers/srv1/agent-status")).json().pid).toBe(1);
		expect((await t.request("GET", "/api/servers/srv1/logs")).json()).toEqual({ lines: ["tail=200"] });
		expect((await t.request("GET", "/api/servers/srv1/logs?tail=5")).json()).toEqual({ lines: ["tail=5"] });
		expect((await t.request("GET", "/api/servers/srv1/logs?tail=abc")).statusCode).toBe(400);
		expect((await t.request("GET", "/api/servers/srv1/proxy")).json()).toEqual({ active: 1, byHost: [], denied: [] });
	});

	it("allows proxy domains", async () => {
		await withServer();
		const res = await t.request("POST", "/api/servers/srv1/proxy/allow", { domain: "*.Example.com" });
		expect(res.json().config.proxy.extraDomains).toEqual(["*.example.com"]);
		expect((await t.request("POST", "/api/servers/srv1/proxy/allow", { domain: "a b" })).statusCode).toBe(400);
	});

	it("lists and creates remote directories for the directory picker", async () => {
		await withServer();
		const agent = connectAgent(t);
		agent.handle("fs.list", (p) => ({ path: p.path === "~" ? "/home/dev" : p.path, parent: "/home", entries: [], showHidden: p.showHidden }));
		agent.handle("fs.realpath", (p) => ({ path: p.path.replace(/^~/, "/home/dev") }));
		const list = await t.request("GET", "/api/servers/srv1/fs/list");
		expect(list.json()).toMatchObject({ path: "/home/dev", showHidden: false });
		await t.request("GET", "/api/servers/srv1/fs/list?path=/opt&showHidden=true");
		expect(agent.callsOf("fs.list")[1]).toEqual({ path: "/opt", showHidden: true });
		expect((await t.request("GET", "/api/servers/srv1/fs/list?path=relative")).statusCode).toBe(400);

		const mk = await t.request("POST", "/api/servers/srv1/fs/mkdir", { path: "~/new dir" });
		expect(mk.json()).toEqual({ ok: true, path: "/home/dev/new dir" });
		expect(agent.callsOf("fs.mkdir")).toEqual([{ path: "~/new dir", recursive: true }]);
	});
});
