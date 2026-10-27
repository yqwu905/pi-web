import { type AgentMessage, createConversationState } from "@pi-web/shared";
import { describe, expect, it } from "vitest";
import { buildDisplayItems } from "./messages";
import { activeNavKey, navTargets, sameNavTargets } from "./nav";

const user = (ts: number, content: Extract<AgentMessage, { role: "user" }>["content"]): AgentMessage => ({ role: "user", content, timestamp: ts });

describe("navTargets", () => {
	it("lists the user messages with their text and image count", () => {
		const items = buildDisplayItems(
			createConversationState({
				messages: [
					user(1, "  first  "),
					{ role: "custom", customType: "c", content: "shown", display: true, timestamp: 2 },
					user(3, [
						{ type: "text", text: "look" },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					]),
					user(4, [{ type: "image", data: "AAAA", mimeType: "image/png" }]),
				],
			}),
		);
		expect(navTargets(items)).toEqual([
			{ key: "user-1", text: "first", images: 0 },
			{ key: "user-3", text: "look", images: 1 },
			{ key: "user-4", text: "", images: 1 },
		]);
	});

	it("shortens long messages", () => {
		const [target] = navTargets(buildDisplayItems(createConversationState({ messages: [user(1, "x".repeat(1000))] })));
		expect(target.text).toHaveLength(401);
		expect(target.text.endsWith("…")).toBe(true);
	});
});

describe("sameNavTargets", () => {
	it("compares keys, texts and image counts", () => {
		const a = [{ key: "a", text: "x", images: 0 }];
		expect(sameNavTargets(a, [{ key: "a", text: "x", images: 0 }])).toBe(true);
		expect(sameNavTargets(a, [{ key: "a", text: "y", images: 0 }])).toBe(false);
		expect(sameNavTargets(a, [{ key: "a", text: "x", images: 1 }])).toBe(false);
		expect(sameNavTargets(a, [...a, { key: "b", text: "x", images: 0 }])).toBe(false);
	});
});

describe("activeNavKey", () => {
	const targets = ["a", "b", "c", "d"].map((key) => ({ key, text: key, images: 0 }));

	it("picks the last message above the reading line", () => {
		const rendered = [
			{ key: "a", top: -500 },
			{ key: "b", top: -20 },
			{ key: "c", top: 300 },
			{ key: "d", top: 900 },
		];
		expect(activeNavKey(targets, rendered, 200)).toBe("b");
		expect(activeNavKey(targets, rendered, 300)).toBe("c");
	});

	it("falls back to the first message, or the paged-out one before the first rendered", () => {
		expect(activeNavKey(targets, [{ key: "a", top: 400 }], 200)).toBe("a");
		expect(activeNavKey(targets, [{ key: "c", top: 400 }], 200)).toBe("b");
		expect(activeNavKey(targets, [], 200)).toBe("d");
		expect(activeNavKey([], [], 200)).toBeUndefined();
	});
});
