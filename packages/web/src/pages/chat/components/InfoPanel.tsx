import { Archive, ArchiveRestore, Copy as CopyIcon, Download, FileDown, GitFork, Layers, ListTree, PanelRightClose, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { downloadWorkspaceFile, errorMessage, exportConversation, reloadConversation, saveBlob } from "../../../api/client";
import { Button, Callout, IconButton, ProgressBar, SectionLabel, toast } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { formatCost, formatNumber, formatTokens, tildify } from "../../../lib/format";
import { archiveBlockedReason } from "../../../lib/sessions";
import type { ConversationHandle } from "../../../stores/conversation";
import { useServer } from "../../../stores/servers";
import { contextSummary, usageFromMessages, usageFromStats } from "../logic/usage";
import { invalidateCommands } from "./Composer";

/** Auto-retry has no field in get_state; remember what this client last set per conversation. */
const autoRetryByConv = new Map<string, boolean>();

export interface InfoPanelProps {
	conv: ConversationHandle;
	onClose: () => void;
	onOpenTree: () => void;
	onOpenFork: () => void;
	onOpenCompact: () => void;
	onOpenRename: () => void;
	onOpenDelete: () => void;
	/** The session is archived (hidden in Pi-Web). */
	archived: boolean;
	archiveBusy: boolean;
	onToggleArchive: () => void;
	className?: string;
}

function ActionButton({
	icon,
	children,
	onClick,
	loading,
	disabled,
	title,
}: {
	icon?: ReactNode;
	children: ReactNode;
	onClick: () => void;
	loading?: boolean;
	disabled?: boolean;
	title?: string;
}) {
	return (
		<Button variant="outline" size="md" className="w-full text-xs" icon={icon} onClick={onClick} loading={loading} disabled={disabled} title={title}>
			{children}
		</Button>
	);
}

function ToggleRow({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
	const id = useId();
	return (
		<label htmlFor={id} className={cn("flex items-center justify-between gap-2 text-xs text-fg-2", disabled ? "opacity-60" : "cursor-pointer")}>
			{label}
			<input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="m-0 size-4 accent-primary" />
		</label>
	);
}

/** Right-hand 会话信息 panel: context bar, usage, session file and session actions. */
export function InfoPanel({
	conv,
	onClose,
	onOpenTree,
	onOpenFork,
	onOpenCompact,
	onOpenRename,
	onOpenDelete,
	archived,
	archiveBusy,
	onToggleArchive,
	className,
}: InfoPanelProps) {
	const server = useServer(conv.serverId);
	const [busy, setBusy] = useState<"clone" | "export" | "jsonl" | "reload" | null>(null);
	const [, setRetryTick] = useState(0);
	const { state, stats, rpcState } = conv;
	const live = conv.mode === "live";

	const usage = useMemo(() => (stats ? usageFromStats(stats) : usageFromMessages(state.messages)), [stats, state.messages]);
	const ctx = contextSummary(live ? stats : null, rpcState?.model?.contextWindow);
	const autoCompaction = rpcState?.autoCompactionEnabled ?? true;
	const autoRetry = (conv.convId ? autoRetryByConv.get(conv.convId) : undefined) ?? true;

	const run = async (kind: "clone" | "export" | "jsonl" | "reload", action: () => Promise<void>) => {
		setBusy(kind);
		try {
			await action();
		} catch (e) {
			toast.error(errorMessage(e), { title: kind === "clone" ? "克隆失败" : kind === "reload" ? "重新加载失败" : "导出失败" });
		} finally {
			setBusy(null);
		}
	};

	const clone = () =>
		run("clone", async () => {
			await conv.ensureLive();
			const data = await conv.call({ type: "clone" });
			if (data?.cancelled) toast.info("克隆已被扩展取消");
			else toast.success("已克隆为新会话");
		});

	const exportHtml = () =>
		run("export", async () => {
			const convId = await conv.ensureLive();
			const { blob, fileName } = await exportConversation(convId);
			saveBlob(blob, fileName);
		});

	/** The raw session file: works for saved sessions without starting pi. */
	const exportJsonl = () =>
		run("jsonl", async () => {
			const workspaceId = conv.workspace?.config.id;
			const file = conv.sessionFile;
			if (!workspaceId || !file) throw new Error("会话文件尚未创建");
			const blob = await downloadWorkspaceFile(workspaceId, file);
			saveBlob(blob, file.slice(file.lastIndexOf("/") + 1) || "session.jsonl");
		});

	const reload = () =>
		run("reload", async () => {
			const convId = await conv.ensureLive();
			const res = await reloadConversation(convId);
			if (!res.ok) throw new Error(res.error || (res.cancelled ? "已取消" : "重新加载失败"));
			invalidateCommands(convId);
			toast.success("会话已重新加载，新配置已生效");
			await conv.resync();
		});

	const setAutoCompaction = (enabled: boolean) => {
		(async () => {
			await conv.ensureLive();
			await conv.call({ type: "set_auto_compaction", enabled });
		})().catch((e: unknown) => toast.error(errorMessage(e), { title: "设置失败" }));
	};

	const setAutoRetry = (enabled: boolean) => {
		(async () => {
			const convId = await conv.ensureLive();
			await conv.call({ type: "set_auto_retry", enabled });
			autoRetryByConv.set(convId, enabled);
			setRetryTick((t) => t + 1);
		})().catch((e: unknown) => toast.error(errorMessage(e), { title: "设置失败" }));
	};

	// Restoring is always possible; archiving waits until the conversation is idle.
	const archiveBlocked = archived ? null : archiveBlockedReason(conv.isLive ? conv.info?.status : undefined);

	const home = server?.config.deployed?.home;
	const sessionPath = conv.sessionFile ? tildify(conv.sessionFile, home) : null;

	let ctxNote: string;
	if (!live) ctxNote = "会话未运行，发送消息后显示上下文占用";
	else if (ctx.tokens === null) ctxNote = stats ? "压缩后将在下一次回复时更新" : "正在读取用量…";
	else ctxNote = autoCompaction ? `自动压缩已开启${ctx.remaining !== null ? `，剩余约 ${formatTokens(ctx.remaining)}` : ""}` : "自动压缩已关闭";

	const usageRows: Array<[string, string]> = [
		["输入", formatTokens(usage.input)],
		["输出", formatTokens(usage.output)],
		["缓存读", formatTokens(usage.cacheRead)],
		["缓存写", formatTokens(usage.cacheWrite)],
		["费用", formatCost(usage.cost)],
		["工具调用", formatNumber(usage.toolCalls)],
	];

	return (
		<aside aria-label="会话信息" className={cn("flex min-h-0 flex-col overflow-y-auto border-l border-border bg-panel", className)}>
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
				<SectionLabel as="h2" className="flex-1">
					会话信息
				</SectionLabel>
				<IconButton aria-label="收起会话信息" size="md" variant="subtle" onClick={onClose}>
					<PanelRightClose size={15} strokeWidth={1.8} />
				</IconButton>
			</div>

			{conv.configStale && (
				<Callout
					tone="warning"
					plain
					className="m-3 px-3 py-3"
					title="配置已更新"
					actions={
						<Button variant="warning" size="sm" onClick={reload} loading={busy === "reload"} disabled={state.isRunning} title={state.isRunning ? "运行结束后才能重新加载" : undefined}>
							{state.isRunning ? "运行结束后可重新加载" : "重新加载"}
						</Button>
					}
				>
					Host 刚同步了新的配置（扩展、settings 等），重新加载会话后生效。
				</Callout>
			)}

			<section aria-labelledby={`${conv.convId ?? "s"}-ctx`} className="flex flex-col gap-2.5 border-b border-border px-4 py-3">
				<SectionLabel as="h2" id={`${conv.convId ?? "s"}-ctx`}>
					上下文
				</SectionLabel>
				<div className="flex items-baseline justify-between gap-2">
					<span className="text-xl font-semibold">{ctx.percent !== null ? `${Math.round(ctx.percent)}%` : "—"}</span>
					<span className="text-xs text-fg-2">
						{ctx.tokens !== null ? formatTokens(ctx.tokens) : "—"} / {ctx.window ? formatTokens(ctx.window) : "—"}
					</span>
				</div>
				<ProgressBar
					value={ctx.percent ?? 0}
					label="上下文占用"
					tone={ctx.percent !== null && ctx.percent >= 90 ? "danger" : ctx.percent !== null && ctx.percent >= 75 ? "warning" : "accent"}
				/>
				<span className="text-xs text-fg-3">{ctxNote}</span>
			</section>

			<section aria-labelledby={`${conv.convId ?? "s"}-usage`} className="flex flex-col gap-2 border-b border-border px-4 py-3">
				<SectionLabel as="h2" id={`${conv.convId ?? "s"}-usage`}>
					用量
				</SectionLabel>
				<dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
					{usageRows.map(([k, v]) => (
						<div key={k} className="contents">
							<dt className="text-fg-2">{k}</dt>
							<dd className="m-0 text-right font-mono">{v}</dd>
						</div>
					))}
				</dl>
			</section>

			<section aria-labelledby={`${conv.convId ?? "s"}-session`} className="flex flex-col gap-2.5 px-4 py-3">
				<SectionLabel as="h2" id={`${conv.convId ?? "s"}-session`}>
					会话
				</SectionLabel>
				{sessionPath ? (
					<code className="text-[11.5px] leading-[1.5] break-all text-fg-2" title={conv.sessionFile}>
						{sessionPath}
					</code>
				) : (
					<span className="text-xs text-fg-3">尚未保存，发送第一条消息后创建会话文件</span>
				)}
				<div className="grid grid-cols-2 gap-2">
					<ActionButton icon={<ListTree size={13} strokeWidth={1.8} />} onClick={onOpenTree} disabled={conv.mode === "new"}>
						树视图
					</ActionButton>
					<ActionButton icon={<GitFork size={13} strokeWidth={1.8} />} onClick={onOpenFork} disabled={conv.mode === "new"}>
						Fork
					</ActionButton>
					<ActionButton icon={<CopyIcon size={13} strokeWidth={1.8} />} onClick={() => void clone()} loading={busy === "clone"} disabled={conv.mode === "new"}>
						Clone
					</ActionButton>
					<ActionButton icon={<Layers size={13} strokeWidth={1.8} />} onClick={onOpenCompact} disabled={conv.mode === "new" || state.isCompacting}>
						压缩上下文
					</ActionButton>
					<ActionButton icon={<Download size={13} strokeWidth={1.8} />} onClick={() => void exportHtml()} loading={busy === "export"} disabled={conv.mode === "new"}>
						导出 HTML
					</ActionButton>
					<ActionButton icon={<FileDown size={13} strokeWidth={1.8} />} onClick={() => void exportJsonl()} loading={busy === "jsonl"} disabled={!conv.sessionFile}>
						导出 JSONL
					</ActionButton>
					<ActionButton icon={<Pencil size={13} strokeWidth={1.8} />} onClick={onOpenRename} disabled={conv.mode === "new"}>
						重命名
					</ActionButton>
					<ActionButton
						icon={archived ? <ArchiveRestore size={13} strokeWidth={1.8} /> : <Archive size={13} strokeWidth={1.8} />}
						onClick={onToggleArchive}
						loading={archiveBusy}
						disabled={!conv.session || Boolean(archiveBlocked)}
						title={archiveBlocked ?? undefined}
					>
						{archived ? "恢复会话" : "归档会话"}
					</ActionButton>
					<ActionButton icon={<Trash2 size={13} strokeWidth={1.8} />} onClick={onOpenDelete} disabled={!conv.sessionFile}>
						删除会话
					</ActionButton>
				</div>
				<div className="flex flex-col gap-2 pt-1">
					<ToggleRow label="自动压缩" checked={autoCompaction} onChange={setAutoCompaction} disabled={conv.mode === "new"} />
					<ToggleRow label="自动重试" checked={autoRetry} onChange={setAutoRetry} disabled={conv.mode === "new"} />
				</div>
			</section>
		</aside>
	);
}
