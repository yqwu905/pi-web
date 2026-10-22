import type { WorkspaceView } from "@pi-web/shared";
import { useMutation } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { connectServer, createWorkspace, errorMessage } from "../../api/client";
import { invalidateWorkspaces, useServerWorkspaces } from "../../api/hooks";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Display";
import { Modal } from "../../components/ui/Modal";
import { toast } from "../../components/ui";
import { paths } from "../../lib/routes";
import { useServer, useServersStore } from "../../stores/servers";
import { useUiStore } from "../../stores/ui";
import { baseName, normalizePath } from "./lib/remote-path";
import { toCreateRequest, validateWorkspaceForm, type WorkspaceFormValues } from "./lib/workspace-form";
import { RemoteDirPicker } from "./RemoteDirPicker";
import { useModelSuggestions, WorkspaceFormFields } from "./WorkspaceFormFields";

export interface NewWorkspaceDialogProps {
	serverId: string;
	open: boolean;
	onClose: () => void;
	/** Called after the workspace was created (before navigating). */
	onCreated?: (workspace: WorkspaceView) => void;
	/** Open the new workspace's chat after creating it (default true). */
	navigateOnCreate?: boolean;
}

function ConnectCallout({ serverId, name }: { serverId: string; name: string }) {
	const [busy, setBusy] = useState(false);
	return (
		<Callout
			tone="warning"
			title="服务器未连接"
			actions={
				<Button
					size="sm"
					variant="warning"
					icon={<Plug size={12} />}
					loading={busy}
					onClick={async () => {
						setBusy(true);
						try {
							useServersStore.getState().upsertServer(await connectServer(serverId));
						} catch (e) {
							toast.error(errorMessage(e), { title: "连接失败" });
						} finally {
							setBusy(false);
						}
					}}
				>
					连接 {name}
				</Button>
			}
		>
			浏览和创建目录需要先连接服务器。
		</Callout>
	);
}

function NewWorkspaceForm({ serverId, onClose, onCreated, navigateOnCreate = true }: Omit<NewWorkspaceDialogProps, "open">) {
	const server = useServer(serverId);
	const connected = server?.status.connection === "connected";
	const workspaces = useServerWorkspaces(serverId);
	const existing = useMemo(() => new Set((workspaces.data ?? []).map((w) => normalizePath(w.config.path))), [workspaces.data]);
	const navigate = useNavigate();
	const pathLabelId = useId();

	const [dir, setDir] = useState("~");
	const [resolvedDir, setResolvedDir] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [aliasEdited, setAliasEdited] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const [values, setValues] = useState<WorkspaceFormValues>(() => ({
		alias: "",
		trust: server?.config.defaultTrust ?? "approve",
		model: "",
		thinking: "",
		env: [],
	}));
	const suggestions = useModelSuggestions(serverId, connected);

	const target = selected ?? resolvedDir;
	const alreadyWorkspace = target ? existing.has(normalizePath(target)) : false;
	const alias = aliasEdited ? values.alias : target ? baseName(target) : "";
	const formValues = { ...values, alias };
	const validation = validateWorkspaceForm(formValues);

	const mutation = useMutation({
		mutationFn: () => createWorkspace(serverId, toCreateRequest(target as string, formValues)),
		onSuccess: async (view) => {
			await invalidateWorkspaces(serverId);
			useUiStore.getState().setServerExpanded(serverId, true);
			toast.success(`已添加工作区 ${view.config.alias}`);
			onCreated?.(view);
			onClose();
			if (navigateOnCreate) navigate(paths.chat(view.config.id));
		},
	});

	const submit = () => {
		setSubmitted(true);
		if (!target || alreadyWorkspace || !validation.valid || !connected || mutation.isPending) return;
		mutation.mutate();
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const el = e.target as HTMLElement;
		if (e.key !== "Enter" || e.defaultPrevented || el.tagName !== "INPUT" || (el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio") return;
		e.preventDefault();
		submit();
	};
	const pickerRef = useRef<HTMLDivElement>(null);

	return (
		<Modal
			open
			onClose={onClose}
			size="md"
			title={`新建工作区 · ${server?.config.name ?? serverId}`}
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="primary" loading={mutation.isPending} disabled={!connected || !target || alreadyWorkspace} onClick={submit}>
						创建
					</Button>
				</>
			}
			bodyClassName="flex flex-col gap-3"
			initialFocus={pickerRef}
		>
			<div className="contents" onKeyDown={onKeyDown}>
				{!connected && server && <ConnectCallout serverId={serverId} name={server.config.name} />}
				<div ref={pickerRef} tabIndex={-1} className="flex flex-col gap-1.5 outline-none">
					<div className="flex items-baseline justify-between gap-3">
						<span id={pathLabelId} className="text-xs font-medium text-fg-2">
							路径
						</span>
						<code className="min-w-0 truncate text-[11.5px] text-fg-2" title={target ?? undefined}>
							{target ?? ""}
						</code>
					</div>
					<RemoteDirPicker
						serverId={serverId}
						dir={dir}
						onDirChange={(d) => {
							setDir(d);
							setResolvedDir(null);
						}}
						selected={selected}
						onSelect={setSelected}
						onResolved={setResolvedDir}
						existing={existing}
						disabled={!connected}
						labelledBy={pathLabelId}
					/>
					{alreadyWorkspace ? (
						<span className="text-xs text-danger">该目录已是工作区</span>
					) : (
						<span className="text-xs text-fg-3">{selected ? "将使用选中的文件夹" : "未选择子文件夹时，使用当前目录"}</span>
					)}
				</div>
				<WorkspaceFormFields
					values={formValues}
					onChange={(patch) => setValues((v) => ({ ...v, ...patch, alias: patch.alias ?? alias }))}
					onAliasEdited={() => setAliasEdited(true)}
					errors={submitted ? validation.errors : undefined}
					modelSuggestions={suggestions}
					disabled={mutation.isPending}
				/>
				{mutation.isError && (
					<Callout tone="danger" title="创建失败">
						{errorMessage(mutation.error)}
					</Callout>
				)}
			</div>
		</Modal>
	);
}

/**
 * 新建工作区 dialog for one server: pick (or create) a remote directory, then alias, project
 * trust, default model / thinking level and env vars → POST /servers/:id/workspaces.
 * Reusable from the sidebar and the server page.
 */
export function NewWorkspaceDialog({ open, ...props }: NewWorkspaceDialogProps) {
	// Mount the form only while open so every opening starts fresh.
	return open ? <NewWorkspaceForm {...props} /> : null;
}

export default NewWorkspaceDialog;
