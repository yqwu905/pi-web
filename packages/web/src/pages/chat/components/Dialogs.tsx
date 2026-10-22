import type { ExtensionUIRequest, ExtensionUIResponse } from "@pi-web/shared";
import { Check, Clock, TriangleAlert } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../../api/client";
import { invalidateSessions } from "../../../api/hooks";
import { Button, Field, Input, LoadingBlock, Modal, Textarea, toast } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { formatTokens } from "../../../lib/format";
import type { ConversationHandle } from "../../../stores/conversation";
import { firstSeen, useNow } from "../hooks";

export type DialogRequest = Extract<ExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" }>;

/** Moves the highlighted option of a vertical list with ↑/↓ (wrapping). */
function listKeys(e: KeyboardEvent, count: number, index: number, setIndex: (i: number) => void, onEnter: () => void) {
	if (count === 0) return;
	if (e.key === "ArrowDown") {
		e.preventDefault();
		setIndex((index + 1) % count);
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		setIndex((index - 1 + count) % count);
	} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
		e.preventDefault();
		onEnter();
	}
}

function optionClass(selected: boolean, bordered: boolean) {
	return cn(
		"flex w-full items-center gap-2.5 rounded-md border px-3 text-left text-sm",
		selected ? "border-border-strong bg-selected text-fg" : bordered ? "border-border bg-transparent text-fg-2 hover:text-fg" : "border-transparent bg-transparent text-fg-2 hover:text-fg",
	);
}

// ---------- extension UI dialogs ----------

/** select / confirm / input / editor requests from extensions, with the timeout countdown. */
export function ExtensionUiDialog({ request, onRespond }: { request: DialogRequest; onRespond: (response: ExtensionUIResponse) => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState(0);
	const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
	const seenAt = firstSeen.get(`ui:${request.id}`);
	const now = useNow(250, Boolean(request.timeout));
	const remaining = request.timeout ? Math.max(0, request.timeout - (now - seenAt)) : null;
	const listRef = useRef<HTMLDivElement>(null);

	const respond = async (response: ExtensionUIResponse) => {
		if (busy) return;
		setBusy(true);
		try {
			await onRespond(response);
		} catch (e) {
			toast.error(errorMessage(e), { title: "无法提交回复" });
			setBusy(false);
		}
	};
	const cancel = () => void respond({ type: "extension_ui_response", id: request.id, cancelled: true });
	const submitValue = (v: string) => void respond({ type: "extension_ui_response", id: request.id, value: v });

	useEffect(() => {
		if (request.method === "select") listRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
	}, [request.method, selected]);

	let hint: string;
	if (remaining !== null) hint = remaining > 0 ? `${Math.ceil(remaining / 1000)} 秒后自动${request.method === "confirm" ? "拒绝" : "取消"}` : "已超时";
	else if (request.method === "select") hint = "↑ ↓ 选择 · Enter 确定";
	else if (request.method === "editor") hint = "Ctrl+Enter 保存 · Esc 取消";
	else if (request.method === "input") hint = "Enter 确定 · Esc 取消";
	else hint = "Esc 拒绝";

	let body: ReactNode = null;
	let footer: ReactNode;
	switch (request.method) {
		case "select":
			body = (
				<div ref={listRef} role="group" aria-label={request.title} className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto">
					{request.options.map((option, i) => (
						<button
							key={`${i}-${option}`}
							type="button"
							aria-pressed={i === selected}
							onClick={() => setSelected(i)}
							onDoubleClick={() => submitValue(option)}
							onKeyDown={(e) => listKeys(e, request.options.length, selected, setSelected, () => submitValue(request.options[selected]))}
							className={cn(optionClass(i === selected, true), "min-h-[34px] py-1.5 font-mono text-mono")}
						>
							<span className="min-w-0 flex-1 break-words">{option}</span>
							{i === selected && <Check size={14} strokeWidth={2.2} className="shrink-0 text-accent" aria-hidden="true" />}
						</button>
					))}
				</div>
			);
			footer = (
				<>
					<Button onClick={cancel} disabled={busy}>
						取消
					</Button>
					<Button variant="primary" onClick={() => submitValue(request.options[selected])} loading={busy} disabled={request.options.length === 0}>
						确定
					</Button>
				</>
			);
			break;
		case "confirm":
			body = request.message ? <p className="m-0 text-sm leading-5 break-words whitespace-pre-wrap text-fg-2">{request.message}</p> : null;
			footer = (
				<>
					<Button onClick={() => void respond({ type: "extension_ui_response", id: request.id, confirmed: false })} disabled={busy}>
						拒绝
					</Button>
					<Button variant="primary" data-autofocus onClick={() => void respond({ type: "extension_ui_response", id: request.id, confirmed: true })} loading={busy}>
						允许
					</Button>
				</>
			);
			break;
		case "input":
			body = (
				<form
					id={`ui-${request.id}`}
					onSubmit={(e: FormEvent) => {
						e.preventDefault();
						submitValue(value);
					}}
				>
					<Input mono aria-label={request.title} value={value} placeholder={request.placeholder} onChange={(e) => setValue(e.target.value)} />
				</form>
			);
			footer = (
				<>
					<Button onClick={cancel} disabled={busy}>
						取消
					</Button>
					<Button variant="primary" type="submit" form={`ui-${request.id}`} loading={busy}>
						确定
					</Button>
				</>
			);
			break;
		case "editor":
			body = (
				<Textarea
					mono
					rows={8}
					aria-label={request.title}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							submitValue(value);
						}
					}}
					className="border-border-strong"
				/>
			);
			footer = (
				<>
					<Button onClick={cancel} disabled={busy}>
						取消
					</Button>
					<Button variant="primary" onClick={() => submitValue(value)} loading={busy}>
						保存
					</Button>
				</>
			);
			break;
	}

	return (
		<Modal
			open
			onClose={cancel}
			closeOnOverlay={false}
			hideClose={request.method === "confirm"}
			role={request.method === "confirm" ? "alertdialog" : "dialog"}
			title={request.title}
			icon={request.method === "confirm" ? <TriangleAlert className="text-warning" strokeWidth={1.8} /> : undefined}
			titleAside={
				<span className="flex h-5 shrink-0 items-center rounded-sm border border-border bg-chip px-1.5 text-2xs text-fg-3">扩展</span>
			}
			footerHint={
				<span className="flex items-center gap-1.5">
					{remaining !== null && <Clock size={13} strokeWidth={1.8} aria-hidden="true" />}
					<span aria-live={remaining !== null ? "off" : undefined}>{hint}</span>
				</span>
			}
			footer={footer}
			size="md"
		>
			{body}
		</Modal>
	);
}

// ---------- fork ----------

export function ForkDialog({ open, onClose, conv, onForked }: { open: boolean; onClose: () => void; conv: ConversationHandle; onForked: (text: string) => void }) {
	const [messages, setMessages] = useState<Array<{ entryId: string; text: string }> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	const [busy, setBusy] = useState(false);
	const groupRef = useRef<HTMLDivElement>(null);
	const { ensureLive, call } = conv;

	useEffect(() => {
		if (messages?.length) groupRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
	}, [messages]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setMessages(null);
		setError(null);
		(async () => {
			await ensureLive();
			const data = await call({ type: "get_fork_messages" });
			if (cancelled) return;
			const list = data?.messages ?? [];
			setMessages(list);
			setSelected(Math.max(0, list.length - 1));
		})().catch((e: unknown) => {
			if (!cancelled) setError(errorMessage(e));
		});
		return () => {
			cancelled = true;
		};
	}, [open, ensureLive, call]);

	const fork = async () => {
		const target = messages?.[selected];
		if (!target || busy) return;
		setBusy(true);
		try {
			const data = await call({ type: "fork", entryId: target.entryId });
			if (data?.cancelled) {
				toast.info("Fork 已被扩展取消");
				return;
			}
			onForked(data?.text ?? target.text);
			onClose();
			toast.success("已 Fork 为新会话");
		} catch (e) {
			toast.error(errorMessage(e), { title: "Fork 失败" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			open={open}
			onClose={onClose}
			title="从哪条消息 Fork？"
			description="将复制到该消息为止的对话路径，并把该消息放入输入框以便修改。"
			footerHint="↑ ↓ 选择 · Enter 确认"
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="primary" onClick={() => void fork()} loading={busy} disabled={!messages?.length}>
						Fork
					</Button>
				</>
			}
		>
			{error ? (
				<p className="m-0 text-sm text-danger">{error}</p>
			) : !messages ? (
				<LoadingBlock className="py-6" />
			) : messages.length === 0 ? (
				<p className="m-0 text-sm text-fg-3">当前分支上还没有可以 Fork 的用户消息。</p>
			) : (
				<div ref={groupRef} role="group" aria-label="用户消息" className="flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto rounded-lg border border-border p-1">
					{messages.map((m, i) => (
						<button
							key={m.entryId}
							type="button"
							aria-pressed={i === selected}
							onClick={() => setSelected(i)}
							onDoubleClick={() => void fork()}
							onKeyDown={(e) => {
								listKeys(e, messages.length, selected, setSelected, () => void fork());
								if (e.key === "ArrowDown" || e.key === "ArrowUp") {
									const next = e.key === "ArrowDown" ? (selected + 1) % messages.length : (selected - 1 + messages.length) % messages.length;
									(e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
								}
							}}
							className={cn(optionClass(i === selected, false), "h-9")}
						>
							<span className="w-[38px] shrink-0 font-mono text-[11.5px] text-fg-3">#{i + 1}</span>
							<span className="min-w-0 flex-1 truncate">{m.text}</span>
							{i === selected && <Check size={14} strokeWidth={2.2} className="shrink-0 text-accent" aria-hidden="true" />}
						</button>
					))}
				</div>
			)}
		</Modal>
	);
}

// ---------- compact ----------

export function CompactDialog({ open, onClose, conv }: { open: boolean; onClose: () => void; conv: ConversationHandle }) {
	const [instructions, setInstructions] = useState("");
	const { ensureLive, call } = conv;

	const compact = () => {
		const customInstructions = instructions.trim() || undefined;
		onClose();
		setInstructions("");
		(async () => {
			await ensureLive();
			const result = await call({ type: "compact", customInstructions }, 10 * 60_000);
			const after = result?.estimatedTokensAfter;
			toast.success(
				result?.tokensBefore ? `压缩前 ${formatTokens(result.tokensBefore)} tokens${after !== undefined ? `，压缩后约 ${formatTokens(after)}` : ""}` : "上下文已压缩",
				{ title: "压缩完成" },
			);
		})().catch((e: unknown) => toast.error(errorMessage(e), { title: "压缩失败" }));
	};

	return (
		<Modal
			open={open}
			onClose={onClose}
			title="压缩上下文"
			description="用摘要替换较早的对话内容，释放上下文空间。完整历史仍保留在会话文件中。"
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="primary" type="submit" form="pw-compact-form">
						压缩
					</Button>
				</>
			}
		>
			<form
				id="pw-compact-form"
				onSubmit={(e) => {
					e.preventDefault();
					compact();
				}}
			>
				<Field label="附加指令（可选）" hint="告诉模型摘要时重点保留什么，例如“重点保留代码改动和未完成的任务”。">
					<Textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="留空则使用默认摘要方式" />
				</Field>
			</form>
		</Modal>
	);
}

// ---------- rename ----------

export function RenameDialog({ open, onClose, conv, currentName }: { open: boolean; onClose: () => void; conv: ConversationHandle; currentName: string }) {
	const [name, setName] = useState(currentName);
	const [busy, setBusy] = useState(false);
	const [prevOpen, setPrevOpen] = useState(open);
	if (prevOpen !== open) {
		setPrevOpen(open);
		if (open) setName(currentName);
	}
	const { ensureLive, call } = conv;
	const workspaceId = conv.workspace?.config.id;

	const save = async () => {
		const value = name.trim();
		if (!value || busy) return;
		setBusy(true);
		try {
			await ensureLive();
			await call({ type: "set_session_name", name: value });
			if (workspaceId) void invalidateSessions(workspaceId);
			toast.success("已重命名");
			onClose();
		} catch (e) {
			toast.error(errorMessage(e), { title: "重命名失败" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			open={open}
			onClose={onClose}
			title="重命名会话"
			size="sm"
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="primary" type="submit" form="pw-rename-form" loading={busy} disabled={!name.trim()}>
						保存
					</Button>
				</>
			}
		>
			<form
				id="pw-rename-form"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<Field label="名称">
					<Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="例如：修复数据加载器的内存泄漏" />
				</Field>
			</form>
		</Modal>
	);
}
