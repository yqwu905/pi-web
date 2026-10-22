import { Code2, ImageIcon, Workflow } from "lucide-react";
import { type ComponentProps, createContext, memo, type ReactNode, useContext, useEffect, useState } from "react";
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

/** True while the message is still streaming: diagrams render once it is complete. */
const StreamingContext = createContext(false);

type MermaidApi = typeof import("mermaid")["default"];
let mermaidLoad: Promise<MermaidApi> | null = null;
let mermaidIds = 0;

/** Mermaid is bundled (the UI must work offline) and loaded on first use. */
function loadMermaid(): Promise<MermaidApi> {
	mermaidLoad ??= import("mermaid").then(({ default: mermaid }) => {
		mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "inherit" });
		return mermaid;
	});
	return mermaidLoad;
}

function MermaidBlock({ source, fallback }: { source: string; fallback: ReactNode }) {
	const [result, setResult] = useState<{ source: string; svg?: string; error?: string } | null>(null);
	const [showSource, setShowSource] = useState(false);
	useEffect(() => {
		let cancelled = false;
		loadMermaid()
			.then((mermaid) => mermaid.render(`pw-mermaid-${++mermaidIds}`, source))
			.then(
				({ svg }) => !cancelled && setResult({ source, svg }),
				(err: unknown) => !cancelled && setResult({ source, error: err instanceof Error ? err.message : String(err) }),
			);
		return () => {
			cancelled = true;
		};
	}, [source]);
	const current = result?.source === source ? result : null;
	if (current?.error) {
		return (
			<div className="flex flex-col gap-1">
				{fallback}
				<span className="text-2xs text-fg-3">mermaid 图表无法渲染：{current.error.split("\n")[0]}</span>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex justify-end">
				<button
					type="button"
					onClick={() => setShowSource((v) => !v)}
					className="inline-flex items-center gap-1 rounded-sm px-1.5 text-2xs text-fg-3 hover:text-fg"
				>
					{showSource ? <Workflow size={12} aria-hidden="true" /> : <Code2 size={12} aria-hidden="true" />}
					{showSource ? "显示图表" : "显示源码"}
				</button>
			</div>
			{showSource ? (
				fallback
			) : current?.svg ? (
				// Rendered with securityLevel "strict": labels are sanitized, no scripts or click handlers.
				<div className="pw-mermaid overflow-x-auto rounded-lg border border-border bg-code p-3" dangerouslySetInnerHTML={{ __html: current.svg }} />
			) : (
				<div className="rounded-lg border border-border bg-code px-3.5 py-3 text-xs text-fg-3">正在渲染图表…</div>
			)}
		</div>
	);
}

function MarkdownPre({ node, children }: { node?: HastLike; children?: ReactNode }) {
	const text = hastText(node);
	const lang = codeLanguage(node);
	const streaming = useContext(StreamingContext);
	if (lang === "mermaid" && !streaming && text.trim()) {
		return <MermaidBlock source={text} fallback={<PlainPre text={text} lang={lang}>{children}</PlainPre>} />;
	}
	return (
		<PlainPre text={text} lang={lang}>
			{children}
		</PlainPre>
	);
}

function PlainPre({ text, lang, children }: { text: string; lang?: string; children?: ReactNode }) {
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

/**
 * Images that may load automatically: data:/blob: URLs and same-origin paths. Anything else
 * (model output, README of a remote repo) would make the browser fetch an arbitrary URL as soon
 * as it renders: a zero-click exfiltration channel, and a same-site request to other local ports.
 */
export function isAutoLoadableImage(src: string, origin: string = window.location.origin): boolean {
	const value = src.trim();
	if (/^(data:image\/|blob:)/i.test(value)) return true;
	try {
		return new URL(value, `${origin}/`).origin === origin;
	} catch {
		return false;
	}
}

function MarkdownImage({ src, alt, ...props }: ComponentProps<"img">) {
	const url = typeof src === "string" ? src : undefined;
	if (url && isAutoLoadableImage(url)) return <img src={url} alt={alt ?? ""} loading="lazy" {...props} />;
	// Remote images are not loaded: show a link the user can open deliberately.
	return (
		<a href={url} target="_blank" rel="noopener noreferrer" className="pw-md-image-link" title={url}>
			<ImageIcon size={13} aria-hidden="true" className="inline align-[-2px]" /> {alt?.trim() || "外部图片"}
		</a>
	);
}

const components: Components = {
	a: ({ node: _node, href, children, ...props }) => (
		<a href={href} target="_blank" rel="noopener noreferrer" {...props}>
			{children}
		</a>
	),
	pre: ({ node, children }) => <MarkdownPre node={node as HastLike | undefined}>{children}</MarkdownPre>,
	img: ({ node: _node, ...props }) => <MarkdownImage {...props} />,
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
	/** The text is still streaming: mermaid diagrams are shown as source until it completes. */
	streaming?: boolean;
}

/**
 * Markdown renderer for assistant messages and README previews (react-markdown + remark-gfm +
 * rehype-highlight). Styles live in styles.css under `.pw-markdown`. Links open in a new tab.
 * Raw HTML in the source is not rendered; remote images become links; ```mermaid blocks render
 * as diagrams (bundled mermaid, loaded on demand) with a source toggle.
 */
export const Markdown = memo(function Markdown({ children, className, streaming = false }: MarkdownProps) {
	return (
		<StreamingContext.Provider value={streaming}>
			<div className={cn("pw-markdown", className)}>
				<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
					{children}
				</ReactMarkdown>
			</div>
		</StreamingContext.Provider>
	);
});
