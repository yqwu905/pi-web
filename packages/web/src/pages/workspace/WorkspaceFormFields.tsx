import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { conversationRpc } from "../../api/client";
import { EnvEditor } from "../../components/EnvEditor";
import { Radio, RadioGroup } from "../../components/ui/Choice";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { useLiveConversations } from "../../stores/convs";
import { THINKING_LEVELS, type WorkspaceFormErrors, type WorkspaceFormValues } from "./lib/workspace-form";

/**
 * "provider/modelId" suggestions from a live conversation on the server (models are only
 * known to a running pi process); empty when none is running.
 */
export function useModelSuggestions(serverId: string, enabled: boolean): string[] {
	const live = useLiveConversations();
	const conv = live.find((c) => c.serverId === serverId && c.info.status !== "starting");
	const query = useQuery({
		queryKey: ["servers", serverId, "models", conv?.convId ?? ""],
		queryFn: async () => {
			const res = await conversationRpc(conv?.convId as string, { command: { type: "get_available_models" }, timeoutMs: 10_000 });
			if (!res.success) return [];
			const models = (res.data as { models?: Array<{ provider: string; id: string }> } | undefined)?.models ?? [];
			return [...new Set(models.map((m) => `${m.provider}/${m.id}`))].sort();
		},
		enabled: enabled && Boolean(conv),
		staleTime: 5 * 60_000,
		retry: false,
	});
	return query.data ?? [];
}

export interface WorkspaceFormFieldsProps {
	values: WorkspaceFormValues;
	onChange: (patch: Partial<WorkspaceFormValues>) => void;
	/** Shown after the first submit attempt. */
	errors?: WorkspaceFormErrors;
	modelSuggestions?: readonly string[];
	disabled?: boolean;
	/** Called when the alias is edited by the user (stops auto-filling it from the path). */
	onAliasEdited?: () => void;
}

/** Alias, project trust, default model + thinking level and env vars (Dialogs artboard, 新建工作区). */
export function WorkspaceFormFields({ values, onChange, errors, modelSuggestions = [], disabled, onAliasEdited }: WorkspaceFormFieldsProps) {
	const listId = useId();
	return (
		<>
			<Field label="别名" error={errors?.alias} required>
				<Input
					value={values.alias}
					disabled={disabled}
					maxLength={200}
					onChange={(e) => {
						onAliasEdited?.();
						onChange({ alias: e.target.value });
					}}
				/>
			</Field>
			<RadioGroup
				label="项目信任（Project trust）"
				description="RPC 模式无法弹出信任确认，需要在此指定"
				value={values.trust}
				onChange={(v) => onChange({ trust: v as WorkspaceFormValues["trust"] })}
				disabled={disabled}
			>
				<Radio
					value="approve"
					label={
						<span>
							信任：加载 <code className="text-xs text-fg-code">.pi</code> 中的设置与扩展（<code className="text-xs text-fg-code">--approve</code>）
						</span>
					}
				/>
				<Radio
					value="no-approve"
					label={
						<span>
							不信任：忽略项目资源（<code className="text-xs text-fg-code">--no-approve</code>）
						</span>
					}
				/>
			</RadioGroup>
			<div className="flex gap-3">
				<Field label="默认模型" error={errors?.model} hint={errors?.model ? undefined : "格式 provider/modelId，留空使用 pi 的默认模型"} className="min-w-0 flex-1">
					<Input
						mono
						list={modelSuggestions.length > 0 ? listId : undefined}
						placeholder={`留空使用默认，例如 ${modelSuggestions[0] ?? "anthropic/claude-sonnet-4-5"}`}
						value={values.model}
						disabled={disabled}
						spellCheck={false}
						autoComplete="off"
						onChange={(e) => onChange({ model: e.target.value })}
					/>
				</Field>
				<Field label="思考级别" className="w-[120px] shrink-0">
					<Select
						value={values.thinking}
						disabled={disabled}
						onChange={(e) => onChange({ thinking: e.target.value as WorkspaceFormValues["thinking"] })}
						options={[{ value: "", label: "默认" }, ...THINKING_LEVELS.map((l) => ({ value: l, label: l }))]}
					/>
				</Field>
			</div>
			{modelSuggestions.length > 0 && (
				<datalist id={listId}>
					{modelSuggestions.map((m) => (
						<option key={m} value={m} />
					))}
				</datalist>
			)}
			<EnvEditor
				label="环境变量"
				hint="传给该工作区中的 pi 进程，同名时覆盖服务器级环境变量"
				rows={values.env}
				errors={errors?.env ?? {}}
				onChange={(env) => onChange({ env })}
				disabled={disabled}
			/>
		</>
	);
}
