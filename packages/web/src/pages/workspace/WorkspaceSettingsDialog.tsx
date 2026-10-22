import type { WorkspaceConfig } from "@pi-web/shared";
import { useMutation } from "@tanstack/react-query";
import { Trash2, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { deleteWorkspace, errorMessage, updateWorkspace } from "../../api/client";
import { invalidateWorkspaces, useWorkspace } from "../../api/hooks";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Display";
import { Modal } from "../../components/ui/Modal";
import { toast } from "../../components/ui";
import { parseRoute, paths } from "../../lib/routes";
import { useServer } from "../../stores/servers";
import { useUiStore } from "../../stores/ui";
import { formFromWorkspace, toUpdateRequest, validateWorkspaceForm, type WorkspaceFormValues } from "./lib/workspace-form";
import { closeWorkspaceTerminals } from "./terminal-store";
import { useModelSuggestions, WorkspaceFormFields } from "./WorkspaceFormFields";

export interface WorkspaceSettingsDialogProps {
	workspaceId: string;
	open: boolean;
	onClose: () => void;
}

function ConfirmRemove({ workspace, onCancel, onRemoved }: { workspace: WorkspaceConfig; onCancel: () => void; onRemoved: () => void }) {
	const mutation = useMutation({
		mutationFn: () => deleteWorkspace(workspace.id),
		onSuccess: async () => {
			closeWorkspaceTerminals(workspace.id);
			// Leave the workspace's pages before the list refresh drops it.
			onRemoved();
			toast.success(`已移除工作区 ${workspace.alias}`);
			await invalidateWorkspaces(workspace.serverId);
		},
	});
	return (
		<Modal
			open
			role="alertdialog"
			size="sm"
			onClose={onCancel}
			icon={<TriangleAlert className="text-warning" />}
			title="从列表移除工作区？"
			description={
				<>
					将从 Pi-Web 中移除 <span className="text-fg">{workspace.alias}</span>。服务器上的目录 <code className="text-xs text-fg-code">{workspace.path}</code>{" "}
					和其中的会话记录不会被删除，之后可以重新添加。
				</>
			}
			footer={
				<>
					<Button onClick={onCancel} data-autofocus>
						取消
					</Button>
					<Button variant="danger" loading={mutation.isPending} onClick={() => mutation.mutate()}>
						移除
					</Button>
				</>
			}
		>
			{mutation.isError && (
				<Callout tone="danger" title="移除失败">
					{errorMessage(mutation.error)}
				</Callout>
			)}
		</Modal>
	);
}

function SettingsForm({ workspace, onClose }: { workspace: WorkspaceConfig; onClose: () => void }) {
	const server = useServer(workspace.serverId);
	const connected = server?.status.connection === "connected";
	const navigate = useNavigate();
	const location = useLocation();
	const [values, setValues] = useState<WorkspaceFormValues>(() => formFromWorkspace(workspace));
	const [submitted, setSubmitted] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const suggestions = useModelSuggestions(workspace.serverId, connected);
	const validation = validateWorkspaceForm(values);

	const mutation = useMutation({
		mutationFn: () => updateWorkspace(workspace.id, toUpdateRequest(values)),
		onSuccess: async (view) => {
			await invalidateWorkspaces(workspace.serverId);
			toast.success(`已保存工作区 ${view.config.alias}`);
			onClose();
		},
	});

	const submit = () => {
		setSubmitted(true);
		if (!validation.valid || mutation.isPending) return;
		mutation.mutate();
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const el = e.target as HTMLInputElement;
		if (e.key !== "Enter" || e.defaultPrevented || el.tagName !== "INPUT" || el.type === "checkbox" || el.type === "radio") return;
		e.preventDefault();
		submit();
	};

	const onRemoved = () => {
		const route = parseRoute(location.pathname);
		const lastSession = useUiStore.getState().lastSession[workspace.id];
		if (lastSession) useUiStore.getState().forgetSession(workspace.id, lastSession);
		onClose();
		if (route.kind === "workspace" && route.workspaceId === workspace.id) navigate(paths.home(), { replace: true });
	};

	return (
		<>
			<Modal
				open={!confirming}
				onClose={onClose}
				size="md"
				title={`工作区设置 · ${workspace.alias}`}
				footerHint={
					<Button variant="danger" icon={<Trash2 size={13} />} onClick={() => setConfirming(true)}>
						移除工作区
					</Button>
				}
				footer={
					<>
						<Button onClick={onClose}>取消</Button>
						<Button variant="primary" loading={mutation.isPending} onClick={submit}>
							保存
						</Button>
					</>
				}
				bodyClassName="flex flex-col gap-3"
			>
				<div className="contents" onKeyDown={onKeyDown}>
					<div className="flex flex-col gap-1.5">
						<span className="text-xs font-medium text-fg-2">路径</span>
						<code className="rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-mono break-all text-fg-code">
							{workspace.path}
						</code>
						<span className="text-xs text-fg-3">
							{server ? `服务器 ${server.config.name}` : "服务器已不存在"} · 路径创建后不可修改
						</span>
					</div>
					<WorkspaceFormFields
						values={values}
						onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
						errors={submitted ? validation.errors : undefined}
						modelSuggestions={suggestions}
						disabled={mutation.isPending}
					/>
					<p className="m-0 text-xs text-fg-3">修改将在下次启动该工作区中的对话时生效，正在运行的对话不受影响。</p>
					{mutation.isError && (
						<Callout tone="danger" title="保存失败">
							{errorMessage(mutation.error)}
						</Callout>
					)}
				</div>
			</Modal>
			{confirming && <ConfirmRemove workspace={workspace} onCancel={() => setConfirming(false)} onRemoved={onRemoved} />}
		</>
	);
}

/**
 * 工作区设置 dialog: alias, project trust, default model / thinking level and env vars
 * (PUT /workspaces/:id), plus 移除工作区 (DELETE, files and sessions stay on the server).
 */
export function WorkspaceSettingsDialog({ workspaceId, open, onClose }: WorkspaceSettingsDialogProps) {
	const { workspace } = useWorkspace(open ? workspaceId : undefined);
	if (!open || !workspace) return null;
	return <SettingsForm key={workspace.config.id} workspace={workspace.config} onClose={onClose} />;
}

export default WorkspaceSettingsDialog;
