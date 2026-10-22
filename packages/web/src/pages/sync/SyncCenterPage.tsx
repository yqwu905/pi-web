import type { SyncPlan, SyncRunResponse } from "@pi-web/shared";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSearch, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, previewSync, runSync } from "../../api/client";
import { invalidateSync, useSyncStatus } from "../../api/hooks";
import { toast } from "../../components/ui";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { useServers } from "../../stores/servers";
import { serverQueryKeys, useSyncHistory } from "../servers/hooks";
import { DiffPreviewCard } from "./components/DiffPreviewCard";
import { HistoryCard } from "./components/HistoryCard";
import { InventoryCard, OAuthCard } from "./components/HostCards";
import { MatrixCard } from "./components/MatrixCard";
import { buildMatrixRows, defaultSelection } from "./lib/matrix";
import { lastRecordFor, recordChangeText } from "./lib/plan";

function runSummary(res: SyncRunResponse, name: (id: string) => string): void {
	const failed = res.records.filter((r) => r.status === "error");
	if (res.records.length === 0) toast.info("没有需要同步的服务器");
	else if (failed.length === 0) {
		toast.success(res.records.length === 1 ? `已同步 ${name(res.records[0].serverId)}：${recordChangeText(res.records[0])}` : `已同步 ${res.records.length} 台服务器`);
	} else {
		toast.error(failed.map((r) => `${name(r.serverId)}：${r.error ?? "失败"}`).join("\n"), { title: `${failed.length} 台服务器同步失败` });
	}
}

/** Route: /sync — 同步中心. */
export default function SyncCenterPage() {
	const client = useQueryClient();
	const servers = useServers({ includeJumpOnly: true });
	const status = useSyncStatus();
	const [historyLimit, setHistoryLimit] = useState(50);
	const history = useSyncHistory(historyLimit);
	const rows = useMemo(() => buildMatrixRows(status.data?.servers ?? [], servers), [status.data, servers]);
	const [selected, setSelected] = useState<string | null>(null);
	const current = defaultSelection(rows, selected);
	useEffect(() => {
		if (current !== selected) setSelected(current);
	}, [current, selected]);

	const name = (id: string) => servers.find((s) => s.config.id === id)?.config.name ?? id;
	const viewOf = (id: string | null) => (id ? servers.find((s) => s.config.id === id) : undefined);
	const deployedIds = rows
		.filter((r) => {
			const v = viewOf(r.serverId);
			return r.online && (v?.config.deployed || v?.status.deployState === "deployed" || v?.status.deployState === "outdated");
		})
		.map((r) => r.serverId);

	// Cached previews of every row (filled by "预览全部差异" and by the selected row's preview).
	const previews = useQueries({
		queries: rows.map((r) => ({
			queryKey: serverQueryKeys.syncPreview(r.serverId),
			queryFn: () => previewSync(r.serverId),
			enabled: false,
			staleTime: 60_000,
		})),
	});
	const previewMap = useMemo(() => Object.fromEntries(rows.map((r, i) => [r.serverId, previews[i]?.data as SyncPlan | undefined])), [rows, previews]);

	const selectedRow = rows.find((r) => r.serverId === current);
	const selectedView = viewOf(current);
	const selectedDeployed = Boolean(current && deployedIds.includes(current));
	const preview = useQuery({
		queryKey: serverQueryKeys.syncPreview(current ?? ""),
		queryFn: () => previewSync(current as string),
		enabled: selectedDeployed,
		staleTime: 60_000,
		retry: false,
	});

	// A finished run or new configuration makes cached previews stale.
	const statusStamp = useMemo(
		() => (status.data?.servers ?? []).map((s) => `${s.serverId}:${s.lastSyncAt ?? 0}:${s.pendingCount}:${s.running}`).join("|"),
		[status.data],
	);
	const firstStamp = useRef(true);
	useEffect(() => {
		if (firstStamp.current) {
			firstStamp.current = false;
			return;
		}
		void client.invalidateQueries({ queryKey: ["sync", "preview"] });
	}, [statusStamp, client]);
	const diffRef = useRef<HTMLDivElement>(null);

	const previewAll = useMutation({
		mutationFn: async () => {
			const results = await Promise.allSettled(
				deployedIds.map((id) => client.fetchQuery({ queryKey: serverQueryKeys.syncPreview(id), queryFn: () => previewSync(id), staleTime: 0 })),
			);
			return results.map((r, i) => ({ id: deployedIds[i], r }));
		},
		onSuccess: (results) => {
			const failed = results.filter((x) => x.r.status === "rejected");
			const withDiff = results.filter((x) => x.r.status === "fulfilled" && x.r.value.entries.length > 0);
			if (failed.length) toast.warning(`${failed.length} 台服务器无法计算差异`);
			else toast.info(withDiff.length ? `${withDiff.length} 台服务器有待同步的差异` : "所有在线服务器均已是最新");
			const firstConflict = withDiff.find((x) => x.r.status === "fulfilled" && x.r.value.entries.some((e) => e.conflict)) ?? withDiff[0];
			if (firstConflict) setSelected(firstConflict.id);
		},
	});

	const syncAll = useMutation({
		mutationFn: () => runSync({}),
		onSuccess: (res) => {
			runSummary(res, name);
			void invalidateSync();
		},
		onError: (e) => toast.error(errorMessage(e), { title: "同步失败" }),
	});
	const syncOne = useMutation({
		mutationFn: (id: string) => runSync({ serverIds: [id] }),
		onSuccess: (res) => {
			runSummary(res, name);
			void invalidateSync();
		},
		onError: (e) => toast.error(errorMessage(e), { title: "同步失败" }),
	});

	const autoCount = rows.filter((r) => r.auto).length;
	const hostDir = status.data?.hostAgentDir;
	const anyRunning = rows.some((r) => r.running);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto py-6">
			<div className="mx-auto flex w-full max-w-[1240px] flex-col gap-4 px-4 sm:px-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1.5">
						<div className="flex items-center gap-2.5">
							<RefreshCw size={20} strokeWidth={1.7} className="text-accent" aria-hidden="true" />
							<h1 className="m-0 text-xl font-semibold">同步中心</h1>
						</div>
						<p className="m-0 text-sm leading-[1.6] text-fg-2">
							将 Host 的 <code className="text-mono text-fg-code">{hostDir ?? "~/.pi/agent"}</code> 单向同步到服务器；只删除由同步写入且已在 Host 删除的文件。
						</p>
						{status.data && (
							<span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
								<span
									aria-hidden="true"
									className={cn("size-1.5 rounded-full", status.data.watching ? "animate-pulse-dot bg-success" : "border-[1.5px] border-fg-4")}
								/>
								{status.data.watching ? "正在监听" : "未监听"} <code className="text-[11.5px] text-fg-2">{status.data.hostAgentDir}</code> · 自动同步：
								{autoCount} 台已开启
							</span>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							icon={<FileSearch size={14} strokeWidth={1.8} className="text-fg-2" />}
							loading={previewAll.isPending}
							disabled={deployedIds.length === 0}
							onClick={() => previewAll.mutate()}
						>
							预览全部差异
						</Button>
						<Button
							variant="primary"
							icon={<RefreshCw size={14} strokeWidth={1.8} />}
							loading={syncAll.isPending || anyRunning}
							disabled={rows.length === 0}
							onClick={() => syncAll.mutate()}
						>
							全部同步
						</Button>
					</div>
				</div>
				<div className="flex flex-wrap items-stretch gap-4">
					<InventoryCard className="max-w-full min-w-0 flex-[3_1_560px]" />
					<OAuthCard className="max-w-full min-w-0 flex-[2_1_380px]" />
				</div>
				<MatrixCard
					rows={rows}
					selected={current}
					onSelect={setSelected}
					previews={previewMap}
					loading={status.isLoading}
					error={status.isError ? errorMessage(status.error) : null}
				/>
				{selectedRow && (
					<div ref={diffRef} className="scroll-mt-4">
					<DiffPreviewCard
						key={selectedRow.serverId}
						row={selectedRow}
						view={selectedView}
						hostAgentDir={hostDir}
						plan={preview.data}
						loading={preview.isFetching}
						error={preview.error}
						onRefresh={() => void preview.refetch()}
						lastRecord={lastRecordFor(history.data, selectedRow.serverId)}
						syncing={syncOne.isPending && syncOne.variables === selectedRow.serverId}
						onSync={() => syncOne.mutate(selectedRow.serverId)}
					/>
					</div>
				)}
				<HistoryCard
					records={history.data}
					loading={history.isLoading}
					error={history.error}
					servers={servers}
					onSelectServer={(id) => {
						setSelected(id);
						requestAnimationFrame(() => diffRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
					}}
					canLoadMore={(history.data?.length ?? 0) >= historyLimit && historyLimit < 1000}
					onLoadMore={() => setHistoryLimit((n) => Math.min(1000, n * 2))}
				/>
			</div>
		</div>
	);
}
