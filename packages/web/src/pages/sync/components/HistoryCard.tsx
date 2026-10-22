import type { ServerView, SyncRecord } from "@pi-web/shared";
import { History, ScrollText } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../../../api/client";
import { Button } from "../../../components/ui/Button";
import { Card, EmptyState } from "../../../components/ui/Display";
import { Modal } from "../../../components/ui/Modal";
import { LoadingBlock } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { formatDateTime, formatDuration } from "../../../lib/format";
import { historyTime, TRIGGER_LABELS } from "../lib/plan";

const TH = "border-b border-border px-4 py-2.5 text-left section-label whitespace-nowrap";

function Changes({ r }: { r: SyncRecord }) {
	if (r.status === "error" && r.added + r.updated + r.deleted === 0) {
		return (
			<>
				<span aria-hidden="true" className="text-xs text-fg-3">
					—
				</span>
				<span className="sr-only">未应用</span>
			</>
		);
	}
	return (
		<code className="inline-flex gap-2 text-xs" title={`新增 ${r.added} · 修改 ${r.updated} · 删除 ${r.deleted}`}>
			<span className={r.added ? "text-success-fg" : "text-fg-3"}>+{r.added}</span>
			<span className={r.updated ? "text-fg-code" : "text-fg-3"}>~{r.updated}</span>
			<span className={r.deleted ? "text-danger" : "text-fg-3"}>−{r.deleted}</span>
		</code>
	);
}

function When({ at }: { at: number }) {
	const t = historyTime(at);
	return (
		<span className="text-[12.5px] text-fg-2" title={formatDateTime(at, true)}>
			{t.day && `${t.day} `}
			<code className="text-mono text-fg-code">{t.time}</code>
		</span>
	);
}

export interface HistoryCardProps {
	records: SyncRecord[] | undefined;
	loading: boolean;
	error: unknown;
	servers: readonly ServerView[];
	onSelectServer: (serverId: string) => void;
	canLoadMore: boolean;
	onLoadMore: () => void;
}

export function HistoryCard({ records, loading, error, servers, onSelectServer, canLoadMore, onLoadMore }: HistoryCardProps) {
	const [errorsOpen, setErrorsOpen] = useState(false);
	const name = (id: string) => servers.find((s) => s.config.id === id)?.config.name ?? id;
	const failures = (records ?? []).filter((r) => r.status === "error");
	return (
		<Card
			title="同步历史"
			icon={<History />}
			padded={false}
			actions={
				<div className="flex items-center gap-3">
					<span className="hidden text-xs text-fg-3 sm:inline">变更：+ 新增 · ~ 修改 · − 删除</span>
					<Button size="sm" icon={<ScrollText size={12} strokeWidth={1.8} className="text-fg-2" />} onClick={() => setErrorsOpen(true)}>
						错误日志{failures.length > 0 ? ` · ${failures.length}` : ""}
					</Button>
				</div>
			}
		>
			{loading ? (
				<LoadingBlock />
			) : error ? (
				<p className="m-0 p-4 text-sm text-danger">{errorMessage(error)}</p>
			) : !records?.length ? (
				<EmptyState compact title="还没有同步记录" />
			) : (
				<div className="relative overflow-x-auto">
					<table className="w-full min-w-[760px] border-collapse text-sm">
						<thead>
							<tr>
								<th scope="col" className={cn(TH, "w-[130px]")}>
									时间
								</th>
								<th scope="col" className={cn(TH, "w-[140px]")}>
									服务器
								</th>
								<th scope="col" className={cn(TH, "w-[170px]")}>
									触发
								</th>
								<th scope="col" className={cn(TH, "w-[140px]")}>
									变更
								</th>
								<th scope="col" className={TH}>
									状态
								</th>
							</tr>
						</thead>
						<tbody>
							{records.map((r, i) => {
								const last = i === records.length - 1 && !canLoadMore;
								const td = cn("px-4 py-2.5 whitespace-nowrap", !last && "border-b border-border");
								return (
									<tr key={r.id} className={r.status === "error" ? "bg-warning-soft" : undefined}>
										<td className={td}>
											<When at={r.at} />
										</td>
										<td className={cn(td, "text-fg")}>{name(r.serverId)}</td>
										<td className={cn(td, "text-fg-2")}>{TRIGGER_LABELS[r.trigger] ?? r.trigger}</td>
										<td className={td}>
											<Changes r={r} />
										</td>
										<td className={cn("px-4 py-2", !last && "border-b border-border")}>
											{r.status === "ok" ? (
												<span className="inline-flex items-center gap-1.5 text-[12.5px] text-success-fg" title={`用时 ${formatDuration(r.durationMs)}`}>
													<span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
													成功
													{r.conflicts > 0 && <span className="text-warning-fg">· 已备份 {r.backedUp.length || r.conflicts} 个冲突文件</span>}
												</span>
											) : (
												<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
													<span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] whitespace-normal text-warning-fg">
														<span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
														失败：{r.error ?? "未知错误"}
													</span>
													<button
														type="button"
														onClick={() => onSelectServer(r.serverId)}
														className="h-6 rounded-md border border-warning-border bg-transparent px-2 text-xs text-warning-fg hover:border-warning"
													>
														查看差异
													</button>
												</div>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					{canLoadMore && (
						<div className="flex justify-center px-4 py-2.5">
							<Button size="sm" variant="ghost" onClick={onLoadMore}>
								加载更多
							</Button>
						</div>
					)}
				</div>
			)}
			{errorsOpen && (
				<Modal open size="lg" title="同步错误日志" description="最近同步记录中的失败项。" onClose={() => setErrorsOpen(false)} footer={<Button onClick={() => setErrorsOpen(false)}>关闭</Button>}>
					{failures.length === 0 ? (
						<EmptyState compact title="没有失败的同步" />
					) : (
						<ul className="m-0 flex list-none flex-col gap-2 p-0">
							{failures.map((r) => (
								<li key={r.id} className="flex flex-col gap-1 rounded-md border border-border bg-bg px-3 py-2">
									<span className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
										<code className="text-fg-code">{formatDateTime(r.at, true)}</code>
										<span className="text-fg">{name(r.serverId)}</span>
										<span>{TRIGGER_LABELS[r.trigger] ?? r.trigger}</span>
									</span>
									<pre className="m-0 font-mono text-xs leading-[1.6] break-words whitespace-pre-wrap text-danger">{r.error ?? "未知错误"}</pre>
								</li>
							))}
						</ul>
					)}
				</Modal>
			)}
		</Card>
	);
}
