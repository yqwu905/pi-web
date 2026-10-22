import type { ServerView, WorkspaceView } from "@pi-web/shared";
import { Ellipsis, Folder, FolderPlus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useServerWorkspaces } from "../../../api/hooks";
import { Button } from "../../../components/ui/Button";
import { Card, EmptyState } from "../../../components/ui/Display";
import { Menu } from "../../../components/ui/Menu";
import { LoadingBlock } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { paths } from "../../../lib/routes";
import { useLiveConversations } from "../../../stores/convs";
import { NewWorkspaceDialog } from "../../workspace/NewWorkspaceDialog";
import { WorkspaceSettingsDialog } from "../../workspace/WorkspaceSettingsDialog";

const TH = "border-b border-border px-4 py-2.5 text-left section-label whitespace-nowrap";

function WorkspaceRow({ workspace, last, onSettings }: { workspace: WorkspaceView; last: boolean; onSettings: () => void }) {
	const ws = workspace.config;
	const live = useLiveConversations(ws.id);
	const navigate = useNavigate();
	const running = live.filter((c) => c.info.status === "running" || c.info.status === "starting").length;
	const waiting = live.filter((c) => c.info.status === "waiting_ui").length;
	const td = cn("px-4 py-3", !last && "border-b border-border");
	return (
		<tr>
			<td className={cn(td, "whitespace-nowrap")}>
				<Link to={paths.chat(ws.id)} className="flex items-center gap-2 font-semibold text-fg hover:text-link">
					<Folder size={14} strokeWidth={1.7} className="shrink-0 text-fg-2" aria-hidden="true" />
					{ws.alias || ws.path}
				</Link>
			</td>
			<td className={cn(td, "whitespace-nowrap")}>
				<code className="text-mono text-fg-code">{ws.path}</code>
			</td>
			<td className={cn(td, "text-right")}>
				<code className="text-mono text-fg">{workspace.sessionCount ?? "-"}</code>
			</td>
			<td className={cn(td, "whitespace-nowrap")}>
				{running === 0 && waiting === 0 ? (
					<span className="flex items-center gap-1.5 text-mono text-fg-2">
						<span aria-hidden="true" className="size-[7px] rounded-full border-[1.5px] border-fg-4" />
						空闲
					</span>
				) : (
					<div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-mono">
						{running > 0 && (
							<span className="flex items-center gap-1.5 text-link">
								<span aria-hidden="true" className="size-[7px] animate-pulse-dot rounded-full bg-accent" />
								{running} 个运行中
							</span>
						)}
						{waiting > 0 && (
							<span className="flex items-center gap-1.5 text-warning-fg">
								<span aria-hidden="true" className="size-[7px] rounded-full bg-warning" />
								{waiting} 个等待确认
							</span>
						)}
					</div>
				)}
			</td>
			<td className={td}>
				<code
					className={cn(
						"inline-block rounded-sm px-2 py-0.5 text-xs",
						ws.trust === "approve" ? "bg-success-soft text-success-fg" : "border border-border bg-chip text-fg-2",
					)}
				>
					{ws.trust}
				</code>
			</td>
			<td className={cn("px-4 py-2", !last && "border-b border-border")}>
				<div className="flex items-center justify-end gap-2">
					<Link to={paths.chat(ws.id)} className="text-sm">
						打开
					</Link>
					<Menu
						aria-label={`${ws.alias} 操作`}
						trigger={(p) => (
							<button
								{...p}
								type="button"
								aria-label={`${ws.alias} 更多操作`}
								title="更多操作"
								className="flex size-7 items-center justify-center rounded-md border border-border bg-transparent text-fg-2 hover:border-border-strong hover:text-fg"
							>
								<Ellipsis size={14} strokeWidth={2} />
							</button>
						)}
						items={[
							{ label: "工作区设置…", onSelect: onSettings },
							{ type: "separator" },
							{ label: "文件", onSelect: () => navigate(paths.files(ws.id)) },
							{ label: "终端", onSelect: () => navigate(paths.terminal(ws.id)) },
							{ label: "Git", onSelect: () => navigate(paths.git(ws.id)) },
						]}
					/>
				</div>
			</td>
		</tr>
	);
}

export function WorkspacesCard({ view, className }: { view: ServerView; className?: string }) {
	const q = useServerWorkspaces(view.config.id);
	const [adding, setAdding] = useState(false);
	const [settingsFor, setSettingsFor] = useState<string | null>(null);
	const list = q.data ?? [];
	const sessions = list.reduce((n, w) => n + (w.sessionCount ?? 0), 0);
	return (
		<Card
			className={className}
			title="工作区"
			icon={<Folder />}
			description={q.data ? `${list.length} 个 · ${sessions} 个会话` : undefined}
			padded={false}
			actions={
				<Button size="sm" icon={<FolderPlus size={13} strokeWidth={1.8} />} onClick={() => setAdding(true)} disabled={!view.config.deployed}>
					添加工作区
				</Button>
			}
		>
			{q.isLoading ? (
				<LoadingBlock />
			) : list.length === 0 ? (
				<EmptyState
					compact
					icon={<Folder />}
					title="还没有工作区"
					description={view.config.deployed ? "工作区是服务器上的一个目录，pi 在其中运行。" : "部署完成后即可添加工作区。"}
				/>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[820px] border-collapse text-sm">
						<thead>
							<tr>
								<th scope="col" className={TH}>
									工作区
								</th>
								<th scope="col" className={TH}>
									路径
								</th>
								<th scope="col" className={cn(TH, "text-right")}>
									会话
								</th>
								<th scope="col" className={TH}>
									状态
								</th>
								<th scope="col" className={TH}>
									信任
								</th>
								<th scope="col" className="border-b border-border px-4 py-2.5">
									<span className="sr-only">操作</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{list.map((w, i) => (
								<WorkspaceRow key={w.config.id} workspace={w} last={i === list.length - 1} onSettings={() => setSettingsFor(w.config.id)} />
							))}
						</tbody>
					</table>
				</div>
			)}
			{adding && <NewWorkspaceDialog serverId={view.config.id} open onClose={() => setAdding(false)} />}
			{settingsFor && <WorkspaceSettingsDialog workspaceId={settingsFor} open onClose={() => setSettingsFor(null)} />}
		</Card>
	);
}
