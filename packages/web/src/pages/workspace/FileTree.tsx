import type { FsEntry, GitFileStatus } from "@pi-web/shared";
import { ChevronDown, File, FileSymlink, Folder, FolderOpen, FolderSymlink, RefreshCw } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { IconButton } from "../../components/ui/IconButton";
import { Spinner } from "../../components/ui/Spinner";
import { cn } from "../../lib/cn";
import { GitStatusLetter } from "./GitStatusLetter";
import { type TreeRow, treeKeyAction } from "./lib/file-tree";

export interface FileTreeProps {
	root: string;
	rows: readonly TreeRow[];
	selected?: string;
	marks: ReadonlyMap<string, GitFileStatus>;
	onToggle: (path: string, open: boolean) => void;
	onSelect: (entry: FsEntry) => void;
	onRetry: (dirPath: string) => void;
}

const INDENT = 16;

function EntryIcon({ entry, dir, expanded, ignored }: { entry: FsEntry; dir: boolean; expanded: boolean; ignored: boolean }) {
	const cls = cn("shrink-0", ignored ? "text-fg-4" : dir ? "text-accent" : "text-fg-3");
	const props = { size: 14, strokeWidth: 1.7, className: cls, "aria-hidden": true } as const;
	if (entry.type === "symlink") return dir ? <FolderSymlink {...props} /> : <FileSymlink {...props} />;
	if (dir) return expanded ? <FolderOpen {...props} /> : <Folder {...props} />;
	return <File {...props} />;
}

/**
 * Lazy directory tree (ARIA tree with roving focus): ↑/↓/Home/End move, → expands or enters,
 * ← collapses or goes to the parent, Enter/Space opens. Rows are 26px, 16px per level.
 */
export function FileTree({ root, rows, selected, marks, onToggle, onSelect, onRetry }: FileTreeProps) {
	const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
	const containerRef = useRef<HTMLDivElement>(null);

	const entryRows = rows.filter((r): r is Extract<TreeRow, { kind: "entry" }> => r.kind === "entry");
	const tabKey = (focusKey && entryRows.some((r) => r.key === focusKey) ? focusKey : undefined) ?? (selected && entryRows.some((r) => r.key === selected) ? selected : entryRows[0]?.key);

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const target = (e.target as HTMLElement).closest<HTMLElement>("[data-tree-key]");
		if (!target) return;
		const current = target.dataset.treeKey ?? "";
		const action = treeKeyAction(rows, current, e.key, root);
		if (!action) return;
		e.preventDefault();
		if ("focus" in action) {
			setFocusKey(action.focus);
			containerRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(action.focus)}"]`)?.focus();
		} else {
			onToggle(action.toggle, action.open);
		}
	};

	return (
		<div ref={containerRef} role="tree" aria-label="工作区文件" onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1.5">
			{rows.map((row) => {
				if (row.kind === "status") {
					return (
						<div
							key={row.key}
							role="none"
							className={cn("flex min-h-[26px] items-center gap-2 pr-2 text-xs", row.status === "error" ? "text-danger" : "text-fg-3")}
							style={{ paddingLeft: 26 + INDENT * row.depth }}
						>
							{row.status === "loading" && (
								<>
									<Spinner size={11} /> 加载中…
								</>
							)}
							{row.status === "empty" && "空目录"}
							{row.status === "error" && (
								<>
									<span className="min-w-0 flex-1 truncate" title={row.message}>
										{row.message || "无法读取目录"}
									</span>
									<button type="button" onClick={() => onRetry(row.dirPath)} className="shrink-0 border-0 bg-transparent p-0 text-xs text-link hover:text-link-hover">
										重试
									</button>
								</>
							)}
						</div>
					);
				}
				const { entry, dir, expanded, depth } = row;
				const ignored = Boolean(entry.ignored);
				const isSelected = !dir && row.key === selected;
				const mark = dir ? undefined : marks.get(row.key);
				return (
					<button
						key={row.key}
						type="button"
						role="treeitem"
						data-tree-key={row.key}
						aria-level={depth + 1}
						aria-expanded={dir ? expanded : undefined}
						aria-selected={dir ? undefined : isSelected}
						tabIndex={row.key === tabKey ? 0 : -1}
						title={entry.path}
						onFocus={() => setFocusKey(row.key)}
						onClick={() => (dir ? onToggle(row.key, !expanded) : onSelect(entry))}
						className={cn(
							"relative flex h-[26px] w-full shrink-0 items-center gap-1.5 rounded-sm border-0 pr-2 text-left text-sm focus-visible:-outline-offset-2",
							isSelected ? "bg-selected font-medium text-fg" : cn("bg-transparent hover:bg-raised", ignored ? "text-fg-3" : "text-fg-code"),
						)}
						style={{ paddingLeft: (dir ? 8 : 26) + INDENT * depth }}
					>
						{dir && (
							<ChevronDown
								size={12}
								strokeWidth={2.2}
								aria-hidden="true"
								className={cn("shrink-0 transition-transform duration-100", ignored ? "text-fg-4" : "text-fg-3", !expanded && "-rotate-90")}
							/>
						)}
						<EntryIcon entry={entry} dir={dir} expanded={expanded} ignored={ignored} />
						<span className="min-w-0 flex-1 truncate">{entry.name}</span>
						{ignored && <span className="shrink-0 text-2xs text-fg-3">已忽略</span>}
						{mark && <GitStatusLetter file={mark} />}
					</button>
				);
			})}
		</div>
	);
}

export interface FileTreePanelProps extends FileTreeProps {
	hideIgnored: boolean;
	showHidden: boolean;
	onHideIgnored: (value: boolean) => void;
	onShowHidden: (value: boolean) => void;
	onRefresh: () => void;
	refreshing: boolean;
	footer?: ReactNode;
}

function FilterToggle({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
	return (
		<label className="flex cursor-pointer items-center gap-2 text-xs text-fg-2">
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="m-0 size-3.5 shrink-0 accent-primary" />
			<span>{children}</span>
		</label>
	);
}

/** Left column of the Files view: root path + refresh, filter toggles, the tree and a footer. */
export function FileTreePanel({ hideIgnored, showHidden, onHideIgnored, onShowHidden, onRefresh, refreshing, footer, ...tree }: FileTreePanelProps) {
	return (
		<section aria-label="文件树" className="flex min-h-0 shrink-0 flex-col border-border bg-panel max-md:max-h-[45%] max-md:border-b md:w-[240px] md:border-r xl:w-[280px]">
			<div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
				<div className="flex items-center gap-2">
					<Folder size={14} strokeWidth={1.7} className="shrink-0 text-accent" aria-hidden="true" />
					<code title={tree.root} className="min-w-0 flex-1 truncate text-xs text-fg-code">
						{tree.root}
					</code>
					<IconButton aria-label="刷新" variant="secondary" size="md" onClick={onRefresh} disabled={refreshing}>
						<RefreshCw size={14} strokeWidth={1.8} className={cn(refreshing && "animate-spin")} />
					</IconButton>
				</div>
				<FilterToggle checked={hideIgnored} onChange={onHideIgnored}>
					隐藏 <code className="text-[11.5px] text-fg-code">.gitignore</code> 忽略的文件
				</FilterToggle>
				<FilterToggle checked={showHidden} onChange={onShowHidden}>
					显示隐藏文件（<code className="text-[11.5px] text-fg-code">.</code> 开头）
				</FilterToggle>
			</div>
			<FileTree {...tree} />
			{footer && (
				<div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-2xs text-fg-3">{footer}</div>
			)}
		</section>
	);
}
