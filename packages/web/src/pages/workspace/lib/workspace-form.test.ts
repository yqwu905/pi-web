import type { WorkspaceConfig } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import {
	envToRows,
	formatModelRef,
	formFromWorkspace,
	newEnvRow,
	parseModelRef,
	rowsToEnv,
	toCreateRequest,
	toUpdateRequest,
	validateWorkspaceForm,
	type WorkspaceFormValues,
} from "./workspace-form";

describe("env rows", () => {
	it("round-trips env records", () => {
		const rows = envToRows({ CUDA_VISIBLE_DEVICES: "0,1", HF_HOME: "/data/hf" });
		expect(rows.map((r) => [r.name, r.value])).toEqual([
			["CUDA_VISIBLE_DEVICES", "0,1"],
			["HF_HOME", "/data/hf"],
		]);
		expect(new Set(rows.map((r) => r.id)).size).toBe(2);
		expect(rowsToEnv(rows)).toEqual({ env: { CUDA_VISIBLE_DEVICES: "0,1", HF_HOME: "/data/hf" }, errors: {} });
	});
	it("validates names and duplicates, ignoring blank rows", () => {
		const a = newEnvRow("1BAD", "x");
		const b = newEnvRow("OK", "1");
		const c = newEnvRow(" OK ", "2");
		const d = newEnvRow("", "");
		const e = newEnvRow("", "orphan");
		const { env, errors } = rowsToEnv([a, b, c, d, e]);
		expect(env).toEqual({ OK: "1" });
		expect(Object.keys(errors).sort()).toEqual([a.id, c.id, e.id].sort());
		expect(errors[c.id]).toContain("重复");
		expect(errors[e.id]).toBe("请填写变量名");
	});
});

describe("model refs", () => {
	it("parses provider/modelId", () => {
		expect(parseModelRef("")).toEqual({ ok: true, value: null });
		expect(parseModelRef(" anthropic/claude-sonnet-4-5 ")).toEqual({ ok: true, value: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
		expect(parseModelRef("openrouter/qwen/qwen3-coder")).toEqual({ ok: true, value: { provider: "openrouter", modelId: "qwen/qwen3-coder" } });
		expect(parseModelRef("gpt-5").ok).toBe(false);
		expect(parseModelRef("/x").ok).toBe(false);
		expect(parseModelRef("x/").ok).toBe(false);
	});
	it("formats defaults", () => {
		expect(formatModelRef({ provider: "openai", modelId: "gpt-5" })).toBe("openai/gpt-5");
		expect(formatModelRef({ thinkingLevel: "low" })).toBe("");
		expect(formatModelRef(undefined)).toBe("");
	});
});

describe("form → requests", () => {
	const config: WorkspaceConfig = {
		id: "w1",
		serverId: "s1",
		path: "/home/dev/x",
		alias: "x",
		trust: "approve",
		defaults: { provider: "anthropic", modelId: "claude", thinkingLevel: "medium" },
		env: { A: "1" },
		createdAt: 0,
	};
	it("loads a workspace", () => {
		const values = formFromWorkspace(config);
		expect(values).toMatchObject({ alias: "x", trust: "approve", model: "anthropic/claude", thinking: "medium" });
		expect(values.env.map((r) => r.name)).toEqual(["A"]);
	});
	it("validates", () => {
		const values: WorkspaceFormValues = { alias: " ", trust: "approve", model: "bad", thinking: "", env: [newEnvRow("1", "")] };
		const { errors, valid } = validateWorkspaceForm(values);
		expect(valid).toBe(false);
		expect(errors.alias).toBeTruthy();
		expect(errors.model).toBeTruthy();
		expect(Object.keys(errors.env)).toHaveLength(1);
		expect(validateWorkspaceForm(formFromWorkspace(config)).valid).toBe(true);
	});
	it("builds update and create bodies", () => {
		const values: WorkspaceFormValues = { alias: " vision ", trust: "no-approve", model: "", thinking: "high", env: [] };
		expect(toUpdateRequest(values)).toEqual({ alias: "vision", trust: "no-approve", defaults: { thinkingLevel: "high" }, env: {} });
		expect(toCreateRequest("/p", { ...values, model: "openai/gpt-5", thinking: "" })).toEqual({
			path: "/p",
			alias: "vision",
			trust: "no-approve",
			defaults: { provider: "openai", modelId: "gpt-5" },
			env: {},
			create: false,
		});
	});
});
