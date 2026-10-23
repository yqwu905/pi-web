import { describe, expect, it } from "vitest";
import {
	ENV_COUNT_ERROR,
	ENV_TOTAL_ERROR,
	envEntryBytes,
	envNameError,
	envValueError,
	MAX_ENV_TOTAL_BYTES,
	MAX_ENV_VALUE_BYTES,
	MAX_ENV_VARS,
	reservedEnvReason,
	utf8Length,
	validateEnvMap,
} from "./env.js";

describe("env names", () => {
	it("accepts shell identifiers", () => {
		for (const name of ["A", "_x", "OPENVIKING_URL", "a1_B2", "HTTPS_PROXY_URL", "PI_OFFLINE"]) expect(envNameError(name), name).toBeNull();
	});

	it("rejects empty and malformed names", () => {
		expect(envNameError("")).toBe("请填写变量名");
		for (const name of ["1A", "A-B", "A B", "A=B", "Ä", "A\0"]) expect(envNameError(name), name).toContain("只能包含字母、数字和下划线");
	});

	it("rejects the proxy variables in any letter case and PI_CODING_AGENT_DIR", () => {
		for (const name of ["HTTP_PROXY", "https_proxy", "All_Proxy", "no_proxy", "NO_PROXY"]) {
			expect(envNameError(name), name).toBe(`${name} 由 Pi-Web 管理，请在服务器设置的“LLM 代理”中配置`);
		}
		expect(envNameError("PI_CODING_AGENT_DIR")).toContain("Agent 目录");
		expect(reservedEnvReason("pi_coding_agent_dir")).toBeNull();
		expect(reservedEnvReason("HTTPS_PROXY_HOST")).toBeNull();
	});

	it("rejects the variables bash keeps read-only (exporting one aborts a POSIX-mode sh)", () => {
		for (const name of ["UID", "EUID", "PPID", "SHELLOPTS", "BASHOPTS", "BASH_VERSINFO"]) {
			expect(envNameError(name), name).toBe(`${name} 是 shell 只读变量，不能设置`);
		}
		expect(reservedEnvReason("uid")).toBeNull();
		expect(reservedEnvReason("APP_UID")).toBeNull();
		expect(validateEnvMap({ UID: "1000" })).toEqual({ ok: false, error: "UID 是 shell 只读变量，不能设置" });
	});

	it("limits the name length", () => {
		expect(envNameError("A".repeat(256))).toBeNull();
		expect(envNameError("A".repeat(257))).toBe("变量名不能超过 256 个字符");
		expect(validateEnvMap({ ["A".repeat(140 * 1024)]: "x" })).toEqual({ ok: false, error: "环境变量名不能超过 256 个字符" });
	});
});

describe("env values", () => {
	it("allows any text without NUL up to 32 KiB of UTF-8", () => {
		expect(envValueError("")).toBeNull();
		expect(envValueError(`it's "$HOME" \`x\`\nline 2`)).toBeNull();
		expect(envValueError("a".repeat(MAX_ENV_VALUE_BYTES))).toBeNull();
		expect(envValueError("a".repeat(MAX_ENV_VALUE_BYTES + 1))).toBe("不能超过 32 KiB");
		// 3 bytes per character: 11k characters are 33 KB.
		expect(envValueError("中".repeat(11_000))).toBe("不能超过 32 KiB");
		expect(envValueError("中".repeat(10_000))).toBeNull();
		expect(envValueError("a\0b")).toBe("不能包含 NUL 字符");
	});
});

describe("validateEnvMap", () => {
	it("returns the map when every entry is valid", () => {
		expect(validateEnvMap({})).toEqual({ ok: true, env: {} });
		expect(validateEnvMap({ OPENVIKING_URL: "http://10.0.0.2:1933", EMPTY: "" })).toEqual({
			ok: true,
			env: { OPENVIKING_URL: "http://10.0.0.2:1933", EMPTY: "" },
		});
	});

	it("names the first problem", () => {
		expect(validateEnvMap({ "BAD-NAME": "x" })).toEqual({ ok: false, error: "环境变量名无效：BAD-NAME" });
		expect(validateEnvMap({ https_proxy: "x" })).toEqual({ ok: false, error: "https_proxy 由 Pi-Web 管理，请在服务器设置的“LLM 代理”中配置" });
		expect(validateEnvMap({ PI_CODING_AGENT_DIR: "/x" })).toMatchObject({ ok: false });
		expect(validateEnvMap({ A: 1 })).toEqual({ ok: false, error: "环境变量 A 的值必须是字符串" });
		expect(validateEnvMap({ A: "x\0" })).toEqual({ ok: false, error: "环境变量 A 的值不能包含 NUL 字符" });
		expect(validateEnvMap({ A: "x".repeat(MAX_ENV_VALUE_BYTES + 1) })).toEqual({ ok: false, error: "环境变量 A 的值不能超过 32 KiB" });
	});

	it("limits the total size, so the merged environment stays far below the execve limit", () => {
		expect(MAX_ENV_TOTAL_BYTES).toBe(256 * 1024);
		expect(ENV_TOTAL_ERROR).toBe("环境变量总大小不能超过 256 KiB");
		const value = "x".repeat(MAX_ENV_VALUE_BYTES - 4);
		// "V0=" + value: 3 + 32764 = 32 KiB - 1 byte each; eight of them fit, nine do not.
		const vars = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`V${i}`, value]));
		expect(validateEnvMap(vars(8)).ok).toBe(true);
		expect(validateEnvMap(vars(9))).toEqual({ ok: false, error: ENV_TOTAL_ERROR });
	});

	it("measures UTF-8 sizes", () => {
		expect(utf8Length("aé中😀")).toBe(new TextEncoder().encode("aé中😀").length);
		expect(utf8Length("\ud800x")).toBe(new TextEncoder().encode("\ud800x").length);
		expect(envEntryBytes("A", "中")).toBe(5);
	});

	it("limits the number of variables", () => {
		const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`V${i}`, "x"]));
		expect(validateEnvMap(many(MAX_ENV_VARS)).ok).toBe(true);
		expect(validateEnvMap(many(MAX_ENV_VARS + 1))).toEqual({ ok: false, error: ENV_COUNT_ERROR });
		expect(ENV_COUNT_ERROR).toBe("环境变量最多 100 个");
	});
});
