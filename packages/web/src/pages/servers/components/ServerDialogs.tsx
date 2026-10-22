/** Modals of the server pages: agent logs, deploy/upgrade options, uninstall, delete, host key re-check. */
import type { DeployProgress, DeployRequest, ServerView, TestConnectionResult, WorkspaceView } from "@pi-web/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, RefreshCw, ShieldAlert, ShieldCheck, Trash2, TriangleAlert, Upload } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router";
import { deleteServer, deployServer, errorMessage, testServer, trustHostKey, uninstallServer } from "../../../api/client";
import { invalidateServers, invalidateSync, invalidateWorkspaces, useMeta, useSettings } from "../../../api/hooks";
import { copyText } from "../../../components/CodeBlock";
import { toast } from "../../../components/ui";
import { Button } from "../../../components/ui/Button";
import { Checkbox, Radio, RadioGroup } from "../../../components/ui/Choice";
import { Callout, EmptyState } from "../../../components/ui/Display";
import { IconButton } from "../../../components/ui/IconButton";
import { Input } from "../../../components/ui/Input";
import { Modal } from "../../../components/ui/Modal";
import { LoadingBlock } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { paths } from "../../../lib/routes";
import { queryClient, queryKeys } from "../../../api/queryClient";
import { useServersStore } from "../../../stores/servers";
import { useUiStore } from "../../../stores/ui";
import { closeWorkspaceTerminals } from "../../workspace/terminal-store";
import { agentAvailable, serverQueryKeys, useAgentLogs } from "../hooks";
import { type AgentLogLine, parseAgentLogLine } from "../lib/agent-log";
import { serverTarget } from "../lib/connection-form";

// ---------- logs ----------

const LEVEL_CLASS: Record<NonNullable<AgentLogLine["level"]>, string> = {
	DEBUG: "text-fg-3",
	INFO: "text-success-fg",
	WARN: "text-warning-fg",
	ERROR: "text-danger",
};

/** Agent log lines with dimmed timestamps and colored levels. */
export function AgentLogLines({ lines, className }: { lines: readonly string[]; className?: string }) {
	return (
		<pre
			tabIndex={0}
			className={cn("m-0 overflow-auto bg-code px-4 py-3 text-xs leading-[1.75] whitespace-pre text-fg-code", className)}
		>
			{lines.map((raw, i) => {
				const line = parseAgentLogLine(raw);
				return (
					<span key={`${i}-${raw.length}`} className="block">
						{line.time && <span className="text-fg-3">{line.time}</span>}
						{line.level && <span className={cn("ml-2 inline-block w-12", LEVEL_CLASS[line.level])}>{line.level}</span>}
						{line.time ? ` ${line.message}` : line.message}
					</span>
				);
			})}
		</pre>
	);
}

export function LogsModal({ view, open, onClose }: { view: ServerView; open: boolean; onClose: () => void }) {
	const [tail, setTail] = useState(500);
	const logs = useAgentLogs(view, tail, { enabled: open });
	const available = agentAvailable(view);
	const remoteRoot = view.config.deployed?.remoteRoot ?? view.config.remoteRoot;
	return (
		<Modal
			open={open}
			onClose={onClose}
			size="xl"
			tall
			title="agent 日志"
			description={<code className="text-xs text-fg-3">{`${remoteRoot}/logs/agent.log`}</code>}
			titleAside={
				<div className="flex items-center gap-1">
					<IconButton
						aria-label="复制日志"
						size="md"
						disabled={!logs.data?.length}
						onClick={async () => {
							if (await copyText((logs.data ?? []).join("\n"))) toast.success("已复制日志");
						}}
					>
						<Copy size={14} strokeWidth={1.8} />
					</IconButton>
					<IconButton aria-label="刷新日志" size="md" disabled={!available || logs.isFetching} onClick={() => void logs.refetch()}>
						<RefreshCw size={14} strokeWidth={1.8} className={logs.isFetching ? "animate-spin" : undefined} />
					</IconButton>
				</div>
			}
			footerHint={logs.data ? `最近 ${logs.data.length} 行` : undefined}
			footer={
				<>
					{logs.data && logs.data.length >= tail && tail < 5000 && (
						<Button size="sm" variant="ghost" onClick={() => setTail((t) => Math.min(5000, t * 4))}>
							加载更早的日志
						</Button>
					)}
					<Button size="sm" onClick={onClose}>
						关闭
					</Button>
				</>
			}
		>
			{!available ? (
				<EmptyState compact title="无法读取日志" description="服务器未连接或尚未部署 pi-web-agent。" />
			) : logs.isLoading ? (
				<LoadingBlock text="正在读取日志…" />
			) : logs.isError ? (
				<div className="p-4">
					<Callout tone="danger" title="读取日志失败">
						{errorMessage(logs.error)}
					</Callout>
				</div>
			) : logs.data?.length ? (
				<AgentLogLines lines={logs.data} className="h-full" />
			) : (
				<EmptyState compact title="日志为空" />
			)}
		</Modal>
	);
}

// ---------- deploy / upgrade ----------

export type DeployDialogMode = "deploy" | "upgrade" | "redeploy";

const DEPLOY_TITLES: Record<DeployDialogMode, string> = {
	deploy: "部署 Pi-Web",
	upgrade: "升级 pi",
	redeploy: "重新部署",
};

export function DeployDialog({
	view,
	open,
	mode,
	onClose,
	onStarted,
}: {
	view: ServerView;
	open: boolean;
	mode: DeployDialogMode;
	onClose: () => void;
	onStarted?: (job: DeployProgress) => void;
}) {
	const client = useQueryClient();
	const meta = useMeta();
	const settings = useSettings();
	const [policy, setPolicy] = useState<"host" | "pinned">("host");
	const [pinned, setPinned] = useState("");
	const [force, setForce] = useState(mode === "redeploy");
	const [sync, setSync] = useState(true);
	const pinnedId = useId();
	useEffect(() => {
		if (!open) return;
		setForce(mode === "redeploy");
		setPolicy(settings.data?.piVersionPolicy === "pinned" ? "pinned" : "host");
		setPinned(settings.data?.piPinnedVersion ?? "");
	}, [open, mode, settings.data]);

	const versionValid = policy === "host" || /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pinned.trim());
	const mutation = useMutation({
		mutationFn: () => {
			const req: DeployRequest = { force, sync };
			if (policy === "pinned") req.piVersion = pinned.trim().replace(/^v/, "");
			return deployServer(view.config.id, req);
		},
		onSuccess: (job) => {
			client.setQueryData(serverQueryKeys.deployJob(view.config.id), job);
			void invalidateServers();
			toast.info(`已开始${DEPLOY_TITLES[mode]}：${view.config.name}`);
			onStarted?.(job);
			onClose();
		},
	});
	const deployed = view.config.deployed;
	const hostPi = meta.data?.hostPiVersion;
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={`${DEPLOY_TITLES[mode]} · ${view.config.name}`}
			icon={<Upload className="text-accent" />}
			description={
				deployed
					? `当前 pi ${deployed.piVersion} · Node ${deployed.nodeVersion} · pi-web-agent ${deployed.agentVersion}`
					: "离线上传 Node 运行时、pi 与 pi-web-agent，并执行一次完整同步。"
			}
			footerHint="部署在后台进行，可关闭此窗口查看进度。"
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="primary" loading={mutation.isPending} disabled={!versionValid} onClick={() => mutation.mutate()}>
						开始{mode === "upgrade" ? "升级" : "部署"}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-4">
				<RadioGroup label="pi 版本" value={policy} onChange={(v) => setPolicy(v as "host" | "pinned")}>
					<Radio
						value="host"
						label={
							<>
								跟随 Host{hostPi ? <code className="text-xs text-fg-code"> · {hostPi}</code> : <span className="text-fg-3">（未检测到 Host 上的 pi）</span>}
							</>
						}
					/>
					<div className="flex flex-wrap items-center gap-2">
						<Radio value="pinned" label="指定版本" />
						<label htmlFor={pinnedId} className="sr-only">
							指定 pi 版本号
						</label>
						<Input
							id={pinnedId}
							mono
							size="sm"
							placeholder="例如 1.4.0"
							className="max-w-32"
							value={pinned}
							disabled={policy !== "pinned"}
							invalid={policy === "pinned" && pinned.trim() !== "" && !versionValid}
							onChange={(e) => setPinned(e.target.value)}
						/>
					</div>
				</RadioGroup>
				<div className="flex flex-col gap-2">
					<Checkbox checked={force} onChange={setForce} label="重新上传全部组件" description="即使服务器上已有相同版本也重新上传（命中 Host 缓存时不会重新下载）" />
					<Checkbox checked={sync} onChange={setSync} label="完成后执行一次完整同步" />
				</div>
				{(view.status.conversationsRunning > 0 || view.status.conversationsWaiting > 0) && (
					<Callout tone="warning" title="有活动对话">
						{`重启 pi-web-agent 会中断 ${view.status.conversationsRunning + view.status.conversationsWaiting} 个活动对话。`}
					</Callout>
				)}
				{mutation.isError && (
					<Callout tone="danger" title="无法开始部署">
						{errorMessage(mutation.error)}
					</Callout>
				)}
			</div>
		</Modal>
	);
}

// ---------- uninstall ----------

export function UninstallModal({
	view,
	open,
	onClose,
	defaultKeepSessions = true,
}: {
	view: ServerView;
	open: boolean;
	onClose: () => void;
	defaultKeepSessions?: boolean;
}) {
	const [keepSessions, setKeepSessions] = useState(defaultKeepSessions);
	const root = view.config.deployed?.remoteRoot ?? view.config.remoteRoot;
	const mutation = useMutation({
		mutationFn: () => uninstallServer(view.config.id, { keepSessions }),
		onSuccess: async () => {
			toast.success(`已从 ${view.config.name} 卸载 Pi-Web`);
			onClose();
			await Promise.all([invalidateServers(), invalidateSync()]);
		},
	});
	const active = view.status.conversationsRunning + view.status.conversationsWaiting;
	return (
		<Modal
			open={open}
			onClose={onClose}
			role="alertdialog"
			size="sm"
			icon={<TriangleAlert className="text-warning" />}
			title={`卸载 ${view.config.name} 上的 Pi-Web？`}
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="warning" loading={mutation.isPending} onClick={() => mutation.mutate()}>
						卸载 Pi-Web
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3 text-sm text-fg-2">
				<p className="m-0">
					{keepSessions ? (
						<>
							停止 daemon 并删除服务器上的 <code className="text-fg-code">{root}</code>；会话文件先移动到 <code className="text-fg-code">~/pi-web-backups/sessions-…</code>（仅本人可读）。
						</>
					) : (
						<>
							停止 daemon 并删除服务器上的 <code className="text-fg-code">{root}</code>，会话文件一并删除，无法恢复。
						</>
					)}
				</p>
				<Checkbox checked={keepSessions} onChange={setKeepSessions} label="保留会话文件" />
				{active > 0 && <Callout tone="warning">{`将中断 ${active} 个活动对话。`}</Callout>}
				{mutation.isError && (
					<Callout tone="danger" title="卸载失败">
						{errorMessage(mutation.error)}
					</Callout>
				)}
			</div>
		</Modal>
	);
}

// ---------- delete ----------

export function DeleteServerModal({ view, open, onClose }: { view: ServerView; open: boolean; onClose: () => void }) {
	const navigate = useNavigate();
	const mutation = useMutation({
		mutationFn: () => deleteServer(view.config.id),
		onSuccess: async () => {
			// The server's workspaces are gone on the host: drop them from the cache, the remembered
			// sessions and the terminal tabs before "/" redirects to the last visited conversation.
			const serverId = view.config.id;
			const removed = (queryClient.getQueryData<WorkspaceView[]>(queryKeys.workspaces) ?? [])
				.filter((w) => w.config.serverId === serverId)
				.map((w) => w.config.id);
			queryClient.setQueryData<WorkspaceView[]>(queryKeys.workspaces, (list) => list?.filter((w) => w.config.serverId !== serverId));
			useUiStore.getState().forgetWorkspaces(removed);
			for (const workspaceId of removed) closeWorkspaceTerminals(workspaceId);
			onClose();
			navigate(paths.home(), { replace: true });
			useServersStore.getState().removeServer(view.config.id);
			toast.success(`已删除服务器 ${view.config.name}`);
			await Promise.all([invalidateServers(), invalidateWorkspaces(), invalidateSync()]);
		},
	});
	return (
		<Modal
			open={open}
			onClose={onClose}
			role="alertdialog"
			size="sm"
			icon={<Trash2 className="text-danger" />}
			title={`删除服务器 ${view.config.name}？`}
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="danger" loading={mutation.isPending} onClick={() => mutation.mutate()}>
						删除服务器
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3 text-sm text-fg-2">
				<p className="m-0">
					从 Pi-Web 中移除 <code className="text-fg-code">{serverTarget(view.config)}</code> 及其工作区和保存的凭据。服务器上的文件不会被删除；如需清理，请先执行“卸载”。
				</p>
				{mutation.isError && (
					<Callout tone="danger" title="无法删除">
						{errorMessage(mutation.error)}
					</Callout>
				)}
			</div>
		</Modal>
	);
}

// ---------- host key re-check ----------

/**
 * Re-checks the server's host key (POST /servers/:id/test) and lets the user trust a new one,
 * e.g. after the server was reinstalled ("重置指纹").
 */
export function HostKeyModal({ view, open, onClose }: { view: ServerView; open: boolean; onClose: () => void }) {
	const [result, setResult] = useState<TestConnectionResult | null>(null);
	const test = useMutation({ mutationFn: () => testServer(view.config.id), onSuccess: setResult });
	const trust = useMutation({
		mutationFn: (key: { algorithm: string; fingerprint: string }) => trustHostKey(view.config.id, key),
		onSuccess: (updated) => {
			useServersStore.getState().upsertServer(updated);
			toast.success("已信任新的主机指纹");
			onClose();
		},
	});
	const { mutate: runTest, reset } = test;
	useEffect(() => {
		if (!open) return;
		setResult(null);
		reset();
		runTest();
	}, [open, runTest, reset]);
	const key = result?.hostKey;
	const same = Boolean(key && view.config.hostKey && key.fingerprint === view.config.hostKey.fingerprint);
	return (
		<Modal
			open={open}
			onClose={onClose}
			title="重置主机指纹"
			icon={<ShieldAlert className="text-warning" />}
			description={`重新连接 ${serverTarget(view.config)} 并读取当前的主机密钥。`}
			footer={
				<>
					<Button onClick={onClose}>{same ? "关闭" : "取消"}</Button>
					{key && !same && (
						<Button variant="primary" loading={trust.isPending} onClick={() => trust.mutate({ algorithm: key.algorithm, fingerprint: key.fingerprint })}>
							信任新指纹
						</Button>
					)}
				</>
			}
		>
			<div className="flex flex-col gap-3">
				{test.isPending && <LoadingBlock text="正在连接…" className="py-6" />}
				{test.isError && (
					<Callout tone="danger" title="连接失败">
						{errorMessage(test.error)}
					</Callout>
				)}
				{result && !key && (
					<Callout tone="danger" title="未能读取主机密钥">
						{result.error ?? "连接在密钥交换前失败。"}
					</Callout>
				)}
				{key && (
					<dl className="m-0 grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-sm">
						<dt className="text-fg-2">已信任</dt>
						<dd className="m-0 min-w-0">
							<code className="text-mono break-all text-fg-2">{view.config.hostKey?.fingerprint ?? "无"}</code>
						</dd>
						<dt className="text-fg-2">当前</dt>
						<dd className="m-0 min-w-0">
							<code
								className={cn(
									"block rounded-md border bg-code px-2.5 py-2 text-mono break-all",
									same ? "border-border text-fg" : "border-warning-border text-fg",
								)}
							>
								{key.fingerprint}
							</code>
						</dd>
						<dt className="text-fg-2">密钥类型</dt>
						<dd className="m-0">
							<code className="text-mono text-fg">{key.algorithm}</code>
						</dd>
					</dl>
				)}
				{key && same && (
					<Callout tone="success" title="指纹未变化">
						服务器的主机密钥与已信任的一致，无需重置。
					</Callout>
				)}
				{key && !same && (
					<Callout tone="warning" title="指纹已变化">
						请先与服务器管理员核对新指纹。信任后旧指纹失效；若服务器并未重装，可能存在中间人攻击。
					</Callout>
				)}
				{trust.isError && (
					<Callout tone="danger" title="保存失败">
						{errorMessage(trust.error)}
					</Callout>
				)}
				{result?.ok && same && (
					<span className="flex items-center gap-1.5 text-xs text-success-fg">
						<ShieldCheck size={14} aria-hidden="true" />
						握手成功{result.latencyMs !== undefined ? `（${Math.round(result.latencyMs)}ms）` : ""}
					</span>
				)}
			</div>
		</Modal>
	);
}
