import { Check, Copy } from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { highlightCode, splitHighlightedLines } from "../lib/highlight";
import { languageLabel } from "../lib/languages";
import { IconButton } from "./ui/IconButton";

export interface CodeBlockProps {
	code: string;
	/** highlight.js id or common alias ("py", "ts", "sh"). */
	language?: string;
	/** File name/path used to detect the language when `language` is not given. */
	filename?: string;
	/** Line-number gutter (sticky, as in the Files artboard). */
	lineNumbers?: boolean;
	/** Number of the first line (e.g. a `read` tool result with offset). */
	startLine?: number;
	/** Soft-wrap long lines (rows are rendered per line so numbers stay aligned). */
	wrap?: boolean;
	/** Disable syntax highlighting (still escaped). */
	plain?: boolean;
	/** Guess the language when neither language nor filename identify it (default true). */
	autoDetect?: boolean;
	/** Scroll container max height (px or CSS length). */
	maxHeight?: number | string;
	/** Copy button in the top-right corner. */
	copyable?: boolean;
	/** Line numbers (1-based, relative to startLine) to emphasize. */
	highlightLines?: readonly number[];
	className?: string;
	/** Rounded border around the block (default false: fills its container, like tool cards). */
	bordered?: boolean;
}

/**
 * Highlighted code: JetBrains Mono 12.5px / 20px on #0B0D11 with the artboard syntax colors.
 * Large inputs (> 400k chars) fall back to plain text.
 */
export function CodeBlock({
	code,
	language,
	filename,
	lineNumbers = false,
	startLine = 1,
	wrap = false,
	plain = false,
	autoDetect = true,
	maxHeight,
	copyable = false,
	highlightLines,
	className,
	bordered = false,
}: CodeBlockProps) {
	const text = code.endsWith("\n") ? code.slice(0, -1) : code;
	const result = useMemo(
		() => (plain ? highlightCode(text, { language: "plaintext" }) : highlightCode(text, { language, filename, autoDetect })),
		[text, language, filename, plain, autoDetect],
	);
	const perLine = wrap || Boolean(highlightLines?.length);
	const lines = useMemo(() => (perLine ? splitHighlightedLines(result.html) : null), [perLine, result.html]);
	const lineCount = useMemo(() => (perLine ? (lines?.length ?? 0) : text.split("\n").length), [perLine, lines, text]);
	const marked = useMemo(() => new Set(highlightLines ?? []), [highlightLines]);
	const lastNo = startLine + lineCount - 1;
	const gutterCh = String(lastNo).length;

	const style: CSSProperties | undefined = maxHeight !== undefined ? { maxHeight } : undefined;
	const gutterClass = "sticky left-0 shrink-0 select-none border-r border-border pr-3 pl-4 text-right text-fg-3";

	return (
		<div className={cn("group relative min-w-0 bg-code", bordered && "overflow-hidden rounded-lg border border-border", className)}>
			{copyable && <CopyButton text={code} />}
			<pre
				className={cn("m-0 overflow-auto font-mono text-mono text-fg-code", !perLine && "flex items-start")}
				style={style}
				aria-label={filename ? `${filename}（${languageLabel(result.language, filename)}）` : undefined}
				tabIndex={0}
			>
				{perLine && lines ? (
					<code className="hljs block min-w-full py-3">
						{lines.map((html, i) => {
							const no = startLine + i;
							return (
								<span key={i} className={cn("flex", marked.has(no) && "bg-selected")}>
									{lineNumbers && (
										<span aria-hidden="true" className={cn(gutterClass, marked.has(no) ? "bg-selected" : "bg-code")} style={{ minWidth: `calc(${gutterCh}ch + 28px)` }}>
											{no}
										</span>
									)}
									<span
										className={cn("flex-1 px-4", wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre")}
										dangerouslySetInnerHTML={{ __html: html || " " }}
									/>
								</span>
							);
						})}
					</code>
				) : (
					<>
						{lineNumbers && (
							<span aria-hidden="true" className={cn(gutterClass, "min-h-full bg-code py-3 whitespace-pre")}>
								{Array.from({ length: lineCount }, (_, i) => startLine + i).join("\n")}
							</span>
						)}
						<code
							className="hljs block flex-[1_0_auto] px-4 py-3 whitespace-pre"
							dangerouslySetInnerHTML={{ __html: result.html || " " }}
						/>
					</>
				)}
			</pre>
		</div>
	);
}

/** Small copy-to-clipboard button shown on hover (top-right of code blocks). */
export function CopyButton({ text, className }: { text: string; className?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<IconButton
			aria-label={copied ? "已复制" : "复制"}
			variant="secondary"
			size="md"
			className={cn(
				"absolute top-2 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
				copied && "opacity-100",
				className,
			)}
			onClick={() => {
				void copyText(text).then((ok) => {
					if (!ok) return;
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			{copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
		</IconButton>
	);
}

/** Clipboard write with a textarea fallback (non-secure contexts). Resolves to success. */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall back below
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}
