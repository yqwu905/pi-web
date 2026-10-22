/** 服务器概览: 隧道代理 and 最近日志 cards. */
import { matchDomain, type ServerView } from "@pi-web/shared";
import { useMutation } from "@tanstack/react-query";
import { ScrollText, Shield } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { allowProxyDomain, errorMessage } from "../../../api/client";
import { toast } from "../../../components/ui";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Display";
import { LoadingBlock } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { formatBytes, formatNumber, formatRelativeTime, formatTime } from "../../../lib/format";
import { paths } from "../../../lib/routes";
import { useServersStore } from "../../../stores/servers";
import { AgentLogLines, LogsModal } from "../components/ServerDialogs";
import { agentAvailable, useAgentLogs, useProxyStats } from "../hooks";

const TH = "border-b border-border px-3 py-2 section-label";

function AllowButton({ view, host }: { view: ServerView; host: string }) {
	const mutation = useMutation({
		mutationFn: () => allowProxyDomain(view.config.id, host),
		onSuccess: (updated) => {
			useServersStore.getState().upsertServer(updated);
			toast.success(`已将 ${host} 加入白名单`);
		},
		onError: (e) => toast.error(errorMessage(e), { title: "加入白名单失败" }),
	});
	return (
		<Button size="sm" loading={mutation.isPending} onClick={() => mutation.mutate()} aria-label={`将 ${host} 加入白名单`}>
			加入白名单
		</Button>
	);
}

export function ProxyCard({ view, className }: { view: ServerView; className?: string }) {
	const p = view.config.proxy;
	const stats = useProxyStats(view);
	const data = stats.data ?? view.status.proxy;
	const off = p.mode === "off";
	const scopeText = p.scope === "llm" ? "仅 LLM" : p.toolsPolicy === "all" ? "工具也走代理 · 全部放行" : "工具也走代理";
	const byHost = [...(data?.byHost ?? [])].sort((a, b) => b.bytesUp + b.bytesDown - (a.bytesUp + a.bytesDown));
	const denied = [...(data?.denied ?? [])].sort((a, b) => b.lastAt - a.lastAt);
	const deniedTotal = denied.reduce((n, d) => n + d.count, 0);
	const totalReq = byHost.reduce((n, h) => n + h.requests, 0);
	const totalBytes = byHost.reduce((n, h) => n + h.bytesUp + h.bytesDown, 0);
	const active = data?.active ?? 0;
	return (
		<Card
			className={className}
			title="隧道代理"
			icon={<Shield />}
			padded={false}
			description={
				off ? (
					"已关闭 · 服务器直连"
				) : (
					<>
						隧道 · {scopeText} · 入口 <code className="text-xs text-fg-code">127.0.0.1:{p.port}</code>
					</>
				)
			}
			actions={
				!off && (
					<span className="flex items-center gap-1.5 text-xs text-fg-2">
						<span aria-hidden="true" className={cn("size-[7px] rounded-full", active > 0 ? "animate-pulse-dot bg-success" : "border-[1.5px] border-fg-4")} />
						活动连接
						<code className="text-sm font-semibold text-fg">{active}</code>
					</span>
				)
			}
			footer={
				<div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-3">
					<span>{off ? "代理关闭时 pi 进程不设置 HTTPS_PROXY。" : "白名单在 Host 端强制执行。"}</span>
					<span className="flex-1" />
					<Link to={`${paths.serverSettings(view.config.id)}#sec-proxy`} className="text-xs">
						代理与白名单设置
					</Link>
				</div>
			}
		>
			{off ? (
				<p className="m-0 p-4 text-sm text-fg-2">LLM 代理已关闭，服务器上的 pi 直接访问各 provider。服务器无法上网时请在设置中开启隧道。</p>
			) : stats.isLoading && !data ? (
				<LoadingBlock />
			) : (
				<div className="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-x-6 gap-y-4 p-4">
					<div className="flex min-w-0 flex-col gap-2">
						<h3 className="m-0 section-label">流量 · 按域名</h3>
						<div className="overflow-x-auto rounded-md border border-border bg-bg">
							{byHost.length === 0 ? (
								<p className="m-0 px-3 py-4 text-xs text-fg-3">暂无经过代理的请求{stats.isError ? `（${errorMessage(stats.error)}）` : ""}</p>
							) : (
								<table className="w-full border-collapse text-sm">
									<thead>
										<tr>
											<th scope="col" className={cn(TH, "text-left")}>
												域名
											</th>
											<th scope="col" className={cn(TH, "text-right")}>
												请求
											</th>
											<th scope="col" className={cn(TH, "text-right")}>
												流量
											</th>
										</tr>
									</thead>
									<tbody>
										{byHost.map((h) => (
											<tr key={h.host} title={`最近 ${formatTime(h.lastAt, true)} · ↑ ${formatBytes(h.bytesUp)} ↓ ${formatBytes(h.bytesDown)}`}>
												<td className="border-b border-border px-3 py-2">
													<code className="text-mono break-all text-fg">{h.host}</code>
												</td>
												<td className="border-b border-border px-3 py-2 text-right">
													<code className="text-mono text-fg-code">{formatNumber(h.requests)}</code>
												</td>
												<td className="border-b border-border px-3 py-2 text-right whitespace-nowrap">
													<code className="text-mono text-fg-code">{formatBytes(h.bytesUp + h.bytesDown)}</code>
												</td>
											</tr>
										))}
										<tr>
											<td className="px-3 py-2 text-xs text-fg-3">合计</td>
											<td className="px-3 py-2 text-right">
												<code className="text-mono text-fg-2">{formatNumber(totalReq)}</code>
											</td>
											<td className="px-3 py-2 text-right whitespace-nowrap">
												<code className="text-mono text-fg-2">{formatBytes(totalBytes)}</code>
											</td>
										</tr>
									</tbody>
								</table>
							)}
						</div>
					</div>
					<div className="flex min-w-0 flex-col gap-2">
						<h3 className={cn("m-0 flex items-center gap-1.5 section-label", denied.length > 0 && "text-warning-fg")}>
							{denied.length > 0 && <span aria-hidden="true" className="size-[7px] rounded-full bg-warning" />}
							被拒绝的请求 · {deniedTotal} 次
						</h3>
						{denied.length === 0 ? (
							<p className="m-0 rounded-md border border-border bg-bg px-3 py-4 text-xs text-fg-3">没有被拒绝的请求</p>
						) : (
							<ul className="m-0 flex list-none flex-col rounded-md border border-border bg-bg p-0">
								{denied.map((d, i) => {
									const allowed = matchDomain(d.host, p.extraDomains);
									return (
										<li key={d.host} className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2", i < denied.length - 1 && "border-b border-border")}>
											<div className="flex min-w-[160px] flex-1 flex-col gap-0.5">
												<code className="text-mono break-all text-fg">{d.host}</code>
												<span className="text-xs text-fg-2">
													{d.count} 次 · 最近 {formatRelativeTime(d.lastAt)}
												</span>
											</div>
											{allowed ? <span className="text-xs text-success-fg">已在白名单</span> : <AllowButton view={view} host={d.host} />}
										</li>
									);
								})}
							</ul>
						)}
					</div>
				</div>
			)}
		</Card>
	);
}

export function LogsCard({ view, className, lines = 8, tall }: { view: ServerView; className?: string; lines?: number; tall?: boolean }) {
	const [open, setOpen] = useState(false);
	const tail = tall ? 300 : 50;
	const logs = useAgentLogs(view, tail);
	const available = agentAvailable(view);
	const root = view.config.deployed?.remoteRoot ?? view.config.remoteRoot;
	const shown = tall ? (logs.data ?? []) : (logs.data ?? []).slice(-lines);
	return (
		<Card
			className={cn("overflow-hidden", className)}
			title="最近日志"
			icon={<ScrollText />}
			padded={false}
			description={<code className="text-xs text-fg-3">{`${root}/logs/agent.log`}</code>}
			actions={
				<div className="flex items-center gap-2">
					{tall && (
						<Button size="sm" variant="ghost" disabled={!available || logs.isFetching} onClick={() => void logs.refetch()}>
							刷新
						</Button>
					)}
					<Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!available}>
						查看全部日志
					</Button>
				</div>
			}
		>
			{!available ? (
				<p className="m-0 bg-code px-4 py-3 text-xs text-fg-3">{view.config.deployed ? "服务器未连接，无法读取 agent 日志。" : "尚未部署 pi-web-agent。"}</p>
			) : logs.isLoading ? (
				<LoadingBlock />
			) : logs.isError ? (
				<p className="m-0 bg-code px-4 py-3 text-xs text-danger">{errorMessage(logs.error)}</p>
			) : shown.length === 0 ? (
				<p className="m-0 bg-code px-4 py-3 text-xs text-fg-3">日志为空</p>
			) : (
				<AgentLogLines lines={shown} className={tall ? "max-h-[560px]" : undefined} />
			)}
			{open && <LogsModal view={view} open onClose={() => setOpen(false)} />}
		</Card>
	);
}
