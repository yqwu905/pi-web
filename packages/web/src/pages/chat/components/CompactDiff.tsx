import { useMemo, useState } from "react";
import { cn } from "../../../lib/cn";
import type { DiffFile } from "../../../lib/diff-parse";

const MAX_LINES = 400;

const TONE = {
	context: "text-fg-code",
	add: "bg-success-soft text-success-fg",
	del: "bg-danger-soft text-danger",
	note: "text-fg-3",
} as const;
const SIGN = { context: " ", add: "+", del: "-", note: "\\" } as const;

type Row = { kind: "hunk"; text: string } | { kind: keyof typeof TONE; text: string };

/** Dense diff for tool cards (Main artboard): hunk headers and +/− lines, no line-number gutters. */
export function CompactDiff({ files, className, maxHeight = 420 }: { files: DiffFile[]; className?: string; maxHeight?: number }) {
	const [all, setAll] = useState(false);
	const rows = useMemo(() => {
		const out: Row[] = [];
		for (const file of files) {
			for (const hunk of file.hunks) {
				out.push({ kind: "hunk", text: hunk.header });
				for (const line of hunk.lines) out.push({ kind: line.type, text: line.content });
			}
		}
		return out;
	}, [files]);
	if (rows.length === 0) return <div className="bg-code px-3 py-2 text-xs text-fg-3">没有内容变更</div>;
	const shown = all ? rows : rows.slice(0, MAX_LINES);
	return (
		<div className={cn("bg-code", className)}>
			<pre className="m-0 overflow-auto py-1 font-mono text-mono leading-[1.6]" style={{ maxHeight }} tabIndex={0} aria-label="文件差异">
				<span className="inline-block min-w-full">
					{shown.map((row, i) =>
						row.kind === "hunk" ? (
							<span key={i} className="block px-3 whitespace-pre text-fg-3">
								{row.text}
							</span>
						) : (
							<span key={i} className={cn("block px-3 whitespace-pre", TONE[row.kind])}>
								<span aria-hidden="true" className="inline-block w-3 select-none">
									{SIGN[row.kind]}
								</span>
								{row.kind === "note" ? ` ${row.text}` : row.text || " "}
							</span>
						),
					)}
				</span>
			</pre>
			{rows.length > MAX_LINES && !all && (
				<button type="button" onClick={() => setAll(true)} className="w-full border-t border-border bg-panel py-1.5 text-xs text-link hover:text-link-hover">
					显示全部 {rows.length} 行
				</button>
			)}
		</div>
	);
}
