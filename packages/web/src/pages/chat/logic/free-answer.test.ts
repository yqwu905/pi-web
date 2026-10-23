import { describe, expect, it } from "vitest";
import { AUTO_ANSWER_TTL_MS, type AutoAnswerDialog, type PendingAutoAnswer, answerExcerpt, decideAutoAnswer, isFreeInputOption } from "./free-answer";

describe("isFreeInputOption", () => {
	it.each([
		"Type something.",
		"type something",
		"TYPE SOMETHING",
		"4. Type something.",
		"✎ Type something.",
		"✏️ Custom answer",
		"(d) Other",
		"b) Other…",
		"Type your own answer",
		"Type your own",
		"Type your answer",
		"Type here",
		"Type in an answer",
		"Type a custom answer",
		"Write your own",
		"Write my own…",
		"Enter custom value",
		"Enter manually",
		"Enter a new name",
		"Something else",
		"Something else...",
		"Anything else?",
		"Other",
		"Other...",
		"Others",
		"Other (please specify)",
		"Other: describe it",
		"Other answer",
		"Custom",
		"Custom…",
		"Custom (type your own)",
		"Use my own words",
		"Free-form answer",
		"Manual input",
		"Please specify",
		"Please specify below",
		"Let me type it",
		"自定义",
		"自定义回答",
		"自定义：",
		"3、其他",
		"其他的",
		"其他答案",
		"其他（请输入）",
		"其它",
		"输入其他语言",
		"手动输入",
		"手动输入路径",
		"自己输入",
		"自己填写",
		"直接输入",
		"输入",
		"✎ 自由回答",
		"以上都不是，我来自己写",
		"Ｏｔｈｅｒ",
		// rpiv-ask-user-question in RPC mode: "N. " + its localized "Type something."
		"3. Type something.",
		"3. 输入内容",
		"3. Schreibe etwas.",
		"3. Escribe algo.",
		"3. Écrivez quelque chose.",
		"3. Digite algo.",
		"3. Escreva algo.",
		"3. Введите что-нибудь.",
		"3. Введіть щось.",
	])("matches %j", (label) => {
		expect(isFreeInputOption(label)).toBe(true);
	});

	it.each([
		"Allow",
		"Block",
		"Rust",
		"Go",
		"Yes",
		"No",
		"Cancel",
		"Type A",
		"Type checking",
		"TypeScript",
		"Other options",
		"Otherwise skip",
		"Customer list",
		"Enter into the room",
		"Write tests",
		"Save to my notes",
		// Ordinary actions that start like a free-text option.
		"Write it to disk",
		"Write a new file",
		"Write my changes",
		"Write your changes",
		"Write in Rust",
		"Write it in Go",
		"Give it more time",
		"Provide a summary",
		"Specify later",
		"Specify a different branch",
		"Enter in safe mode",
		"Manual",
		"Manually",
		"允许",
		"取消",
		"手动",
		"手动合并",
		"其他选项",
		"其他设置",
		"其它操作…",
		"自由模式",
		"自己处理",
		"自行决定",
		"输入法",
		"直接回答",
		"自己写代码",
		"输入内容校验",
		"1. Rust — 系统编程",
		"",
		"  ",
		"4.",
	])("does not match %j", (label) => {
		expect(isFreeInputOption(label)).toBe(false);
	});
});

describe("decideAutoAnswer", () => {
	const pending: PendingAutoAnswer = { convId: "c1", text: "Zig", seenIds: ["sel"], createdAt: 1_000 };
	const dialog = (id: string, method: string, deadline?: number): AutoAnswerDialog => ({ id, method, deadline });

	it("waits while no new dialog arrived", () => {
		expect(decideAutoAnswer(pending, "c1", [], 2_000)).toEqual({ action: "wait" });
		// The select itself (e.g. still shown or brought back) is not the follow-up.
		expect(decideAutoAnswer(pending, "c1", [dialog("sel", "select")], 2_000)).toEqual({ action: "wait" });
	});

	it("answers the next input or editor request", () => {
		expect(decideAutoAnswer(pending, "c1", [dialog("in1", "input")], 2_000)).toEqual({ action: "answer", dialogId: "in1" });
		expect(decideAutoAnswer(pending, "c1", [dialog("ed1", "editor")], 2_000)).toEqual({ action: "answer", dialogId: "ed1" });
	});

	it("skips dialogs that were pending before the answer was typed", () => {
		const earlier = { ...pending, seenIds: ["sel", "old"] };
		expect(decideAutoAnswer(earlier, "c1", [dialog("old", "input")], 2_000)).toEqual({ action: "wait" });
		expect(decideAutoAnswer(earlier, "c1", [dialog("old", "confirm"), dialog("in1", "input")], 2_000)).toEqual({ action: "answer", dialogId: "in1" });
	});

	it("drops the answer when the next request is not a text request", () => {
		expect(decideAutoAnswer(pending, "c1", [dialog("s2", "select")], 2_000)).toEqual({ action: "drop", reason: "not-text" });
		expect(decideAutoAnswer(pending, "c1", [dialog("c", "confirm"), dialog("in1", "input")], 2_000)).toEqual({ action: "drop", reason: "not-text" });
	});

	it("never answers a dialog of another conversation", () => {
		expect(decideAutoAnswer(pending, "c2", [dialog("in1", "input")], 2_000)).toEqual({ action: "wait" });
		expect(decideAutoAnswer(pending, null, [dialog("in1", "input")], 2_000)).toEqual({ action: "wait" });
	});

	it("expires after AUTO_ANSWER_TTL_MS", () => {
		const justBefore = pending.createdAt + AUTO_ANSWER_TTL_MS - 1;
		expect(decideAutoAnswer(pending, "c1", [], justBefore)).toEqual({ action: "wait" });
		expect(decideAutoAnswer(pending, "c1", [dialog("in1", "input")], justBefore)).toEqual({ action: "answer", dialogId: "in1" });
		const at = pending.createdAt + AUTO_ANSWER_TTL_MS;
		expect(decideAutoAnswer(pending, "c1", [], at)).toEqual({ action: "drop", reason: "expired" });
		expect(decideAutoAnswer(pending, "c1", [dialog("in1", "input")], at)).toEqual({ action: "drop", reason: "expired" });
		expect(decideAutoAnswer(pending, "c2", [], at)).toEqual({ action: "drop", reason: "expired" });
	});

	it("does not answer a request pi already timed out", () => {
		expect(decideAutoAnswer(pending, "c1", [dialog("in1", "input", 2_000)], 2_000)).toEqual({ action: "drop", reason: "expired" });
		expect(decideAutoAnswer(pending, "c1", [dialog("in1", "input", 2_001)], 2_000)).toEqual({ action: "answer", dialogId: "in1" });
	});
});

describe("answerExcerpt", () => {
	it("keeps short text on one line", () => {
		expect(answerExcerpt("  Zig\n and  Rust ")).toBe("Zig and Rust");
	});

	it("cuts long text by characters", () => {
		expect(answerExcerpt("a".repeat(50))).toBe(`${"a".repeat(40)}…`);
		expect(answerExcerpt("语".repeat(41), 40)).toBe(`${"语".repeat(40)}…`);
	});
});
