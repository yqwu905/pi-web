import { type AgentMessage, type AssistantMessage, createConversationState, type SessionEntry, ZERO_USAGE } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { replyForkTarget, userEntryOnBranch } from "./fork";
import { buildDisplayItems } from "./messages";

const user = (ts: number, text: string): AgentMessage => ({ role: "user", content: text, timestamp: ts });
const assistant = (ts: number, text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "x",
	provider: "p",
	model: "m",
	usage: ZERO_USAGE,
	stopReason: "stop",
	timestamp: ts,
});

function entry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

describe("replyForkTarget", () => {
	const items = buildDisplayItems(
		createConversationState({
			messages: [
				user(1, "a"),
				assistant(2, "A"),
				{ role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 3 },
				user(4, "b"),
				assistant(5, "B"),
			],
		}),
	);

	it("forks an earlier reply at the next user message", () => {
		expect(replyForkTarget(items, "assistant-2")).toEqual({ type: "fork", timestamp: 4 });
	});

	it("clones for the reply of the last turn", () => {
		expect(replyForkTarget(items, "assistant-5")).toEqual({ type: "clone" });
	});

	it("is undefined for an unknown key", () => {
		expect(replyForkTarget(items, "assistant-9")).toBeUndefined();
	});
});

describe("userEntryOnBranch", () => {
	// Two branches share the first turn and resend the same text at the same millisecond.
	const entries: SessionEntry[] = [
		entry("u1", null, user(1, "a")),
		entry("a1", "u1", assistant(2, "A")),
		entry("u2", "a1", user(4, "b")),
		entry("a2", "u2", assistant(5, "B")),
		entry("u2x", "a1", user(4, "b")),
		entry("a2x", "u2x", assistant(6, "B'")),
	];

	it("finds the user message on the current branch only", () => {
		expect(userEntryOnBranch(entries, "a2", 4)).toBe("u2");
		expect(userEntryOnBranch(entries, "a2x", 4)).toBe("u2x");
		expect(userEntryOnBranch(entries, "a2", 1)).toBe("u1");
	});

	it("ignores assistant messages and messages off the branch", () => {
		expect(userEntryOnBranch(entries, "a2", 2)).toBeUndefined();
		expect(userEntryOnBranch(entries, "a1", 4)).toBeUndefined();
		expect(userEntryOnBranch(entries, null, 1)).toBeUndefined();
	});

	it("stops on a missing parent or a cycle", () => {
		expect(userEntryOnBranch([entry("x", "missing", assistant(7, "X"))], "x", 1)).toBeUndefined();
		expect(userEntryOnBranch([entry("p", "q", assistant(8, "P")), entry("q", "p", assistant(9, "Q"))], "p", 1)).toBeUndefined();
	});
});
