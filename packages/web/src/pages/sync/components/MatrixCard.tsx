import type { SyncCellState, SyncPlan } from "@pi-web/shared";
import { ChevronRight, Grid3x3 } from "lucide-react";
import { Card, EmptyState } from "../../../components/ui/Display";
import { Spinner } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { CELL_STATE_LABELS, MATRIX_COLUMNS, type MatrixRow, rowSubtitle } from "../lib/matrix";
import { planCounts } from "../lib/plan";

const DOT: Record<SyncCellState, string> = {
	synced: "bg-success",
	pending: "bg-warning",
	conflict: "bg-warning",
	unknown: "border-[1.5px] border-fg-4",
	disabled: "",
};

export function Cell({ state }: { state: SyncCellState }) {
	if (state === "disabled") {
		return (
			<>
				<span aria-hidden="true" className="text-xs text-fg-3">
					—
				</span>
				<span className="sr-only">未启用</span>
			</>
		);
	}
	if (state === "conflict") {
		return (
			<span className="inline-flex h-[22px] items-center gap-[5px] rounded-full border border-warning-edge bg-warning-strong px-2 text-xs font-semibold text-warning-fg">
				<span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
				冲突
				<span aria-hidden="true" className="font-mono font-bold">
					!
				</span>
			</span>
		);
	}
	return (
		<span className={cn("inline-flex items-center gap-1.5 text-xs", state === "pending" ? "text-warning-fg" : state === "unknown" ? "text-fg-3" : "text-fg-2")}>
			<span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[state])} />
			{CELL_STATE_LABELS[state]}
		</span>
	);
}

function DiffSummary({ plan }: { plan: SyncPlan | undefined }) {
	if (!plan) return <span className="text-xs text-fg-3">—</span>;
	if (plan.entries.length === 0) return <span className="text-xs text-success-fg">无差异</span>;
	const c = planCounts(plan);
	return (
		<code className="inline-flex gap-2 text-xs">
			{c.add > 0 && <span className="text-success-fg">+{c.add}</span>}
			{c.update > 0 && <span className="text-fg-code">~{c.update}</span>}
			{c.delete > 0 && <span className="text-danger">−{c.delete}</span>}
			{c.conflict > 0 && <span className="text-warning-fg">!{c.conflict}</span>}
		</code>
	);
}

const TH = "border-b border-border px-3 py-2.5 text-left section-label whitespace-nowrap";

export function MatrixCard({
	rows,
	selected,
	onSelect,
	previews,
	loading,
	error,
}: {
	rows: readonly MatrixRow[];
	selected: string | null;
	onSelect: (serverId: string) => void;
	previews: Record<string, SyncPlan | undefined>;
	loading: boolean;
	error: string | null;
}) {
	return (
		<Card
			title="同步矩阵"
			icon={<Grid3x3 />}
			description="选择服务器查看差异"
			padded={false}
			actions={
				<div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-fg-2">
					<span className="inline-flex items-center gap-1.5">
						<span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
						已同步
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
						待同步
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
						冲突
						<span aria-hidden="true" className="font-mono font-bold text-warning-fg">
							!
						</span>
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span aria-hidden="true" className="text-fg-3">
							—
						</span>
						未启用
					</span>
				</div>
			}
		>
			{loading ? (
				<div className="flex items-center justify-center gap-2 py-10 text-sm text-fg-3">
					<Spinner size={14} /> 加载中…
				</div>
			) : error ? (
				<p className="m-0 p-4 text-sm text-danger">{error}</p>
			) : rows.length === 0 ? (
				<EmptyState compact title="还没有服务器" description="添加服务器后，这里会显示每台服务器各同步项的状态。" />
			) : (
				<div className="relative overflow-x-auto">
					<table className="w-full min-w-[960px] border-collapse text-sm">
						<thead>
							<tr>
								<th scope="col" className={cn(TH, "w-[184px] px-4")}>
									服务器
								</th>
								{MATRIX_COLUMNS.map((col) => (
									<th key={col.id} scope="col" className={TH} title={col.title}>
										{col.label}
									</th>
								))}
								<th scope="col" className={TH}>
									差异
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row, i) => {
								const on = row.serverId === selected;
								const last = i === rows.length - 1;
								const td = cn("px-3 py-2.5 whitespace-nowrap", !last && "border-b border-border");
								return (
									<tr key={row.serverId} className={on ? "bg-selected" : "hover:bg-raised"}>
										<th scope="row" className={cn("p-0 text-left font-normal", !last && "border-b border-border")}>
											<button
												type="button"
												aria-pressed={on}
												onClick={() => onSelect(row.serverId)}
												className={cn(
													"flex w-full items-center gap-2.5 border-0 bg-transparent py-[9px] pr-3 pl-4 text-left",
													row.online ? "text-fg" : "text-fg-2",
												)}
											>
												<span
													aria-hidden="true"
													className={cn("size-2 shrink-0 rounded-full", row.online ? "bg-success" : "border-[1.5px] border-fg-4")}
												/>
												<span className="flex min-w-0 flex-1 flex-col gap-0.5">
													<span className="truncate text-sm font-semibold">{row.name}</span>
													<span className="flex items-center gap-1 text-2xs text-fg-3">
														{row.running && <Spinner size={9} />}
														{rowSubtitle(row)}
													</span>
												</span>
												<ChevronRight size={12} strokeWidth={2.2} className={cn("shrink-0 text-accent", on ? "opacity-100" : "opacity-0")} aria-hidden="true" />
											</button>
										</th>
										{row.cells.map((cell) => (
											<td key={cell.column.id} className={td}>
												<Cell state={cell.state} />
											</td>
										))}
										<td className={td}>
											<DiffSummary plan={previews[row.serverId]} />
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</Card>
	);
}
