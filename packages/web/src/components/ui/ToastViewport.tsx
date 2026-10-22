import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { type Toast, type ToastTone, useToastsStore } from "../../stores/toasts";
import { IconButton } from "./IconButton";

const TONE: Record<ToastTone, { label: string; tag: string; icon: ReactNode }> = {
	info: { label: "信息", tag: "bg-selected text-link", icon: <Info size={16} strokeWidth={1.8} className="text-accent" /> },
	success: { label: "成功", tag: "bg-success-soft text-success-fg", icon: <CircleCheck size={16} strokeWidth={1.8} className="text-success" /> },
	warning: { label: "警告", tag: "bg-warning-strong text-warning-fg", icon: <TriangleAlert size={16} strokeWidth={1.8} className="text-warning" /> },
	error: { label: "错误", tag: "bg-danger-soft text-danger", icon: <CircleX size={16} strokeWidth={1.8} className="text-danger" /> },
};

function ToastItem({ toast }: { toast: Toast }) {
	const dismiss = useToastsStore((s) => s.dismiss);
	const tone = TONE[toast.tone];
	return (
		<div
			role={toast.tone === "error" ? "alert" : "status"}
			className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border-strong bg-panel py-2.5 pr-2 pl-3 shadow-pop"
		>
			<span aria-hidden="true" className="mt-0.5 shrink-0">
				{tone.icon}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex h-4 items-center gap-1.5">
					<span className={cn("h-4 rounded-sm px-1.5 text-2xs leading-4 font-semibold", tone.tag)}>{toast.title ?? tone.label}</span>
					{toast.source && <code className="truncate text-[11.5px] leading-4 text-fg-3">[{toast.source}]</code>}
				</div>
				<span className="text-sm break-words text-fg">{toast.message}</span>
				{toast.action && (
					<button
						type="button"
						className="self-start bg-transparent p-0 text-xs text-link hover:text-link-hover"
						onClick={() => {
							toast.action?.onClick();
							dismiss(toast.id);
						}}
					>
						{toast.action.label}
					</button>
				)}
			</div>
			<IconButton aria-label="关闭" variant="subtle" size="sm" onClick={() => dismiss(toast.id)}>
				<X size={14} strokeWidth={2} />
			</IconButton>
		</div>
	);
}

/**
 * Toast stack at the top right, over the header's status badges (mounted once by the AppShell).
 * Not bottom-right, where it covered the composer's 发送 button and the settings save bars, and
 * not below the header, where it covered the pages' action buttons.
 */
export function ToastViewport() {
	const toasts = useToastsStore((s) => s.toasts);
	return (
		<div
			aria-live="polite"
			className="pointer-events-none fixed top-2 right-4 z-[60] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2"
		>
			{toasts.map((t) => (
				<ToastItem key={t.id} toast={t} />
			))}
		</div>
	);
}
