/**
 * Session tree logic for the 会话树 modal: building pi's tree from raw entries (read-only
 * sessions), the filters of pi's /tree selector, and a row layout with guide lines.
 *
 * Layout: a single-child chain stays in one column; the children of a branch point move one
 * column right and hang off the parent's column (horizontal connector), the branch holding
 * the current leaf first. Filtered-out entries are skipped and their children re-attach to
 * the nearest visible ancestor, as in pi.
 */
import {
	type AssistantMessage,
	type BashExecutionMessage,
	type CustomMessage,
	contentToText,
	type SessionEntry,
	type SessionTreeNode,
	type ToolResultMessage,
} from "@pi-web/shared";
import { parseBashResult, payloadText, toolTarget } from "./tools";

export type TreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export const TREE_FILTERS: ReadonlyArray<{ value: TreeFilter; label: string }> = [
	{ value: "default", label: "默认" },
	{ value: "no-tools", label: "隐藏工具" },
	{ value: "user-only", label: "仅用户消息" },
	{ value: "labeled-only", label: "仅已标记" },
	{ value: "all", label: "全部" },
];

export type TreeRole = "user" | "assistant" | "tool" | "summary" | "setting" | "custom" | "bash";

export const TREE_ROLE_LABELS: Record<TreeRole, string> = {
	user: "用户",
	assistant: "助手",
	tool: "工具",
	summary: "摘要",
	setting: "设置",
	custom: "扩展",
	bash: "命令",
};

export interface ToolCallInfo {
	name: string;
	args: Record<string, unknown>;
}

/** Builds pi's get_tree shape from session file entries (labels resolved from label entries). */
export function treeFromEntries(entries: readonly SessionEntry[]): SessionTreeNode[] {
	const nodes = new Map<string, SessionTreeNode>();
	const labels = new Map<string, { label?: string; timestamp: string }>();
	for (const entry of entries) {
		if (!entry || typeof entry.id !== "string") continue;
		if (entry.type === "label") labels.set(entry.targetId, { label: entry.label, timestamp: entry.timestamp });
		nodes.set(entry.id, { entry, children: [] });
	}
	const roots: SessionTreeNode[] = [];
	for (const node of nodes.values()) {
		const parentId = node.entry.parentId;
		const parent = parentId ? nodes.get(parentId) : undefined;
		if (parent && parent !== node) parent.children.push(node);
		else roots.push(node);
	}
	for (const [id, l] of labels) {
		const node = nodes.get(id);
		if (node && l.label) {
			node.label = l.label;
			node.labelTimestamp = l.timestamp;
		}
	}
	return roots;
}

/** Every node reachable from the roots, pre-order (iterative, cycle-safe). */
export function allNodes(roots: readonly SessionTreeNode[]): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	const seen = new Set<SessionTreeNode>();
	const stack = [...roots].reverse();
	while (stack.length > 0) {
		const node = stack.pop() as SessionTreeNode;
		if (seen.has(node)) continue;
		seen.add(node);
		out.push(node);
		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
	}
	return out;
}

/** Entry ids from the leaf up to its root. */
export function activePathIds(nodes: readonly SessionTreeNode[], leafId: string | null | undefined): Set<string> {
	const parent = new Map(nodes.map((n) => [n.entry.id, n.entry.parentId]));
	const ids = new Set<string>();
	let id: string | null | undefined = leafId;
	while (id && !ids.has(id)) {
		ids.add(id);
		id = parent.get(id);
	}
	return ids;
}

/** Tool-call id → name and arguments, from every assistant entry. */
export function collectToolCalls(nodes: readonly SessionTreeNode[]): Map<string, ToolCallInfo> {
	const map = new Map<string, ToolCallInfo>();
	for (const { entry } of nodes) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = (entry.message as AssistantMessage).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "toolCall" && block.id) map.set(block.id, { name: block.name, args: block.arguments ?? {} });
		}
	}
	return map;
}

function oneLine(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((c) => c?.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n")
		.trim();
}

export interface EntryInfo {
	role: TreeRole;
	/** Bold prefix (tool name, "压缩摘要" …). */
	lead?: string;
	/** One-line preview. */
	text: string;
	/** Full text for the preview pane. */
	full: string;
	/** Small bordered note ("压缩前 92k tokens", "失败"). */
	note?: string;
	/** Output tokens of an assistant message. */
	tokens?: number;
	model?: string;
	isError?: boolean;
	/** Heading of the preview pane ("用户消息", "工具结果 · bash" …). */
	kind: string;
	/** Text a navigation puts back into the composer (user and custom messages). */
	editorText?: string;
}

/** Display data of one entry (role tag, preview text, preview pane content). */
export function describeEntry(entry: SessionEntry, toolCalls: ReadonlyMap<string, ToolCallInfo> = new Map()): EntryInfo {
	switch (entry.type) {
		case "message": {
			const m = entry.message;
			switch (m.role) {
				case "user": {
					const full = contentToText(m.content);
					const images = Array.isArray(m.content) ? m.content.filter((c) => c.type === "image").length : 0;
					const text = oneLine(full) || (images ? `[${images} 张图片]` : "（空消息）");
					return { role: "user", text, full: full || text, kind: "用户消息", editorText: full };
				}
				case "assistant": {
					const a = m as AssistantMessage;
					const body = assistantText(a);
					const calls = (Array.isArray(a.content) ? a.content : []).filter((c) => c?.type === "toolCall").map((c) => (c as { name: string }).name);
					const callText = calls.length ? `调用工具：${calls.join("、")}` : "";
					const error = a.stopReason === "error" ? (a.errorMessage ?? "请求失败") : a.stopReason === "aborted" ? "已中止" : "";
					const text = oneLine(body) || error || callText || "（无文本）";
					const full = [body, callText, error && `[${error}]`].filter(Boolean).join("\n\n") || text;
					return {
						role: "assistant",
						text,
						full,
						tokens: a.usage?.output,
						model: a.provider && a.model ? `${a.provider}/${a.model}` : a.model,
						isError: a.stopReason === "error",
						note: a.stopReason === "aborted" ? "已中止" : a.stopReason === "error" ? "错误" : undefined,
						kind: "助手回复",
					};
				}
				case "toolResult": {
					const r = m as ToolResultMessage;
					const call = toolCalls.get(r.toolCallId);
					const name = call?.name ?? r.toolName ?? "tool";
					const output = payloadText(r);
					const target = call ? toolTarget(name, call.args) : "";
					let full: string;
					if (name === "bash") {
						const command = typeof call?.args.command === "string" ? call.args.command : target;
						full = `$ ${command}\n${parseBashResult(output, r.isError).output || output}`;
					} else {
						full = [target, output].filter(Boolean).join("\n\n");
					}
					return {
						role: "tool",
						lead: name,
						text: oneLine(target || output) || "（无输出）",
						full: full || "（无输出）",
						isError: r.isError,
						note: r.isError ? "失败" : undefined,
						kind: `工具结果 · ${name}`,
					};
				}
				case "bashExecution": {
					const b = m as BashExecutionMessage;
					return {
						role: "bash",
						lead: b.excludeFromContext ? "!!" : "!",
						text: oneLine(b.command),
						full: `$ ${b.command}\n${b.output ?? ""}`,
						note: b.exitCode !== undefined && b.exitCode !== 0 ? `退出码 ${b.exitCode}` : undefined,
						kind: "Bash 命令",
					};
				}
				case "custom": {
					const c = m as CustomMessage;
					const full = contentToText(c.content);
					return { role: "custom", lead: c.customType, text: oneLine(full) || "（空）", full, kind: `扩展消息 · ${c.customType}` };
				}
				case "system":
					return { role: "setting", text: "系统提示与工具更新", full: "系统提示或工具列表发生变化。", kind: "设置变更" };
				case "compactionSummary":
				case "branchSummary": {
					const summary = String((m as { summary?: unknown }).summary ?? "");
					const lead = m.role === "compactionSummary" ? "压缩摘要" : "分支摘要";
					return { role: "summary", lead, text: oneLine(summary), full: summary, kind: lead };
				}
				default: {
					const role = (m as { role: string }).role;
					return { role: "setting", text: role, full: JSON.stringify(m, null, 2), kind: "消息" };
				}
			}
		}
		case "custom_message": {
			const full = contentToText(entry.content);
			return {
				role: "custom",
				lead: entry.customType,
				text: oneLine(full) || "（空）",
				full,
				kind: `扩展消息 · ${entry.customType}`,
				editorText: full,
			};
		}
		case "compaction":
			return {
				role: "summary",
				lead: "压缩摘要",
				text: oneLine(entry.summary),
				full: entry.summary,
				note: entry.tokensBefore ? `压缩前 ${formatK(entry.tokensBefore)} tokens` : undefined,
				kind: "压缩摘要",
			};
		case "branch_summary":
			return { role: "summary", lead: "分支摘要", text: oneLine(entry.summary), full: entry.summary, kind: "分支摘要" };
		case "model_change": {
			const text = `模型切换为 ${entry.provider}/${entry.modelId}`;
			return { role: "setting", text, full: text, kind: "设置变更" };
		}
		case "thinking_level_change": {
			const text = `思考级别改为 ${entry.thinkingLevel}`;
			return { role: "setting", text, full: text, kind: "设置变更" };
		}
		case "session_info": {
			const text = entry.name ? `会话名称改为「${entry.name}」` : "清除会话名称";
			return { role: "setting", text, full: text, kind: "设置变更" };
		}
		case "label": {
			const text = entry.label ? `标签「${entry.label}」` : "清除标签";
			return { role: "setting", text, full: `${text}（目标条目 ${entry.targetId.slice(0, 8)}）`, kind: "设置变更" };
		}
		case "custom":
			return { role: "setting", lead: entry.customType, text: "扩展数据", full: JSON.stringify(entry.data ?? null, null, 2), kind: "扩展数据" };
		case "context_edit":
			return { role: "setting", text: "上下文编辑", full: `编辑了条目 ${entry.targetId.slice(0, 8)} 在模型上下文中的内容`, kind: "设置变更" };
		case "usage":
			return { role: "setting", text: `用量记录 · ${entry.kind}`, full: JSON.stringify(entry.usage, null, 2), kind: "用量" };
		default: {
			const e = entry as { type: string };
			return { role: "setting", text: e.type, full: JSON.stringify(entry, null, 2), kind: e.type };
		}
	}
}

function formatK(n: number): string {
	return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

const SETTINGS_TYPES: ReadonlySet<string> = new Set(["label", "context_edit", "custom", "model_change", "thinking_level_change", "session_info"]);

/** pi's /tree filter rules (tool-call-only assistant messages are hidden unless they are the leaf). */
export function passesTreeFilter(node: SessionTreeNode, filter: TreeFilter, leafId: string | null | undefined): boolean {
	const entry = node.entry;
	if (entry.type === "usage") return false;
	if (entry.type === "message" && entry.message.role === "assistant" && entry.id !== leafId) {
		const m = entry.message as AssistantMessage;
		const errorOrAborted = m.stopReason && m.stopReason !== "stop" && m.stopReason !== "toolUse";
		if (!assistantText(m) && !errorOrAborted) return false;
	}
	const isSetting = SETTINGS_TYPES.has(entry.type);
	switch (filter) {
		case "user-only":
			return entry.type === "message" && entry.message.role === "user";
		case "no-tools":
			return !isSetting && !(entry.type === "message" && entry.message.role === "toolResult");
		case "labeled-only":
			return node.label !== undefined && node.label !== "";
		case "all":
			return true;
		default:
			return !isSetting;
	}
}

/** All whitespace-separated tokens of the query occur in the entry's text, lead or label. */
export function matchesTreeQuery(node: SessionTreeNode, info: EntryInfo, query: string): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return true;
	const haystack = [node.label ?? "", info.lead ?? "", info.text, info.full].join("\n").toLowerCase();
	return tokens.every((t) => haystack.includes(t));
}

export interface TreeSegment {
	/** Column index of the vertical guide line. */
	col: number;
	/** Line from the row top to its middle. */
	top: boolean;
	/** Line from the middle to the row bottom. */
	bottom: boolean;
}

export interface TreeRow {
	node: SessionTreeNode;
	id: string;
	info: EntryInfo;
	depth: number;
	/** First row of a branch: a horizontal connector joins it to the parent's column. */
	connector: boolean;
	segments: TreeSegment[];
	onPath: boolean;
	isLeaf: boolean;
	/** Number of children in the full (unfiltered) tree. */
	childCount: number;
}

export interface TreeLayout {
	rows: TreeRow[];
	/** Entries that a filter could show (usage entries excluded). */
	total: number;
	branchPoints: number;
	branches: number;
	nodesById: Map<string, SessionTreeNode>;
	activeIds: Set<string>;
}

interface VNode {
	node: SessionTreeNode;
	children: VNode[];
}

export interface TreeLayoutOptions {
	filter: TreeFilter;
	query?: string;
	leafId: string | null | undefined;
}

/**
 * The entry to show as the current position: the leaf itself, or — when the leaf is a
 * bookkeeping entry the filter hides (a label, model or thinking-level change appended after
 * the last message) — the nearest entry above it that is not bookkeeping. Continuing from that
 * entry is the same as continuing from the leaf.
 */
export function displayLeafId(nodesById: ReadonlyMap<string, SessionTreeNode>, leafId: string | null | undefined, filter: TreeFilter): string | null | undefined {
	const leaf = leafId ? nodesById.get(leafId) : undefined;
	if (!leaf || passesTreeFilter(leaf, filter, leafId)) return leafId;
	let node: SessionTreeNode | undefined = leaf;
	const guard = new Set<string>();
	while (node && SETTINGS_TYPES.has(node.entry.type) && !guard.has(node.entry.id)) {
		guard.add(node.entry.id);
		node = node.entry.parentId ? nodesById.get(node.entry.parentId) : undefined;
	}
	return node ? node.entry.id : leafId;
}

export function layoutTree(roots: readonly SessionTreeNode[], options: TreeLayoutOptions): TreeLayout {
	const nodes = allNodes(roots);
	const nodesById = new Map(nodes.map((n) => [n.entry.id, n]));
	const activeIds = activePathIds(nodes, options.leafId);
	const leafId = displayLeafId(nodesById, options.leafId, options.filter);
	const toolCalls = collectToolCalls(nodes);
	const infos = new Map<SessionTreeNode, EntryInfo>();
	const infoOf = (n: SessionTreeNode) => {
		let info = infos.get(n);
		if (!info) {
			info = describeEntry(n.entry, toolCalls);
			infos.set(n, info);
		}
		return info;
	};
	const query = options.query ?? "";
	const visible = (n: SessionTreeNode) => passesTreeFilter(n, options.filter, leafId) && matchesTreeQuery(n, infoOf(n), query);

	// Visible forest: hidden nodes are skipped and their visible descendants attach to the nearest visible ancestor.
	const forest: VNode[] = [];
	const seen = new Set<SessionTreeNode>();
	const stack: Array<{ node: SessionTreeNode; target: VNode[] }> = [];
	for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], target: forest });
	while (stack.length > 0) {
		const { node, target } = stack.pop() as { node: SessionTreeNode; target: VNode[] };
		if (seen.has(node)) continue;
		seen.add(node);
		let childTarget = target;
		if (visible(node)) {
			const v: VNode = { node, children: [] };
			target.push(v);
			childTarget = v.children;
		}
		for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], target: childTarget });
	}

	const ordered = (list: VNode[]) => {
		const active = list.filter((v) => activeIds.has(v.node.entry.id));
		return active.length ? [...active, ...list.filter((v) => !activeIds.has(v.node.entry.id))] : list;
	};

	const rows: TreeRow[] = [];
	const rowIndex = new Map<string, number>();
	const groups: Array<{ parentIndex: number; col: number; lastChildId: string }> = [];
	const pending: Array<{ v: VNode; depth: number; connector: boolean; continuation: boolean }> = [];
	const rootList = ordered(forest);
	for (let i = rootList.length - 1; i >= 0; i--) pending.push({ v: rootList[i], depth: 0, connector: false, continuation: false });
	while (pending.length > 0) {
		const p = pending.pop() as (typeof pending)[number];
		const id = p.v.node.entry.id;
		const kids = ordered(p.v.children);
		const index = rows.length;
		rowIndex.set(id, index);
		rows.push({
			node: p.v.node,
			id,
			info: infoOf(p.v.node),
			depth: p.depth,
			connector: p.connector,
			segments: p.continuation || kids.length > 0 ? [{ col: p.depth, top: p.continuation, bottom: kids.length > 0 }] : [],
			onPath: activeIds.has(id),
			isLeaf: id === leafId,
			childCount: p.v.node.children.length,
		});
		if (kids.length === 1) {
			pending.push({ v: kids[0], depth: p.depth, connector: false, continuation: true });
		} else if (kids.length > 1) {
			groups.push({ parentIndex: index, col: p.depth, lastChildId: kids[kids.length - 1].node.entry.id });
			for (let i = kids.length - 1; i >= 0; i--) pending.push({ v: kids[i], depth: p.depth + 1, connector: true, continuation: false });
		}
	}

	const addSegment = (row: TreeRow, seg: TreeSegment) => {
		const existing = row.segments.find((s) => s.col === seg.col);
		if (existing) {
			existing.top ||= seg.top;
			existing.bottom ||= seg.bottom;
		} else row.segments.push(seg);
	};
	for (const g of groups) {
		const last = rowIndex.get(g.lastChildId);
		if (last === undefined) continue;
		for (let r = g.parentIndex + 1; r < last; r++) addSegment(rows[r], { col: g.col, top: true, bottom: true });
		addSegment(rows[last], { col: g.col, top: true, bottom: false });
	}

	let total = 0;
	let branchPoints = 0;
	let branches = nodes.length > 0 ? Math.max(1, roots.length) : 0;
	for (const n of nodes) {
		if (n.children.length > 1) {
			branchPoints++;
			branches += n.children.length - 1;
		}
		if (n.entry.type !== "usage") total++;
	}
	return { rows, total, branchPoints, branches, nodesById, activeIds };
}

/** Row to select when the modal opens: the leaf, or its nearest visible ancestor, else the last row. */
export function initialSelection(layout: TreeLayout, leafId: string | null | undefined): string | null {
	const visible = new Set(layout.rows.map((r) => r.id));
	let id: string | null | undefined = leafId;
	const guard = new Set<string>();
	while (id && !guard.has(id)) {
		if (visible.has(id)) return id;
		guard.add(id);
		id = layout.nodesById.get(id)?.entry.parentId;
	}
	return layout.rows.length ? layout.rows[layout.rows.length - 1].id : null;
}
