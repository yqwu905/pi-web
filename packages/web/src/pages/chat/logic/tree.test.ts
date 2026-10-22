import { type SessionEntry, type SessionTreeNode, ZERO_USAGE } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { describeEntry, displayLeafId, initialSelection, layoutTree, matchesTreeQuery, passesTreeFilter, treeFromEntries, type TreeRow } from "./tree";

const ts = "2026-10-22T09:14:00.000Z";
const userEntry = (id: string, parentId: string | null, text: string): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: ts,
	message: { role: "user", content: text, timestamp: 1 },
});
const assistantEntry = (id: string, parentId: string | null, text: string, toolCall?: { id: string; name: string; args: Record<string, unknown> }): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: ts,
	message: {
		role: "assistant",
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...(toolCall ? [{ type: "toolCall" as const, id: toolCall.id, name: toolCall.name, arguments: toolCall.args }] : []),
		],
		api: "a",
		provider: "anthropic",
		model: "claude",
		usage: { ...ZERO_USAGE, output: 1200 },
		stopReason: toolCall ? "toolUse" : "stop",
		timestamp: 2,
	},
});
const toolEntry = (id: string, parentId: string, callId: string, output: string): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: ts,
	message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: output }], isError: false, timestamp: 3 },
});

/*
 * u1 ─ a1(tool call) ─ t1 ─ a2 ─┬─ u2 ─ a3        (branch A, current leaf a3)
 *                               └─ m1(model) ─ u3  (branch B)
 */
const entries: SessionEntry[] = [
	userEntry("u1", null, "first question"),
	assistantEntry("a1", "u1", "", { id: "c1", name: "bash", args: { command: "rg Dataset" } }),
	toolEntry("t1", "a1", "c1", "src/a.py:1"),
	assistantEntry("a2", "t1", "the cache grows"),
	userEntry("u2", "a2", "use LRU"),
	assistantEntry("a3", "u2", "done"),
	{ type: "model_change", id: "m1", parentId: "a2", timestamp: ts, provider: "openai", modelId: "gpt" },
	userEntry("u3", "m1", "try mmap"),
	{ type: "label", id: "l1", parentId: "a3", timestamp: ts, targetId: "a2", label: "root cause" },
	{ type: "usage", id: "x1", parentId: "l1", timestamp: ts, kind: "cache_warm", usage: ZERO_USAGE },
];

function cols(row: TreeRow): string {
	return row.segments
		.slice()
		.sort((a, b) => a.col - b.col)
		.map((s) => `${s.col}${s.top ? "t" : ""}${s.bottom ? "b" : ""}`)
		.join(",");
}

describe("treeFromEntries", () => {
	it("links children and resolves labels", () => {
		const roots = treeFromEntries(entries);
		expect(roots).toHaveLength(1);
		const a2 = roots[0].children[0].children[0].children[0];
		expect(a2.entry.id).toBe("a2");
		expect(a2.label).toBe("root cause");
		expect(a2.children.map((c) => c.entry.id)).toEqual(["u2", "m1"]);
	});

	it("clears labels with a later empty label entry and treats orphans as roots", () => {
		const roots = treeFromEntries([
			userEntry("a", null, "x"),
			{ type: "label", id: "l", parentId: "a", timestamp: ts, targetId: "a", label: "x" },
			{ type: "label", id: "l2", parentId: "l", timestamp: ts, targetId: "a" },
			userEntry("orphan", "missing", "y"),
		]);
		expect(roots.map((r) => r.entry.id)).toEqual(["a", "orphan"]);
		expect(roots[0].label).toBeUndefined();
	});
});

describe("layoutTree", () => {
	const roots = treeFromEntries(entries);

	it("lays out the default view with the current branch first", () => {
		const layout = layoutTree(roots, { filter: "default", leafId: "a3" });
		// a1 (tool-call only) is hidden, labels/model changes/usage are hidden.
		expect(layout.rows.map((r) => r.id)).toEqual(["u1", "t1", "a2", "u2", "a3", "u3"]);
		expect(layout.rows.map((r) => r.depth)).toEqual([0, 0, 0, 1, 1, 1]);
		expect(layout.rows.map((r) => r.connector)).toEqual([false, false, false, true, false, true]);
		expect(layout.rows.map(cols)).toEqual(["0b", "0tb", "0tb", "0tb,1b", "0tb,1t", "0t"]);
		expect(layout.rows.find((r) => r.id === "a3")?.isLeaf).toBe(true);
		expect(layout.rows.filter((r) => r.onPath).map((r) => r.id)).toEqual(["u1", "t1", "a2", "u2", "a3"]);
		expect(layout.total).toBe(9);
		expect(layout.branchPoints).toBe(1);
		expect(layout.branches).toBe(2);
		expect(layout.rows.find((r) => r.id === "t1")?.info).toMatchObject({ role: "tool", lead: "bash", text: "rg Dataset" });
	});

	it("applies pi's filters", () => {
		const ids = (filter: Parameters<typeof layoutTree>[1]["filter"]) => layoutTree(roots, { filter, leafId: "a3" }).rows.map((r) => r.id);
		expect(ids("no-tools")).toEqual(["u1", "a2", "u2", "a3", "u3"]);
		expect(ids("user-only")).toEqual(["u1", "u2", "u3"]);
		expect(ids("labeled-only")).toEqual(["a2"]);
		expect(ids("all")).toEqual(["u1", "t1", "a2", "u2", "a3", "l1", "m1", "u3"]);
	});

	it("re-attaches children of hidden entries and searches", () => {
		const users = layoutTree(roots, { filter: "user-only", leafId: "a3" });
		expect(users.rows.map((r) => r.depth)).toEqual([0, 1, 1]);
		const found = layoutTree(roots, { filter: "default", query: "LRU", leafId: "a3" });
		expect(found.rows.map((r) => r.id)).toEqual(["u2"]);
		expect(layoutTree(roots, { filter: "default", query: "root cause", leafId: "a3" }).rows.map((r) => r.id)).toEqual(["a2"]);
	});

	it("picks the leaf or its nearest visible ancestor", () => {
		expect(initialSelection(layoutTree(roots, { filter: "default", leafId: "a3" }), "a3")).toBe("a3");
		expect(initialSelection(layoutTree(roots, { filter: "user-only", leafId: "a3" }), "a3")).toBe("u2");
		expect(initialSelection(layoutTree([], { filter: "default", leafId: null }), null)).toBeNull();
	});

	it("shows the message before a trailing label/model change as the current position", () => {
		// The leaf l1 is a label entry appended after a3 (labelling or switching models moves the leaf).
		const layout = layoutTree(roots, { filter: "default", leafId: "l1" });
		expect(layout.rows.filter((r) => r.isLeaf).map((r) => r.id)).toEqual(["a3"]);
		expect(layout.rows.filter((r) => r.onPath).map((r) => r.id)).toEqual(["u1", "t1", "a2", "u2", "a3"]);
		expect(initialSelection(layout, "l1")).toBe("a3");
		// Views that show the bookkeeping entry keep the real leaf.
		expect(layoutTree(roots, { filter: "all", leafId: "l1" }).rows.filter((r) => r.isLeaf).map((r) => r.id)).toEqual(["l1"]);
		expect(displayLeafId(layout.nodesById, "l1", "default")).toBe("a3");
		expect(displayLeafId(layout.nodesById, "a3", "default")).toBe("a3");
		expect(displayLeafId(layout.nodesById, null, "default")).toBeNull();
	});

	it("handles very long chains without recursion", () => {
		const chain: SessionEntry[] = [];
		for (let i = 0; i < 20_000; i++) chain.push(userEntry(`e${i}`, i === 0 ? null : `e${i - 1}`, `m${i}`));
		const layout = layoutTree(treeFromEntries(chain), { filter: "default", leafId: "e19999" });
		expect(layout.rows).toHaveLength(20_000);
		expect(layout.rows[19_999].onPath).toBe(true);
	});
});

describe("entry helpers", () => {
	it("describes summaries and settings", () => {
		expect(describeEntry({ type: "compaction", id: "c", parentId: null, timestamp: ts, summary: "sum\nmore", firstKeptEntryId: "x", tokensBefore: 92000 })).toMatchObject({
			role: "summary",
			lead: "压缩摘要",
			text: "sum more",
			note: "压缩前 92k tokens",
		});
		expect(describeEntry({ type: "thinking_level_change", id: "t", parentId: null, timestamp: ts, thinkingLevel: "high" }).text).toBe("思考级别改为 high");
		expect(describeEntry(userEntry("u", null, "hello")).editorText).toBe("hello");
	});

	it("keeps the current leaf even when it is a tool-call-only assistant message", () => {
		const node: SessionTreeNode = { entry: assistantEntry("a", null, "", { id: "c", name: "ls", args: {} }), children: [] };
		expect(passesTreeFilter(node, "default", "other")).toBe(false);
		expect(passesTreeFilter(node, "default", "a")).toBe(true);
		expect(matchesTreeQuery(node, describeEntry(node.entry), "")).toBe(true);
	});
});
