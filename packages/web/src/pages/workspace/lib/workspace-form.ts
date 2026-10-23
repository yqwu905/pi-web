/**
 * Form model shared by the new-workspace and workspace-settings dialogs: alias, project
 * trust, default model ("provider/modelId") + thinking level, and extra environment variables.
 */
import type { CreateWorkspaceRequest, ThinkingLevel, UpdateWorkspaceRequest, WorkspaceConfig } from "@pi-web/shared";
import { type EnvRow, envToRows, rowsToEnv } from "../../../lib/env-rows";

export { type EnvRow, envToRows, newEnvRow, rowsToEnv } from "../../../lib/env-rows";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface WorkspaceFormValues {
	alias: string;
	trust: "approve" | "no-approve";
	/** "provider/modelId" or empty for pi's default. */
	model: string;
	/** Empty for pi's default. */
	thinking: ThinkingLevel | "";
	env: EnvRow[];
}

export interface WorkspaceFormErrors {
	alias?: string;
	model?: string;
	/** Row id → message. */
	env: Record<string, string>;
}

export type ModelRef = { provider: string; modelId: string };

/** Parses "provider/modelId" (the model id may itself contain "/"). Empty → null. */
export function parseModelRef(text: string): { ok: true; value: ModelRef | null } | { ok: false; error: string } {
	const t = text.trim();
	if (!t) return { ok: true, value: null };
	const i = t.indexOf("/");
	if (i <= 0 || i === t.length - 1) return { ok: false, error: "格式应为 provider/modelId" };
	const provider = t.slice(0, i).trim();
	const modelId = t.slice(i + 1).trim();
	if (!provider || !modelId || /\s/.test(provider)) return { ok: false, error: "格式应为 provider/modelId" };
	return { ok: true, value: { provider, modelId } };
}

export function formatModelRef(defaults: WorkspaceConfig["defaults"] | undefined): string {
	return defaults?.provider && defaults.modelId ? `${defaults.provider}/${defaults.modelId}` : "";
}

export function formFromWorkspace(config: WorkspaceConfig): WorkspaceFormValues {
	return {
		alias: config.alias,
		trust: config.trust,
		model: formatModelRef(config.defaults),
		thinking: config.defaults?.thinkingLevel ?? "",
		env: envToRows(config.env),
	};
}

export function validateWorkspaceForm(values: WorkspaceFormValues): { errors: WorkspaceFormErrors; valid: boolean } {
	const errors: WorkspaceFormErrors = { env: {} };
	if (!values.alias.trim()) errors.alias = "请填写别名";
	else if (values.alias.trim().length > 200) errors.alias = "别名过长";
	const model = parseModelRef(values.model);
	if (!model.ok) errors.model = model.error;
	errors.env = rowsToEnv(values.env).errors;
	const valid = !errors.alias && !errors.model && Object.keys(errors.env).length === 0;
	return { errors, valid };
}

/** PUT /workspaces/:id body. `defaults` and `env` are always sent so clearing them works. */
export function toUpdateRequest(values: WorkspaceFormValues): UpdateWorkspaceRequest {
	const model = parseModelRef(values.model);
	const defaults: WorkspaceConfig["defaults"] = {};
	if (model.ok && model.value) {
		defaults.provider = model.value.provider;
		defaults.modelId = model.value.modelId;
	}
	if (values.thinking) defaults.thinkingLevel = values.thinking;
	return {
		alias: values.alias.trim(),
		trust: values.trust,
		defaults,
		env: rowsToEnv(values.env).env,
	};
}

/** POST /servers/:id/workspaces body. */
export function toCreateRequest(path: string, values: WorkspaceFormValues): CreateWorkspaceRequest {
	return { path, ...toUpdateRequest(values), create: false };
}
