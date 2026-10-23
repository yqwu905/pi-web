/**
 * Free-text answers to extension selects. Question-style extensions offer an option such as
 * "Type something." and, when it is chosen, ask for the text with a follow-up input/editor
 * dialog. The select dialog lets the user type the answer right away: the select is answered
 * with that option and the follow-up request is answered with the typed text.
 */

/** How long a typed answer waits for the extension's follow-up input/editor request. */
export const AUTO_ANSWER_TTL_MS = 60_000;

/** What the user would type: "Enter a new name", "Type your answer", "Provide a custom value". */
const EN_ANSWER_NOUNS = "answer|response|reply|value|text|name|message";
const EN_PATTERNS: readonly RegExp[] = [
	// "Type something.", "Type here", "Enter manually", "Type in an answer", "Type a custom answer", "Enter custom value",
	// "Enter a new name" (not "Type A", "Write a new file", "Write it in Go", "Write my changes", "Enter in safe mode")
	new RegExp(
		`^(type|write|enter|input|provide|give|specify)\\s+(in\\s+)?(something|anything|here|manually|((an?|my|your|another|other)\\s+)?((own|custom|different|new|other)\\s+)?(${EN_ANSWER_NOUNS}))\\b`,
	),
	// "Please specify", "Specify" (not "Specify later")
	/^please specify\b|^specify$/,
	/^let me (type|write|enter|specify)\b/,
	// "Something else…"
	/^(something|anything) else\b/,
	// "Other", "Other…", "Other (please specify)", "Other: …", "Other answer" (not "Other options")
	/^others?(\s*[(:\-–—].*|\s+(answer|option|choice|response|reply|value|input|text|please|specify)\b.*)?$/,
	// "Custom", "Custom answer", "Custom (type your own)"
	/^custom(\s*[(:\-–—].*|\s+(answer|option|choice|response|reply|value|input|text|entry|message)\b.*)?$/,
	// "… (type your own)", "Use my own words"
	/\b(your|my) own\b/,
	/\bfree[\s-]?(form|text|input|answer|response)\b/,
	// "Manual input" (not "Manual" or "Manually" alone: usually a mode, as in [Auto, Manual])
	/^manual (input|entry|answer|response)$/,
];
// The whole label, or with a note: "其他", "其它的", "自定义", "输入", "其他（请输入）", "其他：…" (not "其他选项", "输入法")
const ZH_WHOLE = /^(自定义|其他|其它|输入)的?(\s*[(:\-–—].*)?$/;
// With an answer-type word: "自定义回答", "其他答案", "手动输入", "自己填写", "自由回答", "我来自己写", "请输入…", "输入其他语言"
// (not "手动合并", "其他设置", "自由模式", "自己处理", "自行决定", "直接回答", "自己写代码")
const ZH_ANSWER = new RegExp(
	[
		"自定义的?(回答|答案|回复|输入|内容|文字|文本|值)",
		"(其他|其它)的?(回答|答案|回复)",
		"(手动|自己|自行|自由|直接|我来|我自己)来?(输入|填写|填)",
		"(自己|自由|我来|我自己)来?(回答|作答)",
		"(自己|我来|我自己)来?写(回答|答案)?$",
		"请输入",
		"输入(其他|其它)",
	].join("|"),
);

/** Lowercase, without list markers or symbols in front ("4. ", "✎ ", "(b) ") and punctuation at the end. */
function normalizeLabel(label: string): string {
	return label
		.normalize("NFKC")
		.toLowerCase()
		.replace(/^[^\p{L}\p{N}]+/u, "")
		.replace(/^(\d+|[a-z])[.):、\]]\s*/u, "")
		.replace(/^[^\p{L}\p{N}]+/u, "")
		.replace(/[\s\p{P}\p{S}]+$/u, "")
		.replace(/\s+/g, " ");
}

/** rpiv-ask-user-question's "Type something." in its other locales (de, es, fr, pt-BR, pt, ru, uk, zh). */
const KNOWN_LABELS = new Set(
	["Schreibe etwas.", "Escribe algo.", "Écrivez quelque chose.", "Digite algo.", "Escreva algo.", "Введите что-нибудь.", "Введіть щось.", "输入内容"].map(normalizeLabel),
);

/** True for select options that stand for "let me type my own answer". */
export function isFreeInputOption(label: string): boolean {
	const s = normalizeLabel(label);
	if (!s) return false;
	return KNOWN_LABELS.has(s) || ZH_WHOLE.test(s) || ZH_ANSWER.test(s) || EN_PATTERNS.some((re) => re.test(s));
}

/** A typed answer waiting for the extension's follow-up text request. */
export interface PendingAutoAnswer {
	/** Conversation whose select was answered: dialogs of other conversations are never answered. */
	convId: string;
	text: string;
	/** Dialogs already pending when the select was answered (the select included): the follow-up is a later one. */
	seenIds: readonly string[];
	createdAt: number;
}

export interface AutoAnswerDialog {
	id: string;
	method: string;
	/** When pi gives up on the dialog (browser clock), if it has a timeout. */
	deadline?: number;
}

export type AutoAnswerDecision =
	| { action: "answer"; dialogId: string }
	| { action: "drop"; reason: "expired" | "not-text" }
	| { action: "wait" };

/**
 * What to do with a pending typed answer, given the dialogs `convId` (the conversation on screen)
 * has pending: answer the first new one if it asks for text, drop the answer if the first new one
 * asks for something else or nothing asked within AUTO_ANSWER_TTL_MS, otherwise wait.
 */
export function decideAutoAnswer(pending: PendingAutoAnswer, convId: string | null, dialogs: readonly AutoAnswerDialog[], now: number): AutoAnswerDecision {
	if (now - pending.createdAt >= AUTO_ANSWER_TTL_MS) return { action: "drop", reason: "expired" };
	if (convId !== pending.convId) return { action: "wait" };
	const next = dialogs.find((d) => !pending.seenIds.includes(d.id));
	if (!next) return { action: "wait" };
	if (next.method !== "input" && next.method !== "editor") return { action: "drop", reason: "not-text" };
	if (next.deadline !== undefined && next.deadline <= now) return { action: "drop", reason: "expired" };
	return { action: "answer", dialogId: next.id };
}

/** Short single-line excerpt of a typed answer for messages. */
export function answerExcerpt(text: string, max = 40): string {
	const line = text.replace(/\s+/g, " ").trim();
	const chars = [...line];
	return chars.length > max ? `${chars.slice(0, max).join("")}…` : line;
}
