import type { ConversationState } from "@pi-web/shared";
import { Archive, ArchiveRestore, RotateCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button, IconButton, Spinner } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { formatRelativeTime } from "../../../lib/format";
import { firstSeen, useNow } from "../hooks";
import { stripAnsi } from "../logic/composer";

/** Extension statuses (setStatus) as chips above the composer, e.g. "token-meter 本轮 18.2k tokens". */
export function ExtensionStatuses({ statuses }: { statuses: Record<string, string> }) {
	// "pi-web:" keys are Pi-Web's own (companion extension data such as the todo panel's), not chips.
	const entries = Object.entries(statuses).filter(([key, text]) => text && !key.startsWith("pi-web:"));
	if (entries.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-2 text-xs text-fg-2" aria-label="扩展状态">
			{entries.map(([key, text]) => (
				<span key={key} className="flex max-w-full items-center gap-1.5 rounded-sm border border-border bg-panel px-2 py-[3px]">
					<span className="shrink-0 text-fg-3">{key}</span>
					<span className="min-w-0 truncate">{stripAnsi(text)}</span>
				</span>
			))}
		</div>
	);
}

/** Extension widgets (setWidget) for one placement. */
export function ExtensionWidgets({ widgets, placement }: { widgets: ConversationState["ui"]["widgets"]; placement: "aboveEditor" | "belowEditor" }) {
	const list = Object.entries(widgets).filter(([, w]) => w.placement === placement && w.lines.length > 0);
	if (list.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5">
			{list.map(([key, w]) => (
				<pre
					key={key}
					aria-label={`扩展组件 ${key}`}
					className="m-0 max-h-40 overflow-auto rounded-md border border-border bg-panel px-3 py-2 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-fg-2"
				>
					{w.lines.map(stripAnsi).join("\n")}
				</pre>
			))}
		</div>
	);
}

function Banner({ tone, children, onDismiss }: { tone: "accent" | "warning" | "danger"; children: ReactNode; onDismiss?: () => void }) {
	return (
		<div
			role={tone === "danger" ? "alert" : "status"}
			className={cn(
				"flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm",
				tone === "accent" && "border-user-border bg-user text-fg-2",
				tone === "warning" && "border-warning-border bg-warning-soft text-warning-body",
				tone === "danger" && "border-danger/40 bg-danger-soft text-danger",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">{children}</div>
			{onDismiss && (
				<IconButton aria-label="关闭提示" size="xs" variant="subtle" onClick={onDismiss}>
					<X size={12} strokeWidth={2} />
				</IconButton>
			)}
		</div>
	);
}

export function RetryBanner({ retry, onStop }: { retry: NonNullable<ConversationState["retry"]>; onStop: () => void }) {
	const seenAt = firstSeen.get(`retry:${retry.attempt}:${retry.maxAttempts}:${retry.errorMessage}`);
	const now = useNow(500, true);
	const left = Math.max(0, retry.delayMs - (now - seenAt));
	return (
		<Banner tone="warning">
			<RotateCw size={14} strokeWidth={2} className="shrink-0 text-warning" aria-hidden="true" />
			<span className="font-semibold text-warning-fg">
				请求失败，第 {retry.attempt}/{retry.maxAttempts} 次重试{left > 0 ? `将在 ${Math.ceil(left / 1000)} 秒后开始` : "进行中"}
			</span>
			<span className="min-w-0 flex-1 truncate text-xs" title={retry.errorMessage}>
				{retry.errorMessage}
			</span>
			<Button size="sm" variant="warning" onClick={onStop}>
				停止重试
			</Button>
		</Banner>
	);
}

export function CompactingBanner() {
	return (
		<Banner tone="accent">
			<Spinner size={12} />
			<span>正在压缩上下文…</span>
		</Banner>
	);
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
	return (
		<Banner tone="danger" onDismiss={onDismiss}>
			<span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{message}</span>
		</Banner>
	);
}

export function ExitedBanner({ exited, onDismiss }: { exited: NonNullable<ConversationState["exited"]>; onDismiss: () => void }) {
	const reason = exited.signal ? `信号 ${exited.signal}` : `退出码 ${exited.code ?? "未知"}`;
	return (
		<Banner tone="danger" onDismiss={onDismiss}>
			<span className="font-semibold">pi 进程已异常退出（{reason}）</span>
			<span className="text-xs text-fg-2">发送消息会重新启动会话。</span>
			{exited.stderrTail && (
				<details className="w-full">
					<summary className="cursor-pointer text-xs text-fg-2">查看 stderr</summary>
					<pre className="m-0 mt-1.5 max-h-48 overflow-auto rounded-md bg-code px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-fg-code">
						{stripAnsi(exited.stderrTail)}
					</pre>
				</details>
			)}
		</Banner>
	);
}

/** Top of an archived session's chat: archived sessions are hidden in Pi-Web until restored (sending restores too). */
export function ArchivedBanner({ archivedAt, restoring, onRestore }: { archivedAt: number; restoring: boolean; onRestore: () => void }) {
	return (
		<div role="status" className="flex shrink-0 items-center gap-2.5 border-b border-border bg-panel px-4 py-2 sm:px-6">
			<Archive size={14} strokeWidth={1.8} className="shrink-0 text-fg-3" aria-hidden="true" />
			<span className="text-sm font-semibold text-fg">此会话已归档</span>
			<span className="min-w-0 flex-1 truncate text-xs text-fg-3">归档于 {formatRelativeTime(archivedAt)} · 发送消息会自动恢复</span>
			<Button size="sm" variant="outline" icon={<ArchiveRestore size={13} strokeWidth={1.8} />} loading={restoring} onClick={onRestore}>
				恢复
			</Button>
		</div>
	);
}
