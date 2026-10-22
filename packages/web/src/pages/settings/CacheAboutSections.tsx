/** 全局设置: 缓存 and 关于 sections. */
import type { CacheEntry } from "@pi-web/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Eraser, Trash2 } from "lucide-react";
import { useState } from "react";
import { deleteCache, errorMessage, getCache, getSyncStatus, saveBlob } from "../../api/client";
import { useMeta, useSettings } from "../../api/hooks";
import { queryClient, queryKeys } from "../../api/queryClient";
import { toast } from "../../components/ui";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Display";
import { IconButton } from "../../components/ui/IconButton";
import { Modal } from "../../components/ui/Modal";
import { LoadingBlock } from "../../components/ui/Spinner";
import { cn } from "../../lib/cn";
import { formatBytes, formatDateTime } from "../../lib/format";
import { useServers } from "../../stores/servers";
import { SettingsSection } from "../servers/components/SettingsLayout";

const KIND_LABELS: Record<CacheEntry["kind"], string> = { node: "Node.js", pi: "pi", agent: "agent" };

export function useCacheQuery() {
	return useQuery({ queryKey: queryKeys.cache, queryFn: () => getCache(), staleTime: 30_000 });
}

export function CacheSection() {
	const cache = useCacheQuery();
	const servers = useServers({ includeJumpOnly: true });
	const [confirm, setConfirm] = useState<CacheEntry[] | null>(null);
	const entries = cache.data?.entries ?? [];
	const unused = entries.filter((e) => e.usedBy.length === 0);
	const unusedBytes = unused.reduce((n, e) => n + e.bytes, 0);
	const name = (id: string) => servers.find((s) => s.config.id === id)?.config.name ?? id;
	const remove = useMutation({
		mutationFn: async (list: CacheEntry[]) => {
			const results = await Promise.allSettled(list.map((e) => deleteCache(e.name)));
			return results.filter((r) => r.status === "rejected").map((r) => errorMessage((r as PromiseRejectedResult).reason));
		},
		onSuccess: (failures, list) => {
			if (failures.length) toast.error(failures.join("\n"), { title: "部分缓存未能删除" });
			else toast.success(list.length === 1 ? `已删除 ${list[0].name}` : `已清理 ${list.length} 个离线包`);
			setConfirm(null);
			void queryClient.invalidateQueries({ queryKey: queryKeys.cache });
		},
	});
	return (
		<SettingsSection
			id="set-cache"
			plainHeader
			title="缓存"
			description={
				<>
					离线包位于 Host 数据目录的 <code className="text-xs text-fg-2">cache/</code>，部署时命中缓存则跳过下载和打包。
				</>
			}
		>
			<div className="flex flex-col gap-3 border-t border-border px-4 pt-3.5 pb-4">
				{cache.isLoading ? (
					<LoadingBlock />
				) : cache.isError ? (
					<Callout tone="danger">{errorMessage(cache.error)}</Callout>
				) : (
					<>
						<div className="relative overflow-x-auto rounded-lg border border-border">
							<table className="w-full min-w-[460px] border-collapse text-sm">
								<thead>
									<tr className="bg-raised">
										<th scope="col" className="px-3 py-2 text-left section-label">
											文件
										</th>
										<th scope="col" className="w-24 px-3 py-2 text-right section-label">
											大小
										</th>
										<th scope="col" className="w-24 px-3 py-2 text-left section-label">
											使用中
										</th>
										<th scope="col" className="w-10 px-2 py-2">
											<span className="sr-only">操作</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{entries.length === 0 && (
										<tr>
											<td colSpan={4} className="border-t border-border px-3 py-4 text-center text-xs text-fg-3">
												还没有缓存的离线包，首次部署时会自动下载并打包。
											</td>
										</tr>
									)}
									{entries.map((e) => {
										const used = e.usedBy.length > 0;
										return (
											<tr key={e.name} title={`${KIND_LABELS[e.kind]} ${e.version}${e.arch ? ` · ${e.arch}` : ""} · ${formatDateTime(e.createdAt)}`}>
												<td className="border-t border-border px-3 py-2">
													<code className={cn("text-mono break-all", used ? "text-fg-code" : "text-fg-2")}>{e.name}</code>
												</td>
												<td className={cn("border-t border-border px-3 py-2 text-right font-mono text-mono", used ? "text-fg-code" : "text-fg-2")}>{formatBytes(e.bytes)}</td>
												<td className="border-t border-border px-3 py-2">
													<span className={cn("flex items-center gap-1.5", used ? "text-fg" : "text-fg-3")} title={used ? e.usedBy.map(name).join("、") : undefined}>
														<span aria-hidden="true" className={cn("size-2 rounded-full", used ? "bg-success" : "border-[1.5px] border-fg-4")} />
														{used ? `${e.usedBy.length} 台` : "否"}
													</span>
												</td>
												<td className="border-t border-border px-2 py-1 text-right">
													<IconButton aria-label={`删除 ${e.name}`} size="md" variant="subtle" onClick={() => setConfirm([e])}>
														<Trash2 size={13} strokeWidth={1.8} />
													</IconButton>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
						<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
							<span className="text-xs text-fg-2">
								共 <span className="font-mono text-fg">{formatBytes(cache.data?.totalBytes ?? 0)}</span> · 未使用 <span className="font-mono">{formatBytes(unusedBytes)}</span>
							</span>
							<Button size="sm" icon={<Eraser size={13} strokeWidth={1.8} />} disabled={unused.length === 0} onClick={() => setConfirm(unused)}>
								清理未使用的包
							</Button>
						</div>
					</>
				)}
			</div>
			{confirm && (
				<Modal
					open
					role="alertdialog"
					size="sm"
					title={confirm.length === 1 ? `删除 ${confirm[0].name}？` : `清理 ${confirm.length} 个未使用的离线包？`}
					onClose={() => setConfirm(null)}
					footer={
						<>
							<Button onClick={() => setConfirm(null)}>取消</Button>
							<Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(confirm)}>
								删除
							</Button>
						</>
					}
				>
					<div className="flex flex-col gap-2 text-sm text-fg-2">
						<p className="m-0">{`将释放 ${formatBytes(confirm.reduce((n, e) => n + e.bytes, 0))}。下次部署需要时会重新下载或打包。`}</p>
						{confirm.some((e) => e.usedBy.length > 0) && <Callout tone="warning">该离线包仍被服务器使用；删除只影响 Host 缓存，不影响已部署的服务器。</Callout>}
					</div>
				</Modal>
			)}
		</SettingsSection>
	);
}

export function AboutSection() {
	const meta = useMeta();
	const settings = useSettings();
	const servers = useServers({ includeJumpOnly: true });
	const cache = useCacheQuery();
	const [exporting, setExporting] = useState(false);
	const m = meta.data;
	const items = [
		{ label: "Pi-Web", value: m?.version },
		{ label: "数据目录", value: m?.dataDir },
		{ label: "Host pi", value: m?.hostPiVersion ?? "未安装" },
		{ label: "主机名", value: m?.hostname },
		{ label: "Host agent 目录", value: m?.hostAgentDir },
	];
	/** Versions, settings and server status only — the host never returns secrets in these views. */
	const exportDiagnostics = async () => {
		setExporting(true);
		try {
			const sync = await getSyncStatus().catch((e: unknown) => ({ error: errorMessage(e) }));
			const report = {
				generatedAt: new Date().toISOString(),
				userAgent: navigator.userAgent,
				meta: m,
				settings: settings.data,
				cache: cache.data,
				sync,
				servers: servers.map((s) => ({
					id: s.config.id,
					name: s.config.name,
					target: `${s.config.username}@${s.config.host}:${s.config.port}`,
					jumpServerIds: s.config.jumpServerIds,
					auth: { method: s.config.auth.method, hasSecret: Boolean(s.config.auth.hasSecret) },
					agentDirMode: s.config.agentDirMode,
					proxy: s.config.proxy,
					syncItems: s.config.sync.items,
					deployed: s.config.deployed,
					status: s.status,
				})),
			};
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			saveBlob(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), `pi-web-diagnostics-${stamp}.json`);
		} finally {
			setExporting(false);
		}
	};
	return (
		<SettingsSection id="set-about" plainHeader title="关于">
			<div className="flex flex-col gap-3.5 border-t border-border px-4 pt-3.5 pb-4">
				<dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(160px,100%),1fr))] gap-x-4 gap-y-3">
					{items.map((it) => (
						<div key={it.label} className="flex min-w-0 flex-col gap-1">
							<dt className="section-label">{it.label}</dt>
							<dd className="m-0 font-mono text-sm break-all text-fg">{it.value ?? "-"}</dd>
						</div>
					))}
				</dl>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<Button size="sm" icon={<Download size={13} strokeWidth={1.8} />} loading={exporting} onClick={() => void exportDiagnostics()}>
						导出诊断信息
					</Button>
					<span className="text-xs text-fg-3">包含版本、设置和服务器状态，不含密码、密钥与令牌。</span>
				</div>
			</div>
		</SettingsSection>
	);
}
