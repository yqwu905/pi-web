import type { ServerView, SshConfigHost } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import {
	connectionSignature,
	defaultServerName,
	emptyConnectionForm,
	formFromSshHost,
	hasErrors,
	jumpCandidates,
	jumpChainLabel,
	parsePort,
	parseProxyJump,
	sshHostExtra,
	sshHostTarget,
	toAuthInput,
	toCreateRequest,
	toTestRequest,
	validateConnectionForm,
} from "./connection-form";

function server(id: string, name: string, host: string, username = "ops", port = 22): ServerView {
	return {
		config: { id, name, host, port, username, jumpServerIds: [] } as unknown as ServerView["config"],
		status: { serverId: id } as ServerView["status"],
	};
}

const filled = () => ({ ...emptyConnectionForm(), name: "gpu-01", host: "10.0.3.21", username: "dev" });

describe("parsePort", () => {
	it("accepts 1–65535 and defaults empty text", () => {
		expect(parsePort("22")).toBe(22);
		expect(parsePort(" 2222 ")).toBe(2222);
		expect(parsePort("")).toBe(22);
		expect(parsePort("", null)).toBeNull();
		expect(parsePort("0")).toBeNull();
		expect(parsePort("65536")).toBeNull();
		expect(parsePort("22a")).toBeNull();
		expect(parsePort("-1")).toBeNull();
	});
});

describe("validateConnectionForm", () => {
	it("passes a complete key form", () => {
		expect(hasErrors(validateConnectionForm(filled()))).toBe(false);
	});
	it("reports missing and malformed fields", () => {
		const errors = validateConnectionForm({ ...emptyConnectionForm(), host: "a b", port: "99999", keyPath: " " });
		expect(errors.host).toBeTruthy();
		expect(errors.port).toBeTruthy();
		expect(errors.username).toBe("请填写用户名");
		expect(errors.keyPath).toBe("请填写私钥路径");
	});
	it("requires a password only when asked", () => {
		const v = { ...filled(), authMethod: "password" as const, secret: "" };
		expect(validateConnectionForm(v).secret).toBeUndefined();
		expect(validateConnectionForm(v, { requirePassword: true }).secret).toBe("请填写密码");
	});
	it("rejects duplicate jump hosts", () => {
		expect(validateConnectionForm({ ...filled(), jumpServerIds: ["a", "a"] }).jumpServerIds).toBeTruthy();
	});
});

describe("request builders", () => {
	it("builds auth payloads per method, omitting empty secrets", () => {
		expect(toAuthInput({ ...filled(), keyPath: " ~/.ssh/k " })).toEqual({ method: "key", keyPath: "~/.ssh/k" });
		expect(toAuthInput({ ...filled(), secret: "pp" })).toEqual({ method: "key", keyPath: "~/.ssh/id_ed25519", secret: "pp" });
		expect(toAuthInput({ ...filled(), authMethod: "password", secret: "pw" })).toEqual({ method: "password", secret: "pw" });
		expect(toAuthInput({ ...filled(), authMethod: "agent", secret: "x" })).toEqual({ method: "agent" });
	});
	it("builds test and create requests with trimmed values", () => {
		const v = { ...filled(), host: " 10.0.3.21 ", port: "2222", group: " 训练集群 ", jumpServerIds: ["j1"] };
		expect(toTestRequest(v)).toEqual({
			host: "10.0.3.21",
			port: 2222,
			username: "dev",
			auth: { method: "key", keyPath: "~/.ssh/id_ed25519" },
			jumpServerIds: ["j1"],
		});
		expect(toTestRequest({ ...v, jumpServerIds: [] }, "srv1")).toMatchObject({ jumpServerIds: [], serverId: "srv1" });
		expect(toTestRequest(v)).not.toHaveProperty("serverId");
		const create = toCreateRequest(v);
		expect(create.name).toBe("gpu-01");
		expect(create.group).toBe("训练集群");
		expect(create.port).toBe(2222);
		expect(create.jumpServerIds).toEqual(["j1"]);
		expect(toCreateRequest({ ...v, group: "" }).group).toBeUndefined();
	});
	it("defaults the name to user@host", () => {
		expect(defaultServerName({ name: " ", host: "h", username: "u" })).toBe("u@h");
		expect(toCreateRequest({ ...filled(), name: "" }).name).toBe("dev@10.0.3.21");
	});
	it("signature changes only with connection-relevant fields", () => {
		const a = filled();
		expect(connectionSignature(a)).toBe(connectionSignature({ ...a, name: "other", group: "g" }));
		expect(connectionSignature(a)).not.toBe(connectionSignature({ ...a, port: "2222" }));
		expect(connectionSignature(a)).not.toBe(connectionSignature({ ...a, jumpServerIds: ["x"] }));
		expect(connectionSignature({ ...a, authMethod: "agent", secret: "x" })).toBe(connectionSignature({ ...a, authMethod: "agent", secret: "" }));
	});
});

describe("ssh config import", () => {
	const servers = [server("s-bastion", "bastion-gw", "203.0.113.10"), server("s-other", "other", "10.0.0.9", "root", 2200)];

	it("parses ProxyJump chains", () => {
		expect(parseProxyJump("bastion-gw")).toEqual([{ raw: "bastion-gw", host: "bastion-gw" }]);
		expect(parseProxyJump("a, root@10.0.0.9:2200")).toEqual([
			{ raw: "a", host: "a" },
			{ raw: "root@10.0.0.9:2200", host: "10.0.0.9", user: "root", port: 2200 },
		]);
		expect(parseProxyJump("none")).toEqual([]);
		expect(parseProxyJump(undefined)).toEqual([]);
	});

	it("fills the form and resolves jump hosts by name or address", () => {
		const entry: SshConfigHost = { alias: "gpu-01", hostName: "10.0.3.21", user: "dev", port: 22, proxyJump: "bastion-gw,root@10.0.0.9:2200,missing" };
		const { values, unresolvedJumps } = formFromSshHost(entry, servers, { ...emptyConnectionForm(), authMethod: "agent", secret: "old" });
		expect(values.name).toBe("gpu-01");
		expect(values.host).toBe("10.0.3.21");
		expect(values.username).toBe("dev");
		expect(values.secret).toBe("");
		expect(values.authMethod).toBe("agent");
		expect(values.jumpServerIds).toEqual(["s-bastion", "s-other"]);
		expect(unresolvedJumps).toEqual(["missing"]);
	});

	it("uses IdentityFile for key auth and the alias as host fallback", () => {
		const { values } = formFromSshHost({ alias: "build-arm", identityFile: "~/.ssh/id_rsa" }, [], emptyConnectionForm());
		expect(values.host).toBe("build-arm");
		expect(values.port).toBe("22");
		expect(values.authMethod).toBe("key");
		expect(values.keyPath).toBe("~/.ssh/id_rsa");
	});

	it("formats import rows", () => {
		expect(sshHostTarget({ alias: "x", hostName: "10.0.5.8", user: "ops" })).toBe("ops@10.0.5.8:22");
		expect(sshHostExtra({ alias: "x", proxyJump: "b", identityFile: "k" })).toBe("ProxyJump b");
		expect(sshHostExtra({ alias: "x", identityFile: "k" })).toBe("IdentityFile k");
	});
});

describe("jump chains", () => {
	const servers = [server("a", "A", "1"), server("b", "B", "2"), server("c", "C", "3")];
	it("labels chains and excludes self and other hops from candidates", () => {
		expect(jumpChainLabel(["a", "b", "zz"], servers)).toBe("A → B → zz");
		expect(jumpCandidates(servers, "c", ["a", "b"], 1).map((s) => s.config.id)).toEqual(["b"]);
		expect(jumpCandidates(servers, undefined, [], 0).map((s) => s.config.id)).toEqual(["a", "b", "c"]);
	});
});
