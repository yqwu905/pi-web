/** 服务器概览: 运行环境, 运行状态 and 配置同步 cards. */
import type { AgentStatus, ConvInfo, ServerView } from "@pi-web/shared";
import { useMutation } from "@tanstack/react-query";
import { Activity, ArrowRight, Cpu, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { errorMessage, runSync } from "../../../api/client";
import { invalidateSync, useMeta, useSyncStatus } from "../../../api/hooks";
import { toast } from "../../../components/ui";
import { Button } from "../../../components/ui/Button";
import { Badge, Card, EmptyState, KeyValue, type KeyValueItem } from "../../../components/ui/Display";
import { cn } from "../../../lib/cn";
import { formatBytes, formatDateTime, formatDurationZh, formatRelativeTime, tildify } from "../../../lib/format";
import { paths } from "../../../lib/routes";
import { useConversations } from "../../../stores/convs";
import { lastRecordFor, TRIGGER_LABELS, recordChangeText } from "../../sync/lib/plan";
import { oauthProgress, remainingText } from "../../sync/lib/oauth";
import { useNow, useOAuthStatus, useSyncHistory } from "../hooks";

// ---------- 运行环境 ----------

export function RuntimeCard({ view, agentStatus }: { view: ServerView; agentStatus: AgentStatus | undefined }) {
	const meta = useMeta();
	const d = view.config.deployed;
	const agent = view.status.agent;
	if (!d) {
		return (
			<Card title="运行环境" icon={<Cpu />}>
				<EmptyState compact title="尚未部署" description="部署后显示 Node、pi 与 pi-web-agent 的版本。" />
			</Card>
		);
	}
	const hostPi = meta.data?.hostPiVersion;
	const uptimeSec = agentStatus?.uptimeSec ?? agent?.uptimeSec;
	const items: KeyValueItem[] = [
		{ key: "os", label: "系统", value: `Linux ${d.arch}${d.glibc ? ` · glibc ${d.glibc}` : ""}`, mono: true },
		{ key: "node", label: "Node", value: d.nodeVersion, mono: true },
		{
			key: "pi",
			label: "pi",
			value: d.piVersion,
			mono: true,
			hint: hostPi ? (
				hostPi === d.piVersion ? (
					<span className="text-success-fg">与 Host 一致</span>
				) : (
					<span className="text-warning-fg">Host 为 {hostPi}</span>
				)
			) : undefined,
		},
		{
			key: "agent",
			label: "pi-web-agent",
			value: agent?.version ?? d.agentVersion,
			mono: true,
			hint:
				view.status.deployState === "outdated" ? (
					<span className="text-warning-fg">需要升级</span>
				) : uptimeSec !== undefined ? (
					`运行 ${formatDurationZh(uptimeSec * 1000)}`
				) : view.status.connection !== "connected" ? (
					"未连接"
				) : undefined,
		},
		{ key: "root", label: "安装目录", value: tildify(d.remoteRoot, d.home), mono: true },
		{
			key: "agentDir",
			label: "Agent 目录",
			value: tildify(d.agentDir, d.home),
			mono: true,
			hint: view.config.agentDirMode === "shared" ? "共用" : "独立",
		},
		{
			key: "disk",
			label: "磁盘可用",
			value: agentStatus?.diskFreeBytes !== undefined ? formatBytes(agentStatus.diskFreeBytes) : "-",
			mono: true,
			hint: agentStatus?.loadavg?.length ? `负载 ${agentStatus.loadavg.map((n) => n.toFixed(2)).join(" ")}` : undefined,
		},
		{ key: "at", label: "部署时间", value: formatDateTime(d.at), hint: formatRelativeTime(d.at) },
	];
	return (
		<Card title="运行环境" icon={<Cpu />} bodyClassName="px-4 pt-1 pb-2" padded={false}>
			<KeyValue items={items} />
		</Card>
	);
}

// ---------- 运行状态 ----------

function StatTile({ value, label, warn }: { value: number | string; label: string; warn?: boolean }) {
	return (
		<div className={cn("flex flex-col gap-1 rounded-md border p-2.5", warn ? "border-warning-border bg-warning-soft" : "border-border bg-bg")}>
			<span className={cn("font-mono text-2xl font-semibold", warn ? "text-warning-fg" : "text-fg")}>{value}</span>
			<span className={cn("text-xs leading-[1.4]", warn ? "text-warning-fg" : "text-fg-2")}>{label}</span>
		</div>
	);
}

function convTitle(c: ConvInfo): string {
	if (c.sessionName) return c.sessionName;
	const base = c.cwd.split("/").filter(Boolean).pop() ?? c.cwd;
	return `${base} · ${c.sessionId ? c.sessionId.slice(0, 8) : "新对话"}`;
}

function ConvStatusText({ c, now }: { c: ConvInfo; now: number }) {
	if (c.status === "running") return <span className="text-xs text-link">运行中</span>;
	if (c.status === "starting") return <span className="text-xs text-link">启动中</span>;
	if (c.status === "waiting_ui") return <span className="text-xs text-warning-fg">等待确认</span>;
	if (c.status === "exited") return <span className="text-xs text-fg-3">已退出</span>;
	return <span className="text-xs text-fg-3">空闲 {formatDurationZh(Math.max(0, now - c.lastActivityAt))}</span>;
}

export function AgentStatusCard({ view, agentStatus, loading, error }: { view: ServerView; agentStatus: AgentStatus | undefined; loading: boolean; error: unknown }) {
	const now = useNow(30_000);
	const convViews = useConversations();
	const live = (agentStatus?.conversations ?? []).filter((c) => c.status !== "exited");
	const running = agentStatus ? live.filter((c) => c.status === "running" || c.status === "starting").length : view.status.conversationsRunning;
	const pending = agentStatus ? live.reduce((n, c) => n + c.pendingUi.length, 0) : view.status.conversationsWaiting;
	const processes = agentStatus ? live.filter((c) => c.pid !== undefined).length : "-";
	const idle = view.config.idleTimeoutMin;
	const wsOf = (convId: string) => convViews.find((v) => v.convId === convId)?.workspaceId ?? null;
	return (
		<Card title="运行状态" icon={<Activity />} bodyClassName="flex flex-col gap-3.5">
			<div className="grid grid-cols-3 gap-2">
				<StatTile value={running} label="运行中对话" />
				<StatTile value={processes} label="pi 进程" />
				<StatTile value={pending} label="待处理的扩展对话框" warn={pending > 0} />
			</div>
			<div className="flex flex-col gap-1">
				<h3 className="m-0 section-label">活动进程</h3>
				{view.status.connection !== "connected" ? (
					<span className="py-2 text-xs text-fg-3">服务器未连接</span>
				) : loading ? (
					<span className="py-2 text-xs text-fg-3">读取中…</span>
				) : error ? (
					<span className="py-2 text-xs text-danger">{errorMessage(error)}</span>
				) : live.length === 0 ? (
					<span className="py-2 text-xs text-fg-3">没有运行中的 pi 进程</span>
				) : (
					<ul className="m-0 flex list-none flex-col p-0">
						{live.map((c, i) => {
							const wsId = wsOf(c.convId);
							return (
								<li key={c.convId} className={cn("flex h-[30px] items-center gap-2.5 text-sm", i < live.length - 1 && "border-b border-border")}>
									<code className="w-11 shrink-0 text-xs text-fg-3">{c.pid ?? "-"}</code>
									{wsId && c.sessionId ? (
										<Link to={paths.chat(wsId, c.sessionId)} className="min-w-0 flex-1 truncate text-fg hover:text-link">
											{convTitle(c)}
										</Link>
									) : (
										<span className="min-w-0 flex-1 truncate text-fg-2" title={c.cwd}>
											{convTitle(c)}
										</span>
									)}
									<ConvStatusText c={c} now={now} />
								</li>
							);
						})}
					</ul>
				)}
			</div>
			<div className="flex-1" />
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
				<span>{idle > 0 ? `空闲回收：${idle} 分钟未活动的会话自动退出` : "空闲回收：已关闭"}</span>
				<Link to={`${paths.serverSettings(view.config.id)}#sec-session`} className="text-xs">
					修改
				</Link>
			</div>
		</Card>
	);
}

// ---------- 配置同步 ----------

export function SyncCard({ view }: { view: ServerView }) {
	const id = view.config.id;
	const status = useSyncStatus();
	const history = useSyncHistory(50);
	const oauth = useOAuthStatus();
	const now = useNow(60_000);
	const s = status.data?.servers.find((x) => x.serverId === id);
	const last = lastRecordFor(history.data, id);
	const online = view.status.connection === "connected";
	const sync = useMutation({
		mutationFn: () => runSync({ serverIds: [id] }),
		onSuccess: (res) => {
			const rec = res.records[0];
			if (rec?.status === "error") toast.error(rec.error ?? "同步失败", { title: `同步 ${view.config.name} 失败` });
			else toast.success(rec ? `已同步 ${view.config.name}：${recordChangeText(rec)}` : `已同步 ${view.config.name}`);
			void invalidateSync();
		},
		onError: (e) => toast.error(errorMessage(e), { title: "同步失败" }),
	});
	const auto = s?.auto ?? view.config.sync.auto;
	const pendingCount = s?.pendingCount ?? view.status.pendingSync;
	const lastAt = s?.lastSyncAt ?? last?.at ?? view.status.lastSyncAt;
	const providers = (oauth.data?.providers ?? []).filter((p) => p.pushed.some((x) => x.serverId === id) || (view.config.sync.items.auth && view.config.deployed));
	const items: KeyValueItem[] = [
		{
			key: "auto",
			label: "自动同步",
			value: (
				<span className="flex flex-wrap items-center gap-2">
					<Badge shape="pill" tone={auto ? "success" : "neutral"} dot className="h-5">
						{auto ? "已开启" : "已关闭"}
					</Badge>
					{status.data?.hostAgentDir && (
						<span className="text-xs text-fg-3">
							监听 <code className="text-[11.5px] text-fg-2">{status.data.hostAgentDir}</code>
						</span>
					)}
				</span>
			),
		},
		{
			key: "last",
			label: "上次同步",
			value: lastAt ? (
				<span>
					{formatRelativeTime(lastAt, now)}
					{last && last.at === lastAt ? ` · ${TRIGGER_LABELS[last.trigger].replace(/（.*）/, "")} · ${last.status === "error" ? "失败" : recordChangeText(last)}` : ""}
				</span>
			) : (
				<span className="text-fg-3">从未同步</span>
			),
		},
		{
			key: "pending",
			label: "待同步",
			value: <code className="text-mono">{pendingCount}</code>,
			hint: s?.running ? "同步中…" : pendingCount === 0 ? (s ? "与 Host 一致" : undefined) : online ? "可立即同步" : "离线，连接后自动补同步",
		},
		{
			key: "oauth",
			label: "OAuth",
			value:
				providers.length === 0 ? (
					<span className="text-fg-3">
						{!view.config.sync.items.auth ? "未同步凭据" : !view.config.deployed ? "部署后推送 access token" : "无 OAuth 凭据"}
					</span>
				) : (
					<span className="flex flex-col gap-1.5">
						{providers.map((p) => {
							const pushed = p.pushed.find((x) => x.serverId === id);
							const prog = oauthProgress(p, [], now);
							return (
								<span key={p.provider} className="flex flex-col gap-0.5">
									<span className="text-sm text-fg">
										<code className="text-mono">{p.provider}</code> ·{" "}
										{pushed?.ok ? "access token 已推送" : pushed ? <span className="text-warning-fg">推送失败</span> : <span className="text-fg-3">尚未推送</span>}
									</span>
									<span className={cn("text-xs", prog.tone === "accent" ? "text-fg-2" : prog.tone === "warning" ? "text-warning-fg" : "text-danger")}>
										{remainingText(prog)} · 由 Host 到期前刷新
									</span>
								</span>
							);
						})}
					</span>
				),
		},
	];
	return (
		<Card
			title="配置同步"
			icon={<RefreshCw />}
			padded={false}
			bodyClassName="px-4 pt-1 pb-2"
			footer={
				<div className="flex w-full flex-wrap items-center justify-between gap-2">
					<Link to={paths.sync()} className="flex items-center gap-1.5 text-sm">
						打开同步中心
						<ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
					</Link>
					<Button
						size="sm"
						icon={<RefreshCw size={13} strokeWidth={1.8} />}
						loading={sync.isPending || Boolean(s?.running)}
						disabled={!online || view.config.jumpOnly}
						title={online ? undefined : "服务器离线"}
						onClick={() => sync.mutate()}
					>
						立即同步
					</Button>
				</div>
			}
		>
			<KeyValue items={items} labelWidth={72} />
		</Card>
	);
}
