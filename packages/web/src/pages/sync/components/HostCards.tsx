/** 同步中心: Host inventory tiles and OAuth keeper cards. */
import type { OAuthStatusResponse } from "@pi-web/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { File, Folder, FolderCog, KeyRound, RefreshCw } from "lucide-react";
import { errorMessage, refreshOAuth } from "../../../api/client";
import { queryKeys } from "../../../api/queryClient";
import { toast } from "../../../components/ui";
import { Button } from "../../../components/ui/Button";
import { Card, ProgressBar } from "../../../components/ui/Display";
import { IconButton } from "../../../components/ui/IconButton";
import { LoadingBlock } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { formatBytes, formatTime } from "../../../lib/format";
import { useServers } from "../../../stores/servers";
import { useNow, useOAuthStatus, useSyncInventory } from "../../servers/hooks";
import { oauthProgress, pushedText, refreshText, remainingText } from "../lib/oauth";

const NEVER = ["sessions/", "trust.json", "*.log", "bin/", "tools/"];

export function NeverSyncedNote() {
	return (
		<>
			永不同步：
			{NEVER.map((n, i) => (
				<span key={n}>
					{i > 0 && "、"}
					<code className="text-[11.5px] text-fg-2">{n}</code>
				</span>
			))}
		</>
	);
}

export function InventoryCard({ className }: { className?: string }) {
	const client = useQueryClient();
	const q = useSyncInventory();
	const inv = q.data;
	return (
		<Card
			className={className}
			title={
				<>
					Host 配置{inv && <> · <code className="text-[13px] font-medium text-fg-code">{inv.agentDir}</code></>}
				</>
			}
			icon={<FolderCog />}
			padded={false}
			actions={
				<span className="flex items-center gap-1">
					{inv && <span className="text-xs text-fg-3">扫描于 {formatTime(inv.scannedAt)}</span>}
					<IconButton
						aria-label="重新扫描 Host 配置"
						size="md"
						disabled={q.isFetching}
						onClick={() => void client.invalidateQueries({ queryKey: queryKeys.syncInventory })}
					>
						<RefreshCw size={13} strokeWidth={1.8} className={q.isFetching ? "animate-spin" : undefined} />
					</IconButton>
				</span>
			}
			footer={
				<span className="w-full text-xs leading-[18px] text-fg-3">
					<NeverSyncedNote />
				</span>
			}
		>
			{q.isLoading ? (
				<LoadingBlock />
			) : q.isError ? (
				<p className="m-0 p-4 text-sm text-danger">{errorMessage(q.error)}</p>
			) : (
				<div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-2 p-4">
					{inv?.items.map((item) => {
						const dir = item.label.endsWith("/") || item.key === "agentsSkills";
						const Icon = dir ? Folder : File;
						const detail = !item.present ? "不存在" : (item.detail ?? (dir ? `${item.fileCount} 个文件 · ${formatBytes(item.bytes)}` : formatBytes(item.bytes)));
						return (
							<div
								key={item.key}
								className={cn("flex min-w-0 items-center gap-2.5 rounded-md border border-border bg-bg px-2.5 py-2", !item.present && "opacity-60")}
								title={item.present ? `${item.fileCount} 个文件 · ${formatBytes(item.bytes)}` : "Host 上不存在"}
							>
								<Icon size={16} strokeWidth={1.7} className="shrink-0 text-fg-3" aria-hidden="true" />
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<code className="truncate text-mono text-fg">{item.label}</code>
									<span className="truncate text-xs text-fg-2">{detail}</span>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</Card>
	);
}

function OAuthProvider({ p, first }: { p: OAuthStatusResponse["providers"][number]; first: boolean }) {
	const client = useQueryClient();
	const servers = useServers({ includeJumpOnly: true });
	const now = useNow(30_000);
	const prog = oauthProgress(p, servers, now);
	const refresh = useMutation({
		mutationFn: () => refreshOAuth(p.provider),
		onSuccess: (data) => {
			client.setQueryData(queryKeys.oauth, data);
			toast.success(`已刷新 ${p.provider} 的 access token`);
		},
		onError: (e) => toast.error(errorMessage(e), { title: `刷新 ${p.provider} 失败` }),
	});
	const offline = (id: string) => servers.find((s) => s.config.id === id)?.status.connection !== "connected";
	return (
		<div className={cn("flex flex-col gap-2 px-4 py-3", !first && "border-t border-border")}>
			<div className="flex flex-wrap items-center gap-2">
				<code className="text-sm font-medium text-fg">{p.provider}</code>
				<span className="flex-1" />
				<Button size="sm" icon={<RefreshCw size={12} strokeWidth={1.8} className="text-fg-2" />} loading={refresh.isPending} onClick={() => refresh.mutate()}>
					立即刷新
				</Button>
			</div>
			<ProgressBar value={prog.ratio * 100} tone={prog.tone === "accent" ? "accent" : prog.tone} label={`${p.provider} access token 剩余有效期`} />
			<span className="text-xs leading-[18px] text-fg-2">
				<span className={cn(prog.tone === "accent" ? "text-fg" : prog.tone === "warning" ? "text-warning-fg" : "text-danger")}>{remainingText(prog)}</span>
				{!prog.expired && ` · ${refreshText(prog.refreshInMs)}`} · {pushedText(prog, offline)}
			</span>
			{p.error && <span className="text-xs text-danger">刷新失败：{p.error}</span>}
		</div>
	);
}

export function OAuthCard({ className }: { className?: string }) {
	const q = useOAuthStatus();
	const providers = q.data?.providers ?? [];
	const margins = providers.map((p) => Math.round((p.expiresAt - p.refreshAt) / 60_000)).filter((m) => m > 0);
	return (
		<Card
			className={className}
			title="OAuth 托管"
			icon={<KeyRound />}
			padded={false}
			actions={<span className="text-xs text-fg-3">{margins.length ? `到期前 ${Math.max(...margins)} 分钟刷新` : "到期前自动刷新"}</span>}
			footer={<span className="w-full text-xs leading-[18px] text-fg-3">API Key 条目原样同步，不经过托管。</span>}
		>
			<p className="m-0 px-4 py-3 text-[12.5px] leading-[1.6] text-fg-2">服务器只持有 access token；refresh token 只保存在 Host，由 Pi-Web 在过期前刷新并推送。</p>
			{q.isLoading ? (
				<LoadingBlock />
			) : q.isError ? (
				<p className="m-0 border-t border-border px-4 py-3 text-sm text-danger">{errorMessage(q.error)}</p>
			) : providers.length === 0 ? (
				<p className="m-0 border-t border-border px-4 py-3 text-sm text-fg-3">Host 的 auth.json 中没有 OAuth 凭据。</p>
			) : (
				<div className="border-t border-border">
					{providers.map((p, i) => (
						<OAuthProvider key={p.provider} p={p} first={i === 0} />
					))}
				</div>
			)}
		</Card>
	);
}
