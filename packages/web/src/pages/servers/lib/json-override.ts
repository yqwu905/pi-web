/** Validation of the per-server settings.json override (a JSON object deep-merged by the host). */
import { isPlainObject } from "@pi-web/shared";

export type OverrideParseResult =
	| { ok: true; value: Record<string, unknown>; warnings: string[] }
	| { ok: false; error: string; line?: number; column?: number };

/** Keys the host injects or strips while syncing; overriding them deserves a heads-up. */
const INJECTED_KEYS: Record<string, string> = {
	shellCommandPrefix: "shellCommandPrefix 会替换代理注入的前缀（仅 LLM 模式下用于取消 bash 的代理变量）",
	transport: "transport 会替换代理注入的 \"sse\" 传输设置",
	npmCommand: "npmCommand 是 Host 专属设置，覆盖到服务器上可能不可用",
	shellPath: "shellPath 是 Host 专属设置，覆盖到服务器上可能不可用",
	httpProxy: "httpProxy 会让 pi 绕过隧道代理",
};

/** 1-based line/column of a character offset. */
export function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
	const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
	const lines = before.split("\n");
	return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Offset of the first JSON syntax error (a small recursive-descent scan), or undefined when the
 * text is valid. Used when the engine's error message carries no position.
 */
export function findJsonErrorOffset(text: string): number | undefined {
	let i = 0;
	const ws = () => {
		while (i < text.length && " \t\n\r".includes(text[i])) i++;
	};
	const fail = (): never => {
		throw i;
	};
	const literal = (word: string) => {
		if (text.startsWith(word, i)) i += word.length;
		else fail();
	};
	const string = () => {
		if (text[i] !== '"') fail();
		i++;
		while (i < text.length) {
			const c = text[i];
			if (c === '"') {
				i++;
				return;
			}
			if (c === "\\") {
				i++;
				if (text[i] === "u") {
					if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail();
					i += 5;
				} else if ('"\\/bfnrt'.includes(text[i] ?? "")) i++;
				else fail();
			} else if (c < " ") fail();
			else i++;
		}
		fail();
	};
	const number = () => {
		const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
		if (!m) fail();
		else i += m[0].length;
	};
	const value = (): void => {
		ws();
		const c = text[i];
		if (c === "{") {
			i++;
			ws();
			if (text[i] === "}") {
				i++;
				return;
			}
			for (;;) {
				ws();
				string();
				ws();
				if (text[i] !== ":") fail();
				i++;
				value();
				ws();
				if (text[i] === ",") {
					i++;
					continue;
				}
				if (text[i] === "}") {
					i++;
					return;
				}
				fail();
			}
		}
		if (c === "[") {
			i++;
			ws();
			if (text[i] === "]") {
				i++;
				return;
			}
			for (;;) {
				value();
				ws();
				if (text[i] === ",") {
					i++;
					continue;
				}
				if (text[i] === "]") {
					i++;
					return;
				}
				fail();
			}
		}
		if (c === '"') return string();
		if (c === "t") return literal("true");
		if (c === "f") return literal("false");
		if (c === "n") return literal("null");
		return number();
	};
	try {
		value();
		ws();
		return i < text.length ? i : undefined;
	} catch (offset) {
		return typeof offset === "number" ? offset : 0;
	}
}

/** Best-effort position of a JSON.parse SyntaxError across engines. */
export function syntaxErrorPosition(message: string, text: string): { line: number; column: number } | undefined {
	const lc = /line (\d+) column (\d+)/i.exec(message);
	if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
	const pos = /position (\d+)/i.exec(message);
	if (pos) return offsetToLineColumn(text, Number(pos[1]));
	const offset = findJsonErrorOffset(text);
	return offset === undefined ? undefined : offsetToLineColumn(text, offset);
}

/** Empty text is an empty override. The value must be a JSON object. */
export function parseSettingsOverride(text: string): OverrideParseResult {
	if (!text.trim()) return { ok: true, value: {}, warnings: [] };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const pos = syntaxErrorPosition(message, text);
		return {
			ok: false,
			error: pos ? `JSON 格式错误（第 ${pos.line} 行，第 ${pos.column} 列）` : "JSON 格式错误",
			...(pos ?? {}),
		};
	}
	if (!isPlainObject(value)) return { ok: false, error: "覆盖内容必须是 JSON 对象，例如 {\"defaultThinkingLevel\": \"medium\"}" };
	const warnings = Object.keys(value)
		.filter((k) => k in INJECTED_KEYS)
		.map((k) => INJECTED_KEYS[k]);
	return { ok: true, value, warnings };
}

/** Pretty JSON for the editor; an empty object becomes "{}". */
export function formatOverride(value: Record<string, unknown> | undefined): string {
	if (!value || Object.keys(value).length === 0) return "{}";
	return JSON.stringify(value, null, 2);
}

/** Structural equality for JSON values (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((v, i) => jsonEqual(v, b[i]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		if (ka.length !== kb.length) return false;
		return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
	}
	return false;
}
