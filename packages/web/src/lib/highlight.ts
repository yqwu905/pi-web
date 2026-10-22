/**
 * highlight.js wrapper used by CodeBlock (Markdown uses rehype-highlight separately).
 * Registers the "common" bundle plus a few extra languages referenced by languages.ts.
 */
import hljs from "highlight.js/lib/common";
import clojure from "highlight.js/lib/languages/clojure";
import cmake from "highlight.js/lib/languages/cmake";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import groovy from "highlight.js/lib/languages/groovy";
import haskell from "highlight.js/lib/languages/haskell";
import nginx from "highlight.js/lib/languages/nginx";
import nix from "highlight.js/lib/languages/nix";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";
import protobuf from "highlight.js/lib/languages/protobuf";
import scala from "highlight.js/lib/languages/scala";
import vim from "highlight.js/lib/languages/vim";
import { languageFromPath, normalizeLanguage } from "./languages";

const EXTRA = { clojure, cmake, dart, dockerfile, elixir, groovy, haskell, nginx, nix, powershell, properties, protobuf, scala, vim };
for (const [name, fn] of Object.entries(EXTRA)) {
	if (!hljs.getLanguage(name)) hljs.registerLanguage(name, fn);
}

/** Inputs larger than this are not highlighted (plain escaped text). */
export const MAX_HIGHLIGHT_CHARS = 400_000;
/** Auto-detection is only attempted for small snippets. */
const MAX_AUTO_DETECT_CHARS = 20_000;

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface HighlightResult {
	/** HTML with hljs-* spans (safe: highlight.js escapes the input). */
	html: string;
	/** Language actually used, or undefined for plain text. */
	language: string | undefined;
}

export interface HighlightOptions {
	language?: string;
	/** Used for detection when `language` is not given. */
	filename?: string;
	/** Guess the language when it cannot be derived (default true). */
	autoDetect?: boolean;
}

export function resolveLanguage(options: Pick<HighlightOptions, "language" | "filename">): string | undefined {
	const lang = normalizeLanguage(options.language) ?? languageFromPath(options.filename);
	return lang && hljs.getLanguage(lang) ? lang : undefined;
}

export function highlightCode(code: string, options: HighlightOptions = {}): HighlightResult {
	if (code.length > MAX_HIGHLIGHT_CHARS) return { html: escapeHtml(code), language: undefined };
	const language = resolveLanguage(options);
	try {
		if (language && language !== "plaintext") {
			return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language };
		}
		if (!language && (options.autoDetect ?? true) && code.length <= MAX_AUTO_DETECT_CHARS && code.trim()) {
			const auto = hljs.highlightAuto(code);
			if (auto.language && auto.relevance >= 5) return { html: auto.value, language: auto.language };
		}
	} catch {
		// fall through to plain text
	}
	return { html: escapeHtml(code), language };
}

/**
 * Splits highlighted HTML into per-line HTML strings, closing spans that are open at a
 * line break and reopening them on the next line (multi-line strings/comments).
 */
export function splitHighlightedLines(html: string): string[] {
	const lines: string[] = [];
	const open: string[] = [];
	let current = "";
	const re = /<span[^>]*>|<\/span>|\n/g;
	let last = 0;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		current += html.slice(last, m.index);
		last = m.index + m[0].length;
		const token = m[0];
		if (token === "\n") {
			current += "</span>".repeat(open.length);
			lines.push(current);
			current = open.join("");
		} else if (token === "</span>") {
			open.pop();
			current += token;
		} else {
			open.push(token);
			current += token;
		}
	}
	current += html.slice(last);
	lines.push(current);
	return lines;
}
