import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettingsPatch } from "../../src/routes/settings.js";
import { makeServer } from "./fakes.js";
import { createTestApp } from "./helpers.js";
import type { TestApp } from "./helpers.js";

let t: TestApp;
beforeEach(async () => {
	t = await createTestApp();
	await t.store.saveServer(makeServer());
});
afterEach(async () => {
	await t.app.close();
});

describe("settings", () => {
	it("reads and updates settings", async () => {
		expect((await t.request("GET", "/api/settings")).json()).toMatchObject({ listenPort: 7878, nodeSource: "official" });
		const res = await t.request("PUT", "/api/settings", {
			nodeSource: "npmmirror",
			nodeVersion: "v22.20.0",
			targetArchs: ["arm64", "arm64"],
			proxyPortRange: [31000, 32000],
			defaultNoProxy: ["localhost", " 10.0.0.0/8 "],
			upstreamProxy: "http://proxy.corp:3128",
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			nodeSource: "npmmirror",
			nodeVersion: "22.20.0",
			targetArchs: ["arm64"],
			proxyPortRange: [31000, 32000],
			defaultNoProxy: ["localhost", "10.0.0.0/8"],
			upstreamProxy: "http://proxy.corp:3128",
		});
		const cleared = await t.request("PUT", "/api/settings", { upstreamProxy: "" });
		expect(cleared.json().upstreamProxy).toBeUndefined();
	});

	it("invalidates the host pi cache and moves the watchers when its agent dir changes", async () => {
		const other = mkdtempSync(path.join(tmpdir(), "pi-web-agent-dir-"));
		const missing = await t.request("PUT", "/api/settings", { hostAgentDir: path.join(other, "agnet") });
		expect(missing.statusCode).toBe(400);
		expect(missing.json().error.message).toContain("Host agent 目录不存在");
		expect(t.syncer.calls.filter((c) => c.method === "rewatch")).toHaveLength(0);
		await t.request("PUT", "/api/settings", { hostAgentDir: other });
		expect(t.hostPi.invalidations).toBe(1);
		expect(t.syncer.calls.filter((c) => c.method === "rewatch")).toHaveLength(1);
		expect(t.oauth.rewatched).toBe(1);
		await t.request("PUT", "/api/settings", { hostAgentDir: other, listenPort: 7979 });
		expect(t.hostPi.invalidations).toBe(1);
		expect(t.oauth.rewatched).toBe(1);
	});

	it("rejects invalid settings", () => {
		const bad: Array<[unknown, string]> = [
			[{ nope: 1 }, "未知的设置项：nope"],
			[{ nodeSource: "ftp" }, "字段 nodeSource 的取值必须是 official / npmmirror / custom 之一"],
			[{ nodeVersion: "22" }, "Node 版本格式无效（例如 latest-22 或 22.20.0）"],
			[{ targetArchs: ["x86"] }, "targetArchs 只能包含 x64 / arm64"],
			[{ proxyPortRange: [40000, 30000] }, "代理端口范围必须是 [起始, 结束]，取值 1024–65535"],
			[{ listenPort: 0 }, "字段 listenPort 必须是 1 到 65535 之间的整数"],
			[{ upstreamProxy: "socks5://x" }, "字段 upstreamProxy 必须是 http(s) 地址"],
			[{ npmRegistry: "not a url" }, "字段 npmRegistry 不是有效的 URL"],
			[{ piPinnedVersion: "latest" }, "pi 版本格式无效（例如 1.4.2）"],
		];
		for (const [body, message] of bad) {
			expect(() => parseSettingsPatch(body), JSON.stringify(body)).toThrow(message);
		}
	});

	it("requires a URL for the custom node source", async () => {
		const res = await t.request("PUT", "/api/settings", { nodeSource: "custom" });
		expect(res.statusCode).toBe(400);
		expect(res.json().error.message).toBe("使用自定义下载源时必须填写下载地址");
		expect((await t.request("PUT", "/api/settings", { nodeSource: "custom", nodeCustomBaseUrl: "https://mirror/node/" })).statusCode).toBe(200);
	});
});

describe("sync and oauth", () => {
	it("exposes inventory, status, preview, run and history", async () => {
		expect((await t.request("GET", "/api/sync/inventory")).json()).toMatchObject({ agentDir: "/host/.pi/agent" });
		expect((await t.request("GET", "/api/sync/status")).json()).toMatchObject({ watching: true });
		expect((await t.request("POST", "/api/sync/preview", { serverId: "srv1" })).json()).toMatchObject({ serverId: "srv1" });
		expect((await t.request("POST", "/api/sync/preview", {})).statusCode).toBe(400);
		expect((await t.request("POST", "/api/sync/preview", { serverId: "nope" })).statusCode).toBe(404);

		const all = await t.request("POST", "/api/sync/run", {});
		expect(all.json().records).toHaveLength(1);
		await t.request("POST", "/api/sync/run", { serverIds: ["srv1"] });
		expect(t.syncer.calls).toEqual([
			{ method: "runMany", args: [undefined, "manual"] },
			{ method: "runMany", args: [["srv1"], "manual"] },
		]);
		expect((await t.request("POST", "/api/sync/run", { serverIds: ["ghost"] })).statusCode).toBe(404);

		for (let i = 0; i < 5; i++) await t.store.appendSyncRecord({ ...(all.json().records[0] as object), id: `r${i}` } as never);
		expect((await t.request("GET", "/api/sync/history?limit=2")).json().records.map((r: { id: string }) => r.id)).toEqual(["r4", "r3"]);
		expect((await t.request("GET", "/api/sync/history?limit=0")).statusCode).toBe(400);
	});

	it("reports and refreshes OAuth", async () => {
		expect((await t.request("GET", "/api/oauth")).json()).toEqual({ providers: [] });
		const res = await t.request("POST", "/api/oauth/anthropic/refresh");
		expect(res.json().providers[0].provider).toBe("anthropic");
		expect(t.oauth.refreshed).toEqual(["anthropic"]);
	});
});

describe("cache", () => {
	it("lists and deletes cache entries", async () => {
		expect((await t.request("GET", "/api/cache")).json()).toEqual({ entries: [], totalBytes: 0 });
		expect((await t.request("DELETE", "/api/cache/node-v22.20.0-linux-x64.tar.gz")).json()).toEqual({ ok: true });
		expect(t.deployer.calls).toContainEqual({ method: "deleteCache", args: ["node-v22.20.0-linux-x64.tar.gz"] });
		expect((await t.request("DELETE", "/api/cache/.hidden")).statusCode).toBe(400);
		expect((await t.request("DELETE", "/api/cache/a..b")).statusCode).toBe(400);
		expect((await t.request("DELETE", "/api/cache/a%2Fb")).statusCode).toBe(400);
	});

	it("streams a raw upload into the deployer whatever its content type", async () => {
		const data = Buffer.alloc(300_000, 7);
		const res = await t.request("POST", "/api/cache/import-node?fileName=node-v22.20.0-linux-x64.tar.xz", data, {
			"content-type": "application/x-xz",
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ name: "node-v22.20.0-linux-x64.tar.xz", kind: "node", bytes: 300_000 });
		expect(t.deployer.imported).toEqual({ fileName: "node-v22.20.0-linux-x64.tar.xz", bytes: 300_000 });

		const json = await t.request("POST", "/api/cache/import-node?fileName=n.tar.gz", Buffer.from("{}"), { "content-type": "application/json" });
		expect(json.statusCode).toBe(200);
		expect(t.deployer.imported).toEqual({ fileName: "n.tar.gz", bytes: 2 });

		const bad = await t.request("POST", "/api/cache/import-node?fileName=../evil.tar.gz", Buffer.from("x"), { "content-type": "application/octet-stream" });
		expect(bad.statusCode).toBe(400);
		expect((await t.request("POST", "/api/cache/import-node?fileName=node.zip", Buffer.from("x"), { "content-type": "application/octet-stream" })).statusCode).toBe(400);
	});
});
