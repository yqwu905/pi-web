import type { ImageContent, RpcSlashCommand, ThinkingLevel } from "@pi-web/shared";
import { ChevronDown, ImagePlus, Send, Square, X } from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	type Ref,
	useCallback,
	useEffect,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { errorMessage } from "../../../api/client";
import { Button, IconButton, Spinner, toast } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { formatBytes, formatTokens } from "../../../lib/format";
import { requestNotificationPermission } from "../../../stores/attention";
import type { ConversationHandle } from "../../../stores/conversation";
import { applyCommand, COMMAND_SOURCE_LABELS, classifyInput, insertAt, matchCommands, restoreQueuedText, slashToken, visibleCommands } from "../logic/composer";
import { Picker, type PickerOption } from "./Picker";

export interface ComposerHandle {
	/** Replaces the draft (set_editor_text, fork, tree navigation). */
	setText(text: string): void;
	/** Adds text to the draft at the cursor ("在对话中引用" / "发给 pi 审阅" prefill). */
	insert(text: string): void;
	/** Puts text back in front of the current draft (cleared queue). */
	restore(texts: readonly string[]): void;
	focus(): void;
}

interface PendingImage {
	id: string;
	name: string;
	size: number;
	image: ImageContent;
	/** Object URL of the file for the thumbnail (not the multi-MB data URL on every render). */
	url: string;
}

interface Draft {
	text: string;
	images: PendingImage[];
}

/**
 * Unsent drafts per (workspace, session): the composer unmounts with the chat page (Files /
 * Terminal / Git tabs, another session) and must give the draft back. Text also goes to
 * sessionStorage so it survives a reload; pasted images stay in memory.
 */
const drafts = new Map<string, Draft>();
const DRAFT_STORAGE_PREFIX = "pi-web:draft:";

function loadDraft(key: string): Draft {
	const kept = drafts.get(key);
	if (kept) return kept;
	try {
		return { text: sessionStorage.getItem(DRAFT_STORAGE_PREFIX + key) ?? "", images: [] };
	} catch {
		return { text: "", images: [] };
	}
}

function saveDraft(key: string, draft: Draft): void {
	if (draft.text || draft.images.length > 0) drafts.set(key, draft);
	else drafts.delete(key);
	try {
		if (draft.text) sessionStorage.setItem(DRAFT_STORAGE_PREFIX + key, draft.text);
		else sessionStorage.removeItem(DRAFT_STORAGE_PREFIX + key);
	} catch {
		// storage unavailable: the in-memory draft still works
	}
}

function releaseImages(images: readonly PendingImage[]): void {
	for (const image of images) URL.revokeObjectURL(image.url);
}


const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const commandCache = new Map<string, RpcSlashCommand[]>();

/** Forget cached slash commands of a conversation (after a reload). */
export function invalidateCommands(convId: string | null | undefined): void {
	if (convId) commandCache.delete(convId);
}

function readImage(file: File): Promise<PendingImage> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("无法读取图片"));
		reader.onload = () => {
			const url = String(reader.result ?? "");
			const comma = url.indexOf(",");
			const mimeType = /^data:([^;,]+)/.exec(url)?.[1] ?? (file.type || "image/png");
			resolve({
				id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
				name: file.name || "图片",
				size: file.size,
				image: { type: "image", data: comma >= 0 ? url.slice(comma + 1) : "", mimeType },
				url: URL.createObjectURL(file),
			});
		};
		reader.readAsDataURL(file);
	});
}

function useSlashCommands(conv: ConversationHandle, wanted: boolean) {
	const { ensureLive, call } = conv;
	const liveId = conv.isLive ? conv.convId : null;
	const [loaded, setLoaded] = useState<{ convId: string; commands: RpcSlashCommand[] } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const cached = liveId ? commandCache.get(liveId) : undefined;
	useEffect(() => {
		if (!wanted || (liveId && commandCache.has(liveId))) return;
		let cancelled = false;
		setError(null);
		(async () => {
			const id = await ensureLive();
			const data = await call({ type: "get_commands" });
			const commands = visibleCommands(data.commands ?? []);
			commandCache.set(id, commands);
			if (!cancelled) setLoaded({ convId: id, commands });
		})().catch((e: unknown) => {
			if (!cancelled) setError(errorMessage(e));
		});
		return () => {
			cancelled = true;
		};
	}, [wanted, liveId, ensureLive, call]);
	const commands = cached ?? (loaded && loaded.convId === liveId ? loaded.commands : null);
	return { commands, error };
}

export interface ComposerProps {
	conv: ConversationHandle;
	/** Identifies the draft kept while the composer is unmounted (workspace + session). */
	draftKey: string;
	ref?: Ref<ComposerHandle>;
	/** Runs "!cmd" / "!!cmd". */
	onBash: (command: string, excludeFromContext: boolean) => void;
	bashRunning: boolean;
	onAbortBash: () => void;
	/** Runs before a message or "!cmd" is sent (e.g. restore an archived session); false cancels the send. */
	beforeSend?: () => Promise<boolean>;
}

/**
 * Message composer (Main artboard): "/" command completion, "!cmd" bash, image paste/drag,
 * Enter = send/steer, Alt+Enter = follow-up, Shift+Enter = newline, Esc = take back the
 * queue and abort; model and thinking selectors; queued messages with 撤回.
 */
export function Composer({ conv, draftKey, ref, onBash, bashRunning, onAbortBash, beforeSend }: ComposerProps) {
	const id = useId();
	const [text, setText] = useState(() => loadDraft(draftKey).text);
	const [cursor, setCursor] = useState(0);
	const [images, setImages] = useState<PendingImage[]>(() => loadDraft(draftKey).images);
	const savedKey = useRef(draftKey);
	useEffect(() => {
		// The view followed its conversation to a new session id: the draft moves with it.
		if (savedKey.current !== draftKey) saveDraft(savedKey.current, { text: "", images: [] });
		savedKey.current = draftKey;
		saveDraft(draftKey, { text, images });
	}, [draftKey, text, images]);
	const [dragging, setDragging] = useState(false);
	const [sending, setSending] = useState(false);
	const [aborting, setAborting] = useState(false);
	const [justStarted, setJustStarted] = useState(false);
	const [menuIndex, setMenuIndex] = useState(0);
	const [menuDismissed, setMenuDismissed] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const { state, rpcState } = conv;
	const queue = state.queue;
	const queued = queue.steering.length + queue.followUp.length;
	const running = state.isRunning || justStarted;
	const busy = running || state.isCompacting || bashRunning;

	useImperativeHandle(
		ref,
		() => ({
			setText: (value: string) => {
				setText(value);
				requestAnimationFrame(() => {
					const el = textareaRef.current;
					// Typing that landed before this frame already placed the caret; do not move it back.
					if (!el || el.value !== value) return;
					el.focus();
					el.setSelectionRange(value.length, value.length);
					setCursor(value.length);
				});
			},
			insert: (value: string) => {
				const el = textareaRef.current;
				setText((current) => {
					const next = insertAt(current, el ? el.selectionStart : current.length, value);
					requestAnimationFrame(() => {
						const area = textareaRef.current;
						if (!area || area.value !== next.text) return;
						area.focus();
						area.setSelectionRange(next.cursor, next.cursor);
						setCursor(next.cursor);
					});
					return next.text;
				});
			},
			restore: (texts) => setText((current) => restoreQueuedText(current, texts)),
			focus: () => textareaRef.current?.focus(),
		}),
		[],
	);

	// pi is running once agent_start arrives; until then a sent prompt still counts as running.
	useEffect(() => {
		if (!justStarted) return;
		if (state.isRunning) {
			setJustStarted(false);
			return;
		}
		const timer = setTimeout(() => setJustStarted(false), 5_000);
		return () => clearTimeout(timer);
	}, [justStarted, state.isRunning]);

	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
	}, [text]);

	const token = slashToken(text, cursor);
	const menuWanted = Boolean(token) && menuDismissed !== text;
	const { commands, error: commandsError } = useSlashCommands(conv, menuWanted);
	const matches = useMemo(() => (token && commands ? matchCommands(commands, token.query) : []), [token?.query, commands]);
	const menuOpen = menuWanted && (commands === null || matches.length > 0 || Boolean(commandsError));
	const activeIndex = Math.min(menuIndex, Math.max(0, matches.length - 1));

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const syncCursor = () => setCursor(textareaRef.current?.selectionStart ?? 0);

	const chooseCommand = (command: RpcSlashCommand | undefined) => {
		if (!command || !token) return;
		const next = applyCommand(text, token, command.name);
		setText(next.text);
		setMenuIndex(0);
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			// Keystrokes typed right after the completion (before this frame) must keep their caret.
			if (!el || el.value !== next.text) return;
			el.setSelectionRange(next.cursor, next.cursor);
			setCursor(next.cursor);
		});
	};

	const addFiles = useCallback(async (files: Iterable<File>) => {
		const list = [...files].filter((f) => f.type.startsWith("image/"));
		for (const file of list) {
			if (file.size > MAX_IMAGE_BYTES) {
				toast.warning(`图片 ${file.name} 超过 ${formatBytes(MAX_IMAGE_BYTES)}，已忽略`);
				continue;
			}
			try {
				const image = await readImage(file);
				setImages((prev) => [...prev, image]);
			} catch (e) {
				toast.error(errorMessage(e), { title: "无法读取图片" });
			}
		}
	}, []);

	const send = async (mode?: "followUp") => {
		if (sending) return;
		const input = classifyInput(text, images.length);
		if (input.kind === "empty") return;
		// First send (a user gesture): ask once whether runs may notify when they finish or need input.
		if (input.kind !== "bash") requestNotificationPermission();
		if (beforeSend) {
			setSending(true);
			const proceed = await beforeSend().finally(() => setSending(false));
			if (!proceed) return;
		}
		if (input.kind === "bash") {
			onBash(input.command, input.excludeFromContext);
			setText("");
			return;
		}
		const draft = text;
		const pending = images;
		const inputs = rpcState?.model?.input;
		if (pending.length > 0 && inputs && !inputs.includes("image")) toast.warning("当前模型可能不支持图片输入");
		setText("");
		setImages([]);
		setSending(true);
		try {
			const streamingBehavior = running ? (mode === "followUp" ? "followUp" : "steer") : undefined;
			const res = await conv.prompt(input.message, { images: pending.map((p) => p.image), streamingBehavior });
			if (!res.success) throw new Error(res.error || "发送失败");
			releaseImages(pending);
			if ((res.data as { disposition?: string } | undefined)?.disposition === "started") setJustStarted(true);
		} catch (e) {
			setText((current) => (current.trim() ? `${draft}\n\n${current}` : draft));
			setImages((current) => [...pending, ...current]);
			toast.error(errorMessage(e), { title: "发送失败" });
		} finally {
			setSending(false);
		}
	};

	const takeBackQueue = async () => {
		const data = await conv.call({ type: "clear_queue" });
		const restored = [...(data?.steering ?? []), ...(data?.followUp ?? [])];
		if (restored.length) setText((current) => restoreQueuedText(current, restored));
	};

	const interrupt = async () => {
		if (!conv.isLive || aborting) return;
		setAborting(true);
		try {
			if (queued > 0) await takeBackQueue();
			if (bashRunning) onAbortBash();
			if (state.isRunning || state.isCompacting || justStarted) await conv.call({ type: "abort" });
		} catch (e) {
			toast.error(errorMessage(e), { title: "中止失败" });
		} finally {
			setAborting(false);
			setJustStarted(false);
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		if (menuOpen && matches.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setMenuIndex((activeIndex + 1) % matches.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setMenuIndex((activeIndex - 1 + matches.length) % matches.length);
				return;
			}
			if ((e.key === "Enter" && !e.shiftKey && !e.altKey) || e.key === "Tab") {
				const chosen = matches[activeIndex];
				// Enter on an already complete command name sends instead of re-completing.
				if (e.key === "Tab" || !token || token.query !== chosen.name) {
					e.preventDefault();
					chooseCommand(chosen);
					return;
				}
			}
		}
		if (menuOpen && e.key === "Escape") {
			e.preventDefault();
			setMenuDismissed(text);
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void send(e.altKey ? "followUp" : undefined);
			return;
		}
		if (e.key === "Escape" && (busy || queued > 0)) {
			e.preventDefault();
			void interrupt();
		}
	};

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = [...e.clipboardData.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile());
		const valid = files.filter((f): f is File => f !== null);
		if (valid.length) {
			e.preventDefault();
			void addFiles(valid);
		}
	};

	const onDrop = (e: DragEvent<HTMLDivElement>) => {
		setDragging(false);
		if (!e.dataTransfer.files.length) return;
		e.preventDefault();
		void addFiles(e.dataTransfer.files);
	};

	// ---------- model & thinking ----------

	const lastAssistant = useMemo(() => {
		for (let i = state.messages.length - 1; i >= 0; i--) {
			const m = state.messages[i];
			if (m.role === "assistant") return m as { provider: string; model: string };
		}
		return undefined;
	}, [state.messages]);
	const defaults = conv.workspace?.config.defaults;
	const modelKey = rpcState?.model ? `${rpcState.model.provider}/${rpcState.model.id}` : undefined;
	const modelLabel =
		modelKey ??
		(lastAssistant?.provider ? `${lastAssistant.provider}/${lastAssistant.model}` : undefined) ??
		(defaults?.provider && defaults.modelId ? `${defaults.provider}/${defaults.modelId}` : "默认模型");
	const thinking = state.thinkingLevel ?? rpcState?.thinkingLevel ?? defaults?.thinkingLevel;

	const loadModels = async (): Promise<PickerOption[]> => {
		await conv.ensureLive();
		const { models } = await conv.call({ type: "get_available_models" });
		return (models ?? []).map((m) => ({
			value: `${m.provider}/${m.id}`,
			label: <span className="font-mono text-mono">{m.id}</span>,
			hint: m.contextWindow ? formatTokens(m.contextWindow) : undefined,
			group: m.provider,
			searchText: `${m.provider}/${m.id} ${m.name ?? ""}`,
		}));
	};
	const selectModel = (value: string) => {
		const slash = value.indexOf("/");
		conv.call({ type: "set_model", provider: value.slice(0, slash), modelId: value.slice(slash + 1) }).catch((e: unknown) =>
			toast.error(errorMessage(e), { title: "切换模型失败" }),
		);
	};
	const loadLevels = async (): Promise<PickerOption[]> => {
		await conv.ensureLive();
		const { levels } = await conv.call({ type: "get_available_thinking_levels" });
		return (levels ?? []).map((l) => ({ value: l, label: l }));
	};
	const selectLevel = (value: string) => {
		conv.call({ type: "set_thinking_level", level: value as ThinkingLevel }).catch((e: unknown) => toast.error(errorMessage(e), { title: "设置思考级别失败" }));
	};

	const canSend = !sending && classifyInput(text, images.length).kind !== "empty";
	const hint =
		conv.mode === "readonly"
			? "会话未运行 · 发送消息后自动恢复"
			: running
				? "Enter 插话 · Alt+Enter 追加 · Esc 中止"
				: "Enter 发送 · Shift+Enter 换行";
	const placeholder = conv.mode === "new" ? "输入消息开始新对话…  / 命令与技能 · ! 执行 bash · @ 引用文件" : "继续对话…  / 命令与技能 · ! 执行 bash · @ 引用文件";
	const menuId = `${id}-commands`;

	return (
		<div className="flex flex-col gap-2">
			{queued > 0 && (
				<ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="排队中的消息">
					{[...queue.steering.map((t) => ["steer", t] as const), ...queue.followUp.map((t) => ["followUp", t] as const)].map(([kind, t], i) => (
						<li key={`${kind}-${i}`} className="flex items-center gap-2.5 rounded-lg border border-dashed border-border-strong bg-queue px-2.5 py-2 text-sm">
							<span className={cn("shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-semibold", kind === "steer" ? "bg-selected text-link" : "bg-chip text-fg-2")}>
								{kind === "steer" ? "插话 steer" : "追加 follow-up"}
							</span>
							<span className="min-w-0 flex-1 truncate text-fg-code" title={t}>
								{t}
							</span>
							<Button
								size="sm"
								variant="outline"
								title="撤回排队中的消息并放回输入框"
								onClick={() => takeBackQueue().catch((e: unknown) => toast.error(errorMessage(e), { title: "撤回失败" }))}
							>
								撤回
							</Button>
						</li>
					))}
				</ul>
			)}

			<div
				className={cn("relative flex flex-col rounded-xl border bg-panel transition-colors", dragging ? "border-accent" : "border-border-strong")}
				onDragOver={(e) => {
					if ([...e.dataTransfer.types].includes("Files")) {
						e.preventDefault();
						setDragging(true);
					}
				}}
				onDragLeave={(e) => {
					if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
				}}
				onDrop={onDrop}
			>
				{menuOpen && (
					<div
						ref={listRef}
						id={menuId}
						role="listbox"
						aria-label="命令与技能"
						className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-30 max-h-[280px] overflow-y-auto rounded-lg border border-border-strong bg-panel p-1 shadow-pop"
					>
						{commandsError ? (
							<div className="px-2 py-2 text-xs text-danger">无法加载命令：{commandsError}</div>
						) : commands === null ? (
							<div className="flex items-center gap-2 px-2 py-2 text-xs text-fg-3">
								<Spinner size={12} />
								{conv.isLive ? "加载命令…" : "正在启动会话以加载命令…"}
							</div>
						) : (
							matches.map((c, i) => (
								<div
									key={c.name}
									id={`${id}-cmd-${i}`}
									data-index={i}
									role="option"
									aria-selected={i === activeIndex}
									onMouseDown={(e) => e.preventDefault()}
									onMouseEnter={() => setMenuIndex(i)}
									onClick={() => chooseCommand(c)}
									className={cn("flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1", i === activeIndex ? "bg-selected" : "")}
								>
									<code className="shrink-0 text-mono text-fg">/{c.name}</code>
									<span className="min-w-0 flex-1 truncate text-xs text-fg-3">{c.description}</span>
									<span className="shrink-0 rounded-sm border border-border px-1.5 text-2xs text-fg-2">{COMMAND_SOURCE_LABELS[c.source] ?? c.source}</span>
								</div>
							))
						)}
					</div>
				)}

				{images.length > 0 && (
					<div className="flex flex-wrap gap-2 px-3 pt-3">
						{images.map((img) => (
							<div key={img.id} className="group relative overflow-hidden rounded-md border border-border bg-code">
								<img src={img.url} alt={img.name} title={`${img.name} · ${formatBytes(img.size)}`} className="block size-16 object-cover" />
								<IconButton
									aria-label={`移除图片 ${img.name}`}
									size="xs"
									variant="secondary"
									className="absolute top-1 right-1"
									onClick={() => {
										releaseImages([img]);
										setImages((prev) => prev.filter((p) => p.id !== img.id));
									}}
								>
									<X size={11} strokeWidth={2.2} />
								</IconButton>
							</div>
						))}
					</div>
				)}

				<label htmlFor={`${id}-input`} className="sr-only">
					消息
				</label>
				<textarea
					id={`${id}-input`}
					ref={textareaRef}
					rows={3}
					value={text}
					placeholder={placeholder}
					onChange={(e) => {
						setText(e.target.value);
						setCursor(e.target.selectionStart);
						setMenuIndex(0);
					}}
					onSelect={syncCursor}
					onClick={syncCursor}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={menuOpen}
					aria-controls={menuOpen ? menuId : undefined}
					aria-activedescendant={menuOpen && matches[activeIndex] ? `${id}-cmd-${activeIndex}` : undefined}
					className="min-h-[76px] resize-none border-0 bg-transparent px-3.5 pt-3 pb-1.5 text-base leading-[1.6] text-fg outline-none placeholder:text-fg-3 focus-visible:outline-none"
				/>

				<div className="flex flex-wrap items-center gap-2 px-2 pt-1.5 pb-2">
					<input
						ref={fileRef}
						type="file"
						accept="image/*"
						multiple
						className="hidden"
						onChange={(e) => {
							if (e.target.files) void addFiles(e.target.files);
							e.target.value = "";
						}}
					/>
					<IconButton aria-label="添加图片" size="lg" onClick={() => fileRef.current?.click()}>
						<ImagePlus size={16} strokeWidth={1.7} />
					</IconButton>
					<Picker
						label="选择模型"
						searchable
						searchPlaceholder="搜索模型"
						emptyText="没有可用的模型"
						value={modelKey}
						load={loadModels}
						onSelect={selectModel}
						trigger={(p) => (
							<button
								type="button"
								{...p}
								className="flex h-[30px] max-w-[320px] min-w-0 items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 text-xs text-fg hover:border-border-strong"
							>
								<span className="shrink-0 text-fg-3">模型</span>
								<span className="min-w-0 truncate">{modelLabel}</span>
								<ChevronDown size={10} strokeWidth={2.4} className="shrink-0 text-fg-3" aria-hidden="true" />
							</button>
						)}
					/>
					<Picker
						label="思考级别"
						value={thinking}
						load={loadLevels}
						onSelect={selectLevel}
						panelClassName="w-[180px]"
						trigger={(p) => (
							<button
								type="button"
								{...p}
								className="flex h-[30px] items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 text-xs text-fg hover:border-border-strong"
							>
								<span className="text-fg-3">思考</span>
								{thinking ?? "默认"}
								<ChevronDown size={10} strokeWidth={2.4} className="text-fg-3" aria-hidden="true" />
							</button>
						)}
					/>
					<span className="min-w-0 flex-1 basis-0 truncate text-2xs text-fg-3" title={hint}>
						{hint}
					</span>
					{(busy || queued > 0) && conv.isLive && (
						<Button variant="warning" onClick={() => void interrupt()} loading={aborting} icon={<Square size={11} fill="currentColor" strokeWidth={0} />} title="Esc">
							中止
						</Button>
					)}
					<Button
						variant="primary"
						onClick={() => void send()}
						disabled={!canSend}
						loading={sending}
						icon={<Send size={14} strokeWidth={2.2} />}
					>
						{running ? "插话" : "发送"}
					</Button>
				</div>
			</div>
		</div>
	);
}
