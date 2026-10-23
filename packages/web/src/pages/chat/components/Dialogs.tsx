import type { ExtensionUIRequest, ExtensionUIResponse } from "@pi-web/shared";
import { Check, Clock, TriangleAlert } from "lucide-react";
import { type FormEvent, Fragment, type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { errorMessage } from "../../../api/client";
import { invalidateSessions } from "../../../api/hooks";
import { Button, Field, Input, LoadingBlock, Modal, Textarea, toast } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { formatTokens } from "../../../lib/format";
import { type ConversationHandle, dialogDeadline } from "../../../stores/conversation";
import { firstSeen, useNow } from "../hooks";
import { splitDialogTitle } from "../logic/dialog-title";
import { AUTO_ANSWER_TTL_MS, type PendingAutoAnswer, answerExcerpt, decideAutoAnswer, isFreeInputOption } from "../logic/free-answer";
import { DeleteSessionModal, type DeleteSessionTarget } from "./DeleteSessionModal";

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
/** Activations right after an unsolicited dialog opened are ignored: an Enter meant for the composer must not answer it. */
const ARM_DELAY_MS = 400;

/** A key press that types one character (typing it in a select's option list starts a free-text answer). */
function isTypedCharacter(e: KeyboardEvent): boolean {
	return !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing && e.key !== " " && [...e.key].length === 1;
}

/** What the user typed before a submission failed; the dialog comes back with it. */
export interface DialogDraft {
	text: string;
	/** Select: the free-input option the text belonged to. */
	option?: string;
}

export function ExtensionUiDialog({
	request,
	onRespond,
	onAnswerText,
	draft,
}: {
	request: DialogRequest;
	onRespond: (response: ExtensionUIResponse) => Promise<unknown>;
	/**
	 * Answers a select with a free-input option ("Type something.") plus the text typed into the
	 * inline field under it, for the extension's follow-up input request. Enables that field.
	 */
	onAnswerText?: (response: ExtensionUIResponse, text: string) => Promise<void>;
	draft?: DialogDraft;
}) {
	const freeInput = request.method === "select" && onAnswerText ? request.options.map(isFreeInputOption) : [];
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState(() => (request.method === "select" && draft?.option !== undefined ? Math.max(0, request.options.indexOf(draft.option)) : 0));
	// input / editor: the answer; select: the free-text answer in the inline field.
	const [value, setValue] = useState(draft?.text ?? (request.method === "editor" ? (request.prefill ?? "") : ""));
	const [openedAt] = useState(() => Date.now());
	/**
	 * Select: keys typed in the option list are ignored until then. Each ignored key restarts the
	 * wait, so the rest of something being typed elsewhere (the composer) when the dialog opened is
	 * dropped instead of starting a free-text answer.
	 */
	const typingArmedAt = useRef(openedAt + ARM_DELAY_MS);
	const optionIdBase = useId();
	// pi's timer started when it asked (possibly before this tab saw the dialog, or while another dialog was shown).
	const deadline = request.timeout ? (dialogDeadline(request.id) ?? firstSeen.get(`ui:${request.id}`) + request.timeout) : null;
	const now = useNow(250, Boolean(request.timeout));
	const remaining = deadline !== null ? Math.max(0, deadline - now) : null;
	const expired = remaining === 0;
	const listRef = useRef<HTMLDivElement>(null);
	const fieldRef = useRef<HTMLInputElement>(null);
	const { heading, detail } = splitDialogTitle(request.title);

	const respond = async (response: ExtensionUIResponse, text?: string) => {
		if (busy) return;
		// pi already took the default answer; the dialog closes once that arrives.
		if (expired && !("cancelled" in response)) return;
		if (!("cancelled" in response) && Date.now() - openedAt < ARM_DELAY_MS) return;
		setBusy(true);
		try {
			await (text !== undefined && onAnswerText ? onAnswerText(response, text) : onRespond(response));
		} catch (e) {
			toast.error(errorMessage(e), { title: "无法提交回复" });
			setBusy(false);
		}
	};
	const cancel = () => void respond({ type: "extension_ui_response", id: request.id, cancelled: true });
	const submitValue = (v: string) => void respond({ type: "extension_ui_response", id: request.id, value: v });
	/** Select: a free-input option with text typed is answered together with that text. */
	const submitOption = (i: number) => {
		if (request.method !== "select" || i >= request.options.length) return;
		const option = request.options[i];
		if (freeInput[i] && value.trim()) void respond({ type: "extension_ui_response", id: request.id, value: option }, value);
		else submitValue(option);
	};

	const focusSelected = () => listRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
	/** Highlights option i and focuses it, or the inline field when it is a free-input option. */
	const highlight = (i: number) => {
		flushSync(() => setSelected(i));
		if (freeInput[i]) fieldRef.current?.focus();
		else focusSelected();
	};
	// Typing in the option list goes to the highlighted free-input option, else the last one.
	const freeIndex = freeInput[selected] ? selected : freeInput.lastIndexOf(true);
	const typeIntoField = (text: string) => {
		flushSync(() => {
			setSelected(freeIndex);
			setValue((v) => v + text);
		});
		const field = fieldRef.current;
		field?.focus();
		field?.setSelectionRange(field.value.length, field.value.length);
	};

	useEffect(() => {
		if (request.method !== "select") return;
		if (draft && fieldRef.current) fieldRef.current.focus();
		else focusSelected();
		// Only when the dialog opens: later moves focus with the highlight.
	}, [request.method]);

	let hint: string;
	if (remaining !== null) hint = remaining > 0 ? `${Math.ceil(remaining / 1000)} 秒后自动${request.method === "confirm" ? "拒绝" : "取消"}` : "已超时，pi 已按默认处理";
	else if (request.method === "select") hint = freeIndex >= 0 ? "↑ ↓ 选择 · Enter 确定 · 直接输入可自定义回答" : "↑ ↓ 选择 · Enter 确定";
	else if (request.method === "editor") hint = "Ctrl+Enter 保存 · Esc 取消";
	else if (request.method === "input") hint = "Enter 确定 · Esc 取消";
	else hint = "Esc 拒绝";

	let body: ReactNode = null;
	let footer: ReactNode;
	switch (request.method) {
		case "select":
			body = (
				<div ref={listRef} role="group" aria-label={heading} className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto">
					{request.options.map((option, i) => (
						<Fragment key={`${i}-${option}`}>
							<button
								type="button"
								id={`${optionIdBase}-${i}`}
								aria-pressed={i === selected}
								onClick={() => highlight(i)}
								onDoubleClick={() => submitOption(i)}
								onKeyDown={(e) => {
									const typed = isTypedCharacter(e) || e.key === "Process";
									if (freeIndex >= 0 && (typed || e.key === " ") && Date.now() < typingArmedAt.current) {
										typingArmedAt.current = Date.now() + ARM_DELAY_MS;
										if (e.key !== "Process") e.preventDefault();
										return;
									}
									if (freeIndex >= 0 && typed) {
										// An IME keystroke ("Process") is left to the browser: the composition continues in the field.
										if (e.key !== "Process") e.preventDefault();
										typeIntoField(e.key === "Process" ? "" : e.key);
										return;
									}
									listKeys(e, request.options.length, selected, highlight, () => submitOption(selected));
								}}
								className={cn(optionClass(i === selected, true), "min-h-[34px] py-1.5 font-mono text-mono")}
							>
								<span className="min-w-0 flex-1 break-words">{option}</span>
								{i === selected && <Check size={14} strokeWidth={2.2} className="shrink-0 text-accent" aria-hidden="true" />}
							</button>
							{freeInput[i] && i === selected && (
								<Input
									ref={fieldRef}
									mono
									aria-label="自定义回答"
									aria-describedby={`${optionIdBase}-${i}`}
									placeholder="输入你的回答，Enter 提交"
									value={value}
									onChange={(e) => setValue(e.target.value)}
									onKeyDown={(e) => {
										if (e.nativeEvent.isComposing) return;
										if (e.key === "Enter") {
											e.preventDefault();
											submitOption(i);
										} else if (e.key === "Escape") {
											// Back to the list; Esc there cancels the dialog.
											e.preventDefault();
											focusSelected();
										} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
											e.preventDefault();
											const count = request.options.length;
											highlight(e.key === "ArrowDown" ? (i + 1) % count : (i - 1 + count) % count);
										}
									}}
									className="shrink-0 border-border-strong"
								/>
							)}
						</Fragment>
					))}
				</div>
			);
			footer = (
				<>
					<Button onClick={cancel} disabled={busy}>
						取消
					</Button>
					<Button variant="primary" onClick={() => submitOption(selected)} loading={busy} disabled={request.options.length === 0 || expired}>
						确定
					</Button>
				</>
			);
			break;
		case "confirm":
			body = request.message ? <p className="m-0 text-sm leading-5 break-words whitespace-pre-wrap text-fg-2">{request.message}</p> : null;
			// Focus starts on 拒绝: the dialog appears unasked, often while the user is typing.
			footer = (
				<>
					<Button data-autofocus onClick={() => void respond({ type: "extension_ui_response", id: request.id, confirmed: false })} disabled={busy || expired}>
						拒绝
					</Button>
					<Button variant="primary" onClick={() => void respond({ type: "extension_ui_response", id: request.id, confirmed: true })} loading={busy} disabled={expired}>
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
					<Input mono aria-label={heading} value={value} placeholder={request.placeholder} onChange={(e) => setValue(e.target.value)} />
				</form>
			);
			footer = (
				<>
					<Button onClick={cancel} disabled={busy}>
						取消
					</Button>
					<Button variant="primary" type="submit" form={`ui-${request.id}`} loading={busy} disabled={expired}>
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
					aria-label={heading}
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
					<Button variant="primary" onClick={() => submitValue(value)} loading={busy} disabled={expired}>
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
			title={heading}
			description={detail ? <span className="block max-h-[30vh] overflow-y-auto font-mono text-mono break-words whitespace-pre-wrap">{detail}</span> : undefined}
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

const NO_DIALOGS: readonly DialogRequest[] = [];

/**
 * The conversation's pending extension dialog. A select answered with typed text leaves a pending
 * auto-answer: the extension's next input/editor request of this conversation gets that text
 * without being shown; if it asks for something else (or nothing within a minute) the text is dropped.
 */
export function ExtensionUiDialogs({ conv }: { conv: ConversationHandle }) {
	const pending = conv.isLive ? (conv.state.ui.pending as DialogRequest[]) : NO_DIALOGS;
	const { convId, uiResponse } = conv;
	const [autoAnswer, setAutoAnswer] = useState<PendingAutoAnswer | null>(null);
	/** Bumped when a waiting auto-answer reaches its deadline. */
	const [expiryTick, setExpiryTick] = useState(0);
	const [draft, setDraft] = useState<(DialogDraft & { id: string }) | null>(null);
	const latestPending = useRef(pending);
	useLayoutEffect(() => {
		latestPending.current = pending;
	});

	const dialogs = useMemo(() => pending.map((r) => ({ id: r.id, method: r.method, deadline: dialogDeadline(r.id) })), [pending]);
	// The request about to be answered is never rendered (no flash).
	const decision = autoAnswer ? decideAutoAnswer(autoAnswer, convId, dialogs, Date.now()) : null;
	const hiddenId = decision?.action === "answer" ? decision.dialogId : null;

	useEffect(() => {
		if (!autoAnswer) return;
		const now = Date.now();
		const next = decideAutoAnswer(autoAnswer, convId, dialogs, now);
		if (next.action === "wait") {
			const timer = setTimeout(() => setExpiryTick((n) => n + 1), autoAnswer.createdAt + AUTO_ANSWER_TTL_MS - now);
			return () => clearTimeout(timer);
		}
		setAutoAnswer(null);
		if (next.action === "drop") {
			toast.warning(`扩展没有请求文字输入，你输入的内容未被使用：“${answerExcerpt(autoAnswer.text)}”`);
			return;
		}
		const { text } = autoAnswer;
		// Shown with the text filled in if the answer fails and the request comes back.
		setDraft({ id: next.dialogId, text });
		uiResponse({ type: "extension_ui_response", id: next.dialogId, value: text }).catch((e: unknown) => toast.error(errorMessage(e), { title: "无法提交回复" }));
	}, [autoAnswer, expiryTick, convId, dialogs, uiResponse]);

	const answerText = useCallback(
		async (response: ExtensionUIResponse, text: string) => {
			if (!convId) {
				await uiResponse(response);
				return;
			}
			// Registered before the answer is sent: the follow-up request can arrive before the POST returns.
			const entry: PendingAutoAnswer = { convId, text, seenIds: [...latestPending.current.map((r) => r.id), response.id], createdAt: Date.now() };
			const forget = () => setAutoAnswer((current) => (current === entry ? null : current));
			setAutoAnswer(entry);
			setDraft({ id: response.id, text, option: "value" in response ? response.value : undefined });
			let delivered: boolean;
			try {
				delivered = await uiResponse(response);
			} catch (e) {
				forget();
				throw e;
			}
			// Answered in another tab or timed out: no follow-up request of this select will come.
			if (!delivered) {
				forget();
				toast.warning(`对话框已被回答或已超时，你输入的内容未被使用：“${answerExcerpt(text)}”`);
			}
		},
		[convId, uiResponse],
	);

	const request = pending.find((r) => r.id !== hiddenId);
	if (!request) return null;
	return (
		<ExtensionUiDialog key={request.id} request={request} onRespond={uiResponse} onAnswerText={answerText} draft={draft?.id === request.id ? draft : undefined} />
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

/** Moves the session file to the server's trash (`~/.pi-web/trash`), stopping its pi process first. */
export function DeleteSessionDialog({
	open,
	onClose,
	conv,
	title,
	onDeleted,
}: {
	open: boolean;
	onClose: () => void;
	conv: ConversationHandle;
	title: string;
	onDeleted: () => void;
}) {
	const target: DeleteSessionTarget = {
		serverId: conv.serverId,
		sessionFile: conv.sessionFile,
		workspaceId: conv.workspace?.config.id,
		sessionIds: [conv.sessionId, conv.session?.id].filter((id): id is string => Boolean(id)),
		isLive: conv.isLive,
		stop: () => conv.stop(),
	};
	return <DeleteSessionModal open={open} onClose={onClose} target={target} title={title} onDeleted={onDeleted} />;
}
