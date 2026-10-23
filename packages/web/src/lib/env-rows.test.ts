import { describe, expect, it } from "vitest";
import { envRowsEqual, envToRows, envValueErrorKey, newEnvRow, rowsToEnv } from "./env-rows";

describe("env rows (shared rules)", () => {
	it("rejects the variables Pi-Web manages, in any letter case", () => {
		const rows = [newEnvRow("HTTP_PROXY", "x"), newEnvRow("No_Proxy", "x"), newEnvRow("PI_CODING_AGENT_DIR", "/x"), newEnvRow("OPENVIKING_URL", "http://v")];
		const { env, errors } = rowsToEnv(rows);
		expect(env).toEqual({ OPENVIKING_URL: "http://v" });
		expect(errors[rows[0].id]).toBe("HTTP_PROXY 由 Pi-Web 管理，请在服务器设置的“LLM 代理”中配置");
		expect(errors[rows[1].id]).toContain("LLM 代理");
		expect(errors[rows[2].id]).toContain("Agent 目录");
	});

	it("checks values and the number of variables", () => {
		const nul = newEnvRow("A", "a\u0000b");
		const big = newEnvRow("B", "x".repeat(32 * 1024 + 1));
		// Value problems are keyed apart from name problems, so the editor marks the value field.
		expect(rowsToEnv([nul, big]).errors).toEqual({ [envValueErrorKey(nul.id)]: "变量值不能包含 NUL 字符", [envValueErrorKey(big.id)]: "变量值不能超过 32 KiB" });
		const uid = newEnvRow("UID", "1");
		const long = newEnvRow("N".repeat(257), "1");
		expect(rowsToEnv([uid, long]).errors).toEqual({ [uid.id]: "UID 是 shell 只读变量，不能设置", [long.id]: "变量名不能超过 256 个字符" });
		// The map as a whole stays under 256 KiB: the row that crosses it is flagged on its value.
		const large = Array.from({ length: 9 }, (_, i) => newEnvRow(`V${i}`, "x".repeat(32 * 1024 - 4)));
		const sized = rowsToEnv(large);
		expect(Object.keys(sized.env)).toHaveLength(8);
		expect(sized.errors).toEqual({ [envValueErrorKey(large[8].id)]: "环境变量总大小不能超过 256 KiB" });
		const many = Array.from({ length: 101 }, (_, i) => newEnvRow(`V${i}`, "x"));
		const { env, errors } = rowsToEnv(many);
		expect(Object.keys(env)).toHaveLength(100);
		expect(errors).toEqual({ [many[100].id]: "环境变量最多 100 个" });
	});

	it("compares variables, not rows", () => {
		const a = envToRows({ A: "1", B: "2" });
		expect(envRowsEqual(a, envToRows({ B: "2", A: "1" }))).toBe(true);
		expect(envRowsEqual(a, [...envToRows({ A: "1", B: "2" }), newEnvRow()])).toBe(true);
		expect(envRowsEqual(a, envToRows({ A: "1", B: "2 " }))).toBe(false);
		expect(envRowsEqual(a, envToRows({ A: "1" }))).toBe(false);
		expect(envRowsEqual([newEnvRow("A", "1"), newEnvRow("A", "1")], envToRows({ A: "1" }))).toBe(false);
	});
});
