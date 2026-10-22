import type { ServerView } from "@pi-web/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	ArrowUpCircle,
	CircleAlert,
	Ellipsis,
	Fingerprint,
	Plug,
	PlugZap,
	Rocket,
	RotateCw,
	ScrollText,
	Server,
	Settings2,
	Trash2,
	TriangleAlert,
	Unplug,
	Wand2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { connectServer, disconnectServer, errorMessage, restartAgent, testServer } from "../../api/client";
import { useServerWorkspaces } from "../../api/hooks";
import { queryKeys } from "../../api/queryClient";
import { toast } from "../../components/ui";
import { Button, ButtonLink } from "../../components/ui/Button";
import { Badge, Callout, EmptyState } from "../../components/ui/Display";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { LoadingBlock } from "../../components/ui/Spinner";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { paths } from "../../lib/routes";
import { serverStatusDisplay } from "../../lib/status";
import { useConversations } from "../../stores/convs";
import { useServers, useServersStore } from "../../stores/servers";
import { DeployProgressPanel } from "./components/DeployProgressPanel";
import { DeleteServerModal, DeployDialog, type DeployDialogMode, HostKeyModal, LogsModal, UninstallModal } from "./components/ServerDialogs";
import { LogsCard, ProxyCard } from "./detail/ProxyLogsCards";
import { AgentStatusCard, RuntimeCard, SyncCard } from "./detail/StatusCards";
import { WorkspacesCard } from "./detail/WorkspacesCard";
import { agentAvailable, useAgentStatus, useDeployJob, useServerView } from "./hooks";
import { jumpChainLabel, serverTarget } from "./lib/connection-form";

type Tab = "overview" | "workspaces" | "proxy" | "sync" | "logs";
type Dialog = { kind: "deploy"; mode: DeployDialogMode } | { kind: "logs" } | { kind: "uninstall" } | { kind: "delete" } | { kind: "hostkey" } | null;

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-4";

function ConnectButton({ view }: { view: ServerView }) {
	const connected = view.status.connection === "connected" || view.status.connection === "connecting";
	const mutation = useMutation({
		mutationFn: () => (connected ? disconnectServer(view.config.id) : connectServer(view.config.id)),
		onSuccess: (v) => useServersStore.getState().upsertServer(v),
		onError: (e) => toast.error(errorMessage(e), { title: connected ? "断开失败" : "连接失败" }),
	});
	return (
		<Button
			icon={connected ? <Unplug size={14} strokeWidth={1.8} className="text-fg-2" /> : <Plug size={14} strokeWidth={1.8} className="text-fg-2" />}
			loading={mutation.isPending || view.status.connection === "connecting"}
			onClick={() => mutation.mutate()}
		>
			{connected ? "断开连接" : "连接"}
		</Button>
	);
}

function DeployCallToAction({ view, onDeploy }: { view: ServerView; onDeploy: (mode: DeployDialogMode) => void }) {
	const s = view.status;
	if (view.config.jumpOnly) {
		return <Callout tone="info" title="仅作为跳板机">此服务器只用于转发到其他服务器的 SSH 连接，不部署 pi。</Callout>;
	}
	if (s.deployState === "deploying") return null;
	const notDeployed = s.deployState === "not_deployed" || (!view.config.deployed && s.deployState !== "deployed" && s.deployState !== "outdated");
	if (notDeployed) {
		return (
			<section aria-labelledby="sd-cta" className="flex flex-wrap items-center gap-4 rounded-xl border border-user-border bg-user px-5 py-4">
				<Rocket size={22} strokeWidth={1.7} className="shrink-0 text-accent" aria-hidden="true" />
				<div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
					<h2 id="sd-cta" className="m-0 text-md font-semibold text-fg">
						尚未部署 Pi-Web
					</h2>
					<p className="m-0 text-sm text-fg-2">离线上传 Node 运行时、pi 与 pi-web-agent，部署后即可在此服务器上创建工作区和对话。</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<ButtonLink to={paths.addServer(view.config.id)} icon={<Wand2 size={14} strokeWidth={1.8} />}>
						使用添加向导
					</ButtonLink>
					<Button variant="primary" icon={<Rocket size={14} strokeWidth={1.8} />} onClick={() => onDeploy("deploy")}>
						立即部署
					</Button>
				</div>
			</section>
		);
	}
	if (s.deployState === "outdated") {
		return (
			<section aria-labelledby="sd-cta" className="flex flex-wrap items-center gap-4 rounded-xl border border-warning-border bg-warning-soft px-5 py-4">
				<TriangleAlert size={22} strokeWidth={1.7} className="shrink-0 text-warning" aria-hidden="true" />
				<div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
					<h2 id="sd-cta" className="m-0 text-md font-semibold text-warning-fg">
						pi-web-agent 需要升级
					</h2>
					<p className="m-0 text-sm text-warning-body">
						服务器上的 agent{s.agent ? ` ${s.agent.version}` : ""} 与当前 Pi-Web 不一致，仍可使用，但建议升级以获得完整功能。
					</p>
				</div>
				<Button variant="warning" icon={<ArrowUpCircle size={14} strokeWidth={1.8} />} onClick={() => onDeploy("upgrade")}>
					升级
				</Button>
			</section>
		);
	}
	return null;
}

/** Route: /servers/:serverId — 服务器概览. */
export default function ServerDetailPage() {
	const { serverId = "" } = useParams();
	const { view, loading, notFound } = useServerView(serverId);
	if (loading) return <LoadingBlock className="flex-1" text="正在读取服务器…" />;
	if (!view || notFound)
		return (
			<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
				<EmptyState
					icon={<Server />}
					title="服务器不存在"
					description="该服务器可能已被删除。"
					actions={
						<ButtonLink to={paths.addServer()} variant="primary">
							添加服务器
						</ButtonLink>
					}
				/>
			</div>
		);
	return <ServerDetail key={view.config.id} view={view} />;
}

function ServerDetail({ view }: { view: ServerView }) {
	const c = view.config;
	const client = useQueryClient();
	const servers = useServers({ includeJumpOnly: true });
	const [tab, setTab] = useState<Tab>("overview");
	const [dialog, setDialog] = useState<Dialog>(null);
	const [dismissedJob, setDismissedJob] = useState<string | null>(null);
	const job = useDeployJob(c.id).data;
	const agentStatus = useAgentStatus(view);
	const workspaces = useServerWorkspaces(c.id);
	const status = serverStatusDisplay(view);

	// Keep the process list in step with conversation events of this server.
	const convs = useConversations();
	const convSignature = useMemo(
		() =>
			convs
				.filter((v) => v.serverId === c.id)
				.map((v) => `${v.convId}:${v.info.status}:${v.info.pendingUi.length}`)
				.sort()
				.join("|"),
		[convs, c.id],
	);
	useEffect(() => {
		void client.invalidateQueries({ queryKey: queryKeys.agentStatus(c.id) });
	}, [convSignature, client, c.id]);

	const restart = useMutation({
		mutationFn: () => restartAgent(c.id),
		onSuccess: () => {
			toast.success("pi-web-agent 已重启");
			void client.invalidateQueries({ queryKey: queryKeys.agentStatus(c.id) });
		},
		onError: (e) => toast.error(errorMessage(e), { title: "重启 agent 失败" }),
	});
	const test = useMutation({
		mutationFn: () => testServer(c.id),
		onSuccess: (r) => {
			if (r.ok) toast.success(`连接正常${r.latencyMs !== undefined ? ` · ${Math.round(r.latencyMs)}ms` : ""}`, { title: c.name });
			else toast.error(r.error ?? "连接失败", { title: c.name });
		},
		onError: (e) => toast.error(errorMessage(e), { title: "测试连接失败" }),
	});

	const deployed = Boolean(c.deployed) || view.status.deployState === "deployed" || view.status.deployState === "outdated";
	const showJob = job && (job.state === "running" || job.jobId !== dismissedJob) && (job.state === "running" || (job.finishedAt ?? 0) > Date.now() - 30 * 60_000);
	const jumpLabel = jumpChainLabel(c.jumpServerIds, servers);
	const subtitle = [serverTarget(c), jumpLabel && `经 ${jumpLabel}`, c.group && `分组 ${c.group}`].filter(Boolean).join(" · ");
	const upgradeLabel = deployed ? "升级 pi" : "部署";

	const overview = (
		<div className={GRID}>
			<RuntimeCard view={view} agentStatus={agentStatus.data} />
			<AgentStatusCard view={view} agentStatus={agentStatus.data} loading={agentStatus.isLoading && agentAvailable(view)} error={agentStatus.error} />
			<SyncCard view={view} />
			<WorkspacesCard view={view} className="col-span-full" />
			<ProxyCard view={view} className="col-span-full" />
			<LogsCard view={view} className="col-span-full" />
		</div>
	);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto py-6">
			<div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 sm:px-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="flex min-w-0 flex-col gap-1.5">
						<div className="flex flex-wrap items-center gap-2.5">
							<Server size={20} strokeWidth={1.7} className="text-accent" aria-hidden="true" />
							<h1 className="m-0 text-xl font-semibold">{c.name}</h1>
							<Badge shape="pill" dot tone={status.tone} title={view.status.error}>
								{status.text}
							</Badge>
						</div>
						<code className="text-mono break-all text-fg-2">{subtitle}</code>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<ConnectButton view={view} />
						{!c.jumpOnly && (
							<>
								<Button
									icon={<RotateCw size={14} strokeWidth={1.8} className="text-fg-2" />}
									loading={restart.isPending}
									disabled={!agentAvailable(view)}
									onClick={() => restart.mutate()}
								>
									重启 agent
								</Button>
								<Button
									icon={<ArrowUpCircle size={14} strokeWidth={1.8} className="text-fg-2" />}
									disabled={job?.state === "running"}
									onClick={() => setDialog({ kind: "deploy", mode: deployed ? "upgrade" : "deploy" })}
								>
									{upgradeLabel}
								</Button>
								<Button icon={<ScrollText size={14} strokeWidth={1.8} className="text-fg-2" />} onClick={() => setDialog({ kind: "logs" })}>
									查看日志
								</Button>
							</>
						)}
						<ButtonLink to={paths.serverSettings(c.id)} icon={<Settings2 size={14} strokeWidth={1.8} className="text-fg-2" />}>
							设置
						</ButtonLink>
						<Menu
							aria-label="更多操作"
							trigger={(p) => (
								<IconButton {...p} aria-label="更多操作" variant="secondary">
									<Ellipsis size={16} strokeWidth={2} />
								</IconButton>
							)}
							items={[
								{ label: "测试连接", icon: <PlugZap />, onSelect: () => test.mutate(), disabled: test.isPending },
								{ label: "重置主机指纹…", icon: <Fingerprint />, onSelect: () => setDialog({ kind: "hostkey" }) },
								...(c.jumpOnly
									? []
									: [{ label: "重新部署…", icon: <Rocket />, onSelect: () => setDialog({ kind: "deploy", mode: "redeploy" }), disabled: job?.state === "running" }]),
								{ type: "separator" as const },
								...(c.jumpOnly
									? []
									: [{ label: "卸载 Pi-Web…", icon: <TriangleAlert />, onSelect: () => setDialog({ kind: "uninstall" }), disabled: !deployed }]),
								{ label: "删除服务器…", icon: <Trash2 />, danger: true, onSelect: () => setDialog({ kind: "delete" }) },
							]}
						/>
					</div>
				</div>

				{view.status.connection === "error" && view.status.error && (
					<Callout tone="danger" title="连接失败" actions={<ConnectButton view={{ ...view, status: { ...view.status, connection: "disconnected" } }} />}>
						<span className="break-words">{view.status.error}</span>
					</Callout>
				)}

				<DeployCallToAction view={view} onDeploy={(mode) => setDialog({ kind: "deploy", mode })} />

				{showJob && (
					<div className="relative">
						<DeployProgressPanel job={job} title={job.state === "running" ? "正在部署" : "最近一次部署"} />
						{job.state !== "running" && (
							<IconButton aria-label="关闭部署进度" size="md" className="absolute top-3 right-3" onClick={() => setDismissedJob(job.jobId)}>
								<X size={14} strokeWidth={2} />
							</IconButton>
						)}
						{job.state === "running" && (
							<p className="mt-2 mb-0 flex items-center gap-1.5 text-xs text-fg-3">
								<CircleAlert size={12} aria-hidden="true" />
								部署在 Host 后台进行，关闭页面不会中断。
							</p>
						)}
					</div>
				)}

				<div className="flex flex-col gap-4">
					<Tabs<Tab>
						aria-label="服务器视图"
						idPrefix="server-tabs"
						value={tab}
						onChange={setTab}
						items={[
							{ value: "overview", label: "概览" },
							{
								value: "workspaces",
								label: "工作区",
								badge: workspaces.data ? (
									<span className="rounded-full bg-chip px-1.5 py-px text-2xs font-normal text-fg-2">{workspaces.data.length}</span>
								) : undefined,
							},
							{ value: "proxy", label: "代理" },
							{ value: "sync", label: "同步" },
							{ value: "logs", label: "日志" },
						]}
					/>
					<TabPanel idPrefix="server-tabs" value="overview" active={tab === "overview"}>
						{overview}
					</TabPanel>
					<TabPanel idPrefix="server-tabs" value="workspaces" active={tab === "workspaces"}>
						<WorkspacesCard view={view} />
					</TabPanel>
					<TabPanel idPrefix="server-tabs" value="proxy" active={tab === "proxy"}>
						<ProxyCard view={view} />
					</TabPanel>
					<TabPanel idPrefix="server-tabs" value="sync" active={tab === "sync"} className={GRID}>
						<SyncCard view={view} />
					</TabPanel>
					<TabPanel idPrefix="server-tabs" value="logs" active={tab === "logs"}>
						<LogsCard view={view} tall />
					</TabPanel>
				</div>
			</div>

			{dialog?.kind === "deploy" && <DeployDialog view={view} open mode={dialog.mode} onClose={() => setDialog(null)} />}
			{dialog?.kind === "logs" && <LogsModal view={view} open onClose={() => setDialog(null)} />}
			{dialog?.kind === "uninstall" && <UninstallModal view={view} open onClose={() => setDialog(null)} />}
			{dialog?.kind === "delete" && <DeleteServerModal view={view} open onClose={() => setDialog(null)} />}
			{dialog?.kind === "hostkey" && <HostKeyModal view={view} open onClose={() => setDialog(null)} />}
		</div>
	);
}
