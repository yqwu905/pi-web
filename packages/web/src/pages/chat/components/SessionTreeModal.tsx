import type { SessionTreeNode } from "@pi-web/shared";
import { Check, CornerDownLeft, GitFork, ListTree, Pencil, Search, Tag } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, labelConversationEntry, navigateConversation } from "../../../api/client";
import { Button, Input, LoadingBlock, Modal, Select, Spinner, toast } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { formatTime, formatTokens } from "../../../lib/format";
import { sessionTitle } from "../../../lib/sessions";
import type { ConversationHandle } from "../../../stores/conversation";
import { initialSelection, layoutTree, TREE_FILTERS, TREE_ROLE_LABELS, type TreeFilter, type TreeRole, type TreeRow, treeFromEntries } from "../logic/tree";

const COL = 20;
const MAX_DEPTH = 10;

const TAG_TONES: Record<TreeRole, string> = {
	user: "border-user-border bg-user text-link",
	assistant: "border-border bg-raised text-fg",
	tool: "border-border bg-code text-fg-2",
	bash: "border-border bg-code text-fg-2",
	summary: "border-dashed border-border-strong bg-transparent text-fg-2",
	setting: "border-border bg-transparent text-fg-3",
	custom: "border-dashed border-border bg-transparent text-fg-2",
};

type SummaryMode = "none" | "default" | "custom";

function RoleTag({ role }: { role: TreeRole }) {
	return (
		<span className={cn("inline-flex h-5 w-[34px] shrink-0 items-center justify-center rounded-sm border text-2xs font-semibold", TAG_TONES[role])}>
			{TREE_ROLE_LABELS[role]}
		</span>
	);
}

function LabelTag({ label }: { label: string }) {
	return (
		<span className="inline-flex h-5 max-w-[160px] shrink-0 items-center gap-1 rounded-sm border border-border-strong bg-raised px-1.5 text-2xs font-semibold text-fg">
			<Tag size={10} strokeWidth={2.2} className="shrink-0 text-accent" aria-hidden="true" />
			<span className="truncate">{label}</span>
		</span>
	);
}

function entryTime(node: SessionTreeNode): string {
	const ms = Date.parse(node.entry.timestamp);
	return Number.isFinite(ms) ? formatTime(ms) : "";
}

function entryWhen(node: SessionTreeNode): string {
	const ms = Date.parse(node.entry.timestamp);
	if (!Number.isFinite(ms)) return "";
	const d = new Date(ms);
	const today = new Date();
	const sameDay = d.toDateString() === today.toDateString();
	return sameDay ? `今天 ${formatTime(ms)}` : `${d.getMonth() + 1}月${d.getDate()}日 ${formatTime(ms)}`;
}

function Gutter({ row, selected }: { row: TreeRow; selected: boolean }) {
	const depth = Math.min(row.depth, MAX_DEPTH);
	const x = (col: number) => Math.min(col, MAX_DEPTH) * COL;
	const summary = row.info.role === "summary";
	return (
		<span aria-hidden="true" className="relative shrink-0 self-stretch" style={{ width: (depth + 1) * COL - 4 }}>
			{row.segments.map((s) =>
				s.top || s.bottom ? (
					<span
						key={s.col}
						className="absolute w-px bg-border"
						style={{ left: x(s.col) + 9, top: s.top ? 0 : "50%", bottom: s.bottom ? 0 : "50%" }}
					/>
				) : null,
			)}
			{row.connector && depth > 0 && <span className="absolute h-px bg-border" style={{ left: x(depth - 1) + 10, width: COL - 4, top: "50%" }} />}
			<span
				className={cn(
					"absolute size-[7px]",
					summary ? "rounded-[2px]" : "rounded-full",
					row.onPath ? "bg-accent" : cn("border-[1.5px] border-fg-4", selected ? "bg-selected" : "bg-panel"),
				)}
				style={{ left: depth * COL + 6, top: "calc(50% - 3.5px)" }}
			/>
		</span>
	);
}

export interface SessionTreeModalProps {
	open: boolean;
	onClose: () => void;
	conv: ConversationHandle;
	/** Text pi would put back into the editor (navigating to or forking a user message). */
	onFillComposer: (text: string) => void;
}

/** 会话树 (SessionTree artboard): every branch of the session, filters, preview and navigation. */
export function SessionTreeModal({ open, onClose, conv, onFillComposer }: SessionTreeModalProps) {
	const [filter, setFilter] = useState<TreeFilter>("default");
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [summaryMode, setSummaryMode] = useState<SummaryMode>("default");
	const [instructions, setInstructions] = useState("");
	const [labelDraft, setLabelDraft] = useState<string | null>(null);
	const [busy, setBusy] = useState<"navigate" | "fork" | "label" | null>(null);
	const [liveTree, setLiveTree] = useState<{ convId: string; tree: SessionTreeNode[]; leafId: string | null } | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [reloadTick, setReloadTick] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const { ensureLive, call } = conv;
	const liveId = conv.mode === "live" && conv.isLive ? conv.convId : null;

	useEffect(() => {
		if (!open || !liveId) return;
		let cancelled = false;
		setLoadError(null);
		call({ type: "get_tree" }).then(
			(data) => {
				if (!cancelled) setLiveTree({ convId: liveId, tree: data?.tree ?? [], leafId: data?.leafId ?? null });
			},
			(e: unknown) => {
				if (!cancelled) setLoadError(errorMessage(e));
			},
		);
		return () => {
			cancelled = true;
		};
	}, [open, liveId, call, reloadTick]);

	// Reset per opening.
	const [prevOpen, setPrevOpen] = useState(open);
	if (prevOpen !== open) {
		setPrevOpen(open);
		if (open) {
			setSelectedId(null);
			setLabelDraft(null);
			setQuery("");
		}
	}

	const readOnly = conv.readOnlyFile;
	const readOnlyTree = useMemo(() => (readOnly ? treeFromEntries(readOnly.entries) : null), [readOnly]);
	const source = liveId
		? liveTree && liveTree.convId === liveId
			? { tree: liveTree.tree, leafId: liveTree.leafId }
			: null
		: readOnlyTree
			? { tree: readOnlyTree, leafId: readOnly?.leafId ?? null }
			: null;

	const layout = useMemo(() => (source ? layoutTree(source.tree, { filter, query, leafId: source.leafId }) : null), [source?.tree, source?.leafId, filter, query]);
	const rows = layout?.rows ?? [];
	const selected = (selectedId ? rows.find((r) => r.id === selectedId) : undefined) ?? (layout ? rows.find((r) => r.id === initialSelection(layout, source?.leafId)) : undefined);
	const selectedIndex = selected ? rows.indexOf(selected) : -1;

	useEffect(() => {
		if (!open || !selected) return;
		listRef.current?.querySelector(`[data-row="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: "nearest" });
	}, [open, selected?.id]);

	// Focus the selected row once the tree has loaded so ↑/↓ work right away.
	const focusedOnce = useRef(false);
	useEffect(() => {
		if (!open) {
			focusedOnce.current = false;
			return;
		}
		if (focusedOnce.current || !selected) return;
		focusedOnce.current = true;
		listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(selected.id)}"]`)?.focus({ preventScroll: true });
	}, [open, selected]);

	const focusRow = (index: number) => {
		const row = rows[index];
		if (!row) return;
		setSelectedId(row.id);
		setLabelDraft(null);
		requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.id)}"]`)?.focus());
	};

	const navigate = async (row: TreeRow | undefined = selected) => {
		if (!row || busy || row.isLeaf) return;
		if (conv.state.isRunning) {
			toast.warning("正在运行，结束后才能跳转");
			return;
		}
		setBusy("navigate");
		try {
			const convId = await ensureLive();
			const res = await navigateConversation(convId, {
				targetId: row.id,
				summarize: summaryMode !== "none",
				customInstructions: summaryMode === "custom" && instructions.trim() ? instructions.trim() : undefined,
			});
			if (res.cancelled) {
				toast.info("跳转已取消");
				return;
			}
			if (!res.ok) throw new Error(res.error || "跳转失败");
			if (row.info.editorText) onFillComposer(row.info.editorText);
			toast.success("已跳转到所选位置");
			onClose();
		} catch (e) {
			toast.error(errorMessage(e), { title: "跳转失败" });
		} finally {
			setBusy(null);
		}
	};

	const fork = async () => {
		if (!selected || busy) return;
		setBusy("fork");
		try {
			await ensureLive();
			const data = await call({ type: "fork", entryId: selected.id });
			if (data?.cancelled) {
				toast.info("Fork 已被扩展取消");
				return;
			}
			onFillComposer(data?.text ?? selected.info.editorText ?? "");
			toast.success("已 Fork 为新会话");
			onClose();
		} catch (e) {
			toast.error(errorMessage(e), { title: "Fork 失败" });
		} finally {
			setBusy(null);
		}
	};

	const saveLabel = async (label: string | undefined) => {
		if (!selected || busy) return;
		setBusy("label");
		try {
			const convId = await ensureLive();
			const res = await labelConversationEntry(convId, { entryId: selected.id, label });
			if (!res.ok) throw new Error(res.error || "保存标签失败");
			setLabelDraft(null);
			setReloadTick((t) => t + 1);
			toast.success(label ? "已添加标签" : "已清除标签");
		} catch (e) {
			toast.error(errorMessage(e), { title: "标签失败" });
		} finally {
			setBusy(null);
		}
	};

	const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.target instanceof HTMLInputElement) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			focusRow(Math.min(rows.length - 1, selectedIndex + 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			focusRow(Math.max(0, selectedIndex - 1));
		} else if (e.key === "Home") {
			e.preventDefault();
			focusRow(0);
		} else if (e.key === "End") {
			e.preventDefault();
			focusRow(rows.length - 1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			void navigate();
		}
	};

	const title = conv.state.sessionName || sessionTitle(conv.session, 40);
	const description = layout ? `${title} · ${layout.total} 个条目 · ${layout.branchPoints} 个分叉点 · ${layout.branches} 条分支` : title;
	const info = selected?.info;
	const isUserLike = info?.role === "user" || (info?.role === "custom" && info.editorText !== undefined);
	const node = selected?.node;
	const running = conv.state.isRunning;

	let hint = "从这里继续：把当前位置移到这一条，下一条消息会从这里开出新分支。";
	if (isUserLike) hint = "编辑并重新发送：把这条消息放回输入框，提交后从它的上一条开出新分支。";
	if (selected?.isLeaf) hint = running ? "这里就是当前位置，pi 仍在运行。" : "这里就是当前位置，可以直接继续对话。";

	const meta: Array<[string, string]> = [];
	if (selected && info) {
		meta.push(["条目 ID", selected.id.slice(0, 8)]);
		if (info.model) meta.push(["模型", info.model]);
		if (info.tokens) meta.push(["输出 tokens", formatTokens(info.tokens)]);
		if (info.note) meta.push(["状态", info.note]);
		meta.push(["子条目", String(selected.childCount)]);
	}

	return (
		<Modal
			open={open}
			onClose={onClose}
			size="xl"
			tall
			title="会话树"
			description={description}
			icon={
				<span className="flex size-8 items-center justify-center rounded-md border border-border bg-raised text-accent">
					<ListTree strokeWidth={1.8} />
				</span>
			}
			footerHint={
				<span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
					<label htmlFor="pw-branch-summary" className="text-xs text-fg-2">
						离开当前分支时
					</label>
					<span className="w-[150px] shrink-0">
						<Select
							id="pw-branch-summary"
							size="sm"
							className="text-xs"
							value={summaryMode}
							onChange={(e) => setSummaryMode(e.target.value as SummaryMode)}
							options={[
								{ value: "none", label: "不生成摘要" },
								{ value: "default", label: "默认摘要" },
								{ value: "custom", label: "自定义摘要指令…" },
							]}
						/>
					</span>
					{summaryMode === "custom" ? (
						<Input
							size="sm"
							value={instructions}
							onChange={(e) => setInstructions(e.target.value)}
							placeholder="摘要时重点关注…"
							aria-label="自定义摘要指令"
							wrapperClassName="w-[240px]"
							className="w-[240px]"
						/>
					) : (
						<span className="text-xs text-fg-3">树中保留所有分支，跳转不会删除任何历史。</span>
					)}
				</span>
			}
			footer={
				<>
					{selected && info && (
						<span className="text-xs text-fg-2">
							目标：{TREE_ROLE_LABELS[info.role]} {entryTime(selected.node)}
							{selected.node.label ? ` · ${selected.node.label}` : ""}
						</span>
					)}
					<Button onClick={onClose}>取消</Button>
					<Button
						variant="primary"
						icon={<CornerDownLeft size={14} strokeWidth={2} />}
						onClick={() => void navigate()}
						loading={busy === "navigate"}
						disabled={!selected || selected.isLeaf || running || (busy !== null && busy !== "navigate")}
						title={running ? "正在运行，结束后才能跳转" : selected?.isLeaf ? "已在当前位置" : undefined}
					>
						{busy === "navigate" ? "正在跳转…" : "跳转到此处"}
					</Button>
				</>
			}
		>
			<div className="flex h-full min-h-0 flex-col">
				<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
					<div role="group" aria-label="筛选条目" className="flex flex-wrap gap-1.5">
						{TREE_FILTERS.map((f) => (
							<button
								key={f.value}
								type="button"
								aria-pressed={filter === f.value}
								onClick={() => setFilter(f.value)}
								className={cn(
									"h-7 rounded-md border px-2.5 text-xs",
									filter === f.value ? "border-border-strong bg-selected font-semibold text-fg" : "border-border bg-transparent font-medium text-fg-2 hover:text-fg",
								)}
							>
								{f.label}
							</button>
						))}
					</div>
					<span className="flex-1" />
					{layout && (
						<span className="font-mono text-xs text-fg-3">
							显示 {rows.length} / {layout.total}
						</span>
					)}
					<Input
						size="sm"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="消息、命令或标签"
						aria-label="搜索条目"
						leading={<Search size={14} strokeWidth={1.8} />}
						wrapperClassName="w-[240px] max-w-full flex-[0_1_240px]"
					/>
				</div>

				<div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto bg-border md:flex-row">
					<section aria-label="条目树" className="flex min-h-[300px] min-w-0 flex-[3_1_0%] flex-col bg-panel">
						<div aria-hidden="true" className="flex h-7 shrink-0 items-center gap-2 border-b border-border pr-[18px] pl-4 section-label">
							<span className="flex-1">条目</span>
							<span className="w-10 text-right">tokens</span>
							<span className="w-[38px] text-right">时间</span>
						</div>
						<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2" onKeyDown={onListKeyDown}>
							{loadError ? (
								<p className="m-0 p-3 text-sm text-danger">无法读取会话树：{loadError}</p>
							) : !layout ? (
								<LoadingBlock />
							) : rows.length === 0 ? (
								<p className="m-0 p-3 text-sm text-fg-3">没有符合条件的条目</p>
							) : (
								rows.map((row) => {
									const isSel = row === selected;
									const tool = row.info.role === "tool" || row.info.role === "bash";
									return (
										<button
											key={row.id}
											type="button"
											data-row={row.id}
											aria-pressed={isSel}
											tabIndex={isSel ? 0 : -1}
											onClick={() => {
												setSelectedId(row.id);
												setLabelDraft(null);
											}}
											onDoubleClick={() => void navigate(row)}
											className={cn(
												"flex min-h-[34px] w-full items-center gap-2 rounded-md border-0 py-0 pr-2.5 pl-2 text-left text-sm",
												isSel ? "bg-selected" : "bg-transparent hover:bg-raised",
												row.onPath ? "text-fg" : "text-fg-2",
											)}
										>
											<Gutter row={row} selected={isSel} />
											<RoleTag role={row.info.role} />
											<span className="flex min-w-0 flex-1 items-center gap-1.5">
												{row.info.lead && (
													<span className={cn("shrink-0 font-semibold", tool ? "font-mono text-xs text-fg-2" : "")}>{row.info.lead}</span>
												)}
												<span className={cn("min-w-0 flex-1 truncate", tool && "font-mono text-xs", tool && (row.onPath ? "text-fg-code" : "text-fg-2"), row.info.role === "setting" && "text-fg-2")}>
													{row.info.text}
												</span>
											</span>
											{row.info.note && (
												<span className={cn("inline-flex h-5 shrink-0 items-center rounded-sm border border-border px-1.5 text-2xs", row.info.isError ? "text-danger" : "text-fg-2")}>
													{row.info.note}
												</span>
											)}
											{row.node.label && <LabelTag label={row.node.label} />}
											{row.isLeaf && running && (
												<span className="inline-flex shrink-0 items-center gap-1 text-2xs text-link">
													<Spinner size={10} />
													运行中
												</span>
											)}
											{row.isLeaf && (
												<span className="inline-flex h-5 shrink-0 items-center rounded-sm border border-primary bg-user px-1.5 text-2xs font-semibold text-link">当前位置</span>
											)}
											<span className="w-10 shrink-0 text-right font-mono text-[11.5px] text-fg-3">{row.info.tokens ? formatTokens(row.info.tokens) : ""}</span>
											<span className="w-[38px] shrink-0 text-right font-mono text-[11.5px] text-fg-3">{entryTime(row.node)}</span>
											<span className="sr-only">{row.onPath ? "（当前路径）" : "（其他分支）"}</span>
										</button>
									);
								})
							)}
						</div>
						<div className="flex shrink-0 flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-border px-4 py-2 text-2xs text-fg-3">
							<span className="flex items-center gap-1.5">
								<span aria-hidden="true" className="size-[7px] rounded-full bg-accent" />
								当前路径
							</span>
							<span className="flex items-center gap-1.5">
								<span aria-hidden="true" className="size-[7px] rounded-full border-[1.5px] border-fg-4" />
								其他分支
							</span>
							<span className="flex items-center gap-1.5">
								<span aria-hidden="true" className="size-[7px] rounded-[2px] bg-accent" />
								摘要条目
							</span>
							<span className="flex-1" />
							<span>↑ ↓ 选择 · Enter 跳转 · Esc 关闭</span>
						</div>
					</section>

					<section aria-labelledby="pw-tree-preview-title" className="flex min-h-[300px] min-w-0 flex-[2_1_0%] flex-col bg-panel">
						{!selected || !info || !node ? (
							<div className="flex flex-1 items-center justify-center p-6 text-sm text-fg-3">选择一个条目查看详情</div>
						) : (
							<>
								<div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-3">
									<div className="flex flex-wrap items-center gap-2">
										<RoleTag role={info.role} />
										<h3 id="pw-tree-preview-title" className="m-0 text-base font-semibold">
											{info.kind}
										</h3>
										{node.label && <LabelTag label={node.label} />}
										<span className="flex-1" />
										<span className="font-mono text-xs text-fg-3">{entryWhen(node)}</span>
									</div>
									<div className="flex items-center gap-1.5 text-xs text-fg-2">
										<span aria-hidden="true" className={cn("size-[7px] shrink-0 rounded-full", selected.onPath ? "bg-accent" : "border-[1.5px] border-fg-4")} />
										{selected.onPath ? "在当前路径上" : "不在当前路径"}
									</div>
								</div>

								<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3.5">
									{info.role === "tool" || info.role === "bash" ? (
										<pre className="m-0 rounded-lg border border-border bg-code px-3 py-2.5 font-mono text-xs leading-[1.6] break-words whitespace-pre-wrap text-fg-code">
											{info.full}
										</pre>
									) : (
										<div
											className={cn(
												"rounded-lg border px-3.5 py-3 text-sm leading-[1.7] break-words whitespace-pre-wrap text-fg",
												info.role === "user" ? "border-user-border bg-user" : "border-border bg-bg",
											)}
										>
											{info.full}
										</div>
									)}
									<div className="flex flex-col gap-1">
										<span className="section-label">详情</span>
										<dl className="m-0 flex flex-col">
											{meta.map(([k, v]) => (
												<div key={k} className="flex items-baseline justify-between gap-3 py-1 text-xs">
													<dt className="shrink-0 text-fg-3">{k}</dt>
													<dd className="m-0 min-w-0 text-right font-mono break-all text-fg-code">{v}</dd>
												</div>
											))}
										</dl>
									</div>
								</div>

								<div className="flex shrink-0 flex-col gap-2.5 border-t border-border px-4 py-3">
									<span className="text-xs leading-[1.6] text-fg-2">{hint}</span>
									{labelDraft !== null ? (
										<form
											className="flex flex-wrap items-center gap-2"
											onSubmit={(e) => {
												e.preventDefault();
												void saveLabel(labelDraft.trim() || undefined);
											}}
										>
											<Input
												size="sm"
												autoFocus
												value={labelDraft}
												onChange={(e) => setLabelDraft(e.target.value)}
												placeholder="标签名称"
												aria-label="标签名称"
												maxLength={80}
												wrapperClassName="flex-1"
												className="min-w-[140px] flex-1"
												onKeyDown={(e) => {
													if (e.key === "Escape") {
														e.preventDefault();
														e.stopPropagation();
														setLabelDraft(null);
													}
												}}
											/>
											<Button size="sm" variant="primary" type="submit" loading={busy === "label"} icon={<Check size={13} strokeWidth={2} />}>
												保存
											</Button>
											{node.label && (
												<Button size="sm" variant="ghost" onClick={() => void saveLabel(undefined)} disabled={busy !== null}>
													清除
												</Button>
											)}
											<Button size="sm" variant="ghost" onClick={() => setLabelDraft(null)}>
												取消
											</Button>
										</form>
									) : (
										<div className="flex flex-wrap gap-2">
											{!selected.isLeaf && (
												<Button
													variant="primary"
													icon={isUserLike ? <Pencil size={13} strokeWidth={2} /> : <CornerDownLeft size={13} strokeWidth={2} />}
													onClick={() => void navigate()}
													loading={busy === "navigate"}
													disabled={running || (busy !== null && busy !== "navigate")}
												>
													{isUserLike ? "编辑并重新发送" : "从这里继续"}
												</Button>
											)}
											{info.role === "user" && (
												<Button icon={<GitFork size={13} strokeWidth={1.8} />} onClick={() => void fork()} loading={busy === "fork"} disabled={busy !== null && busy !== "fork"}>
													Fork 为新会话
												</Button>
											)}
											<Button icon={<Tag size={13} strokeWidth={1.8} />} onClick={() => setLabelDraft(node.label ?? "")} disabled={busy !== null}>
												{node.label ? "编辑标签" : "添加标签"}
											</Button>
										</div>
									)}
								</div>
							</>
						)}
					</section>
				</div>
			</div>
		</Modal>
	);
}
