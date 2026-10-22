import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/cn";
import { CopyButton } from "./CodeBlock";

interface HastLike {
	type: string;
	value?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastLike[];
}

function hastText(node: HastLike | undefined): string {
	if (!node) return "";
	if (node.type === "text") return node.value ?? "";
	return (node.children ?? []).map(hastText).join("");
}

function codeLanguage(pre: HastLike | undefined): string | undefined {
	const code = pre?.children?.find((c) => c.type === "element" && c.tagName === "code");
	const cls = code?.properties?.className;
	const list = Array.isArray(cls) ? cls.map(String) : typeof cls === "string" ? cls.split(" ") : [];
	const lang = list.find((c) => c.startsWith("language-"));
	return lang?.slice("language-".length);
}

function MarkdownPre({ node, children }: { node?: HastLike; children?: ReactNode }) {
	const text = hastText(node);
	const lang = codeLanguage(node);
	return (
		<div className="pw-md-pre group relative">
			{lang && (
				<span className="pointer-events-none absolute top-2 right-3 font-mono text-2xs text-fg-3 transition-opacity group-hover:opacity-0">
					{lang}
				</span>
			)}
			<CopyButton text={text.replace(/\n$/, "")} />
			<pre className="m-0 overflow-x-auto rounded-lg border border-border bg-code px-3.5 py-3 font-mono text-mono leading-[1.6] text-fg-code [&>code]:bg-transparent [&>code]:p-0">
				{children}
			</pre>
		</div>
	);
}

const components: Components = {
	a: ({ node: _node, href, children, ...props }) => (
		<a href={href} target="_blank" rel="noopener noreferrer" {...props}>
			{children}
		</a>
	),
	pre: ({ node, children }) => <MarkdownPre node={node as HastLike | undefined}>{children}</MarkdownPre>,
	img: ({ node: _node, src, alt, ...props }) => <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} loading="lazy" {...props} />,
	table: ({ node: _node, children, ...props }) => <table {...props}>{children}</table>,
	input: ({ node: _node, ...props }) => <input {...props} disabled />,
};

const remarkPlugins = [remarkGfm];
const rehypePlugins: Parameters<typeof ReactMarkdown>[0]["rehypePlugins"] = [
	[rehypeHighlight, { detect: false, plainText: ["text", "txt", "plain", "plaintext", "mermaid"] }],
];

export interface MarkdownProps {
	/** Markdown source (GFM: tables, task lists, strikethrough, autolinks). */
	children: string;
	className?: string;
}

/**
 * Markdown renderer for assistant messages and README previews (react-markdown + remark-gfm +
 * rehype-highlight). Styles live in styles.css under `.pw-markdown`. Links open in a new tab.
 * Raw HTML in the source is not rendered.
 */
export const Markdown = memo(function Markdown({ children, className }: MarkdownProps) {
	return (
		<div className={cn("pw-markdown", className)}>
			<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
				{children}
			</ReactMarkdown>
		</div>
	);
});
