import type { FsEntry } from "@pi-web/shared";
import { ArrowUp, Check, ChevronRight, Folder, FolderPlus } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import { errorMessage, mkdirOnServer } from "../../api/client";
import { useLatest } from "../../api/hooks";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Input } from "../../components/ui/Input";
import { Spinner } from "../../components/ui/Spinner";
import { cn } from "../../lib/cn";
import { isDirEntry } from "./lib/file-tree";
import { folderNameError, joinPath, normalizePath, pathSegments } from "./lib/remote-path";
import { useServerDir } from "./queries";

export interface RemoteDirPickerProps {
	serverId: string;
	/** Directory being browsed ("~" initially). */
	dir: string;
	onDirChange: (dir: string) => void;
	/** Selected child folder (absolute path), or null when the browsed directory itself is meant. */
	selected: string | null;
	onSelect: (path: string | null) => void;
	/** Called with the resolved absolute path of the browsed directory once listed. */
	onResolved?: (path: string) => void;
	/** Absolute paths that already are workspaces ("已是工作区"). */
	existing: ReadonlySet<string>;
	disabled?: boolean;
	labelledBy?: string;
}

const ROW = "flex h-7 w-full items-center gap-2 rounded-md border px-2 text-left font-mono text-mono";

/**
 * Server-side folder browser (GET /servers/:id/fs/list, POST /servers/:id/fs/mkdir): up,
 * breadcrumb, 新建文件夹, and a folder list. Click selects a folder, double-click or the
 * chevron opens it.
 */
export function RemoteDirPicker({ serverId, dir, onDirChange, selected, onSelect, onResolved, existing, disabled, labelledBy }: RemoteDirPickerProps) {
	const [showHidden, setShowHidden] = useState(false);
	const list = useServerDir(serverId, dir, showHidden, !disabled);
	const resolved = list.data?.path ?? dir;
	const folders = useMemo(() => (list.data?.entries ?? []).filter((e) => isDirEntry(e)), [list.data]);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const hiddenId = useId();

	const onResolvedRef = useLatest(onResolved);
	const resolvedPath = list.data?.path;
	useEffect(() => {
		if (resolvedPath) onResolvedRef.current?.(resolvedPath);
	}, [resolvedPath, onResolvedRef]);

	const go = (path: string) => {
		setCreating(false);
		setCreateError(null);
		onSelect(null);
		onDirChange(path);
	};

	const submitFolder = async () => {
		const error = folderNameError(newName);
		if (error) {
			setCreateError(error);
			return;
		}
		setBusy(true);
		setCreateError(null);
		try {
			const res = await mkdirOnServer(serverId, joinPath(resolved, newName.trim()));
			await list.refetch();
			setCreating(false);
			setNewName("");
			onSelect(normalizePath(res.path || joinPath(resolved, newName.trim())));
		} catch (e) {
			setCreateError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	const onNameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			void submitFolder();
		} else if (e.key === "Escape") {
			// Keep the dialog open: only leave the inline form.
			e.preventDefault();
			setCreating(false);
			setCreateError(null);
		}
	};

	const segments = pathSegments(resolved);
	const parent = list.data?.parent ?? null;

	return (
		<div role="group" aria-labelledby={labelledBy} className={cn("flex flex-col overflow-hidden rounded-lg border border-border bg-bg", disabled && "opacity-60")}>
			<div className="flex h-8 items-center gap-1.5 border-b border-border pr-1.5 pl-1">
				<IconButton aria-label="上一级目录" size="sm" disabled={disabled || !parent} onClick={() => parent && go(parent)}>
					<ArrowUp size={14} strokeWidth={1.9} />
				</IconButton>
				<nav aria-label="当前目录" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-xs whitespace-nowrap">
					{resolved.startsWith("/") && (
						<>
							{segments.length === 0 ? (
								<span aria-current="location" className="px-1 text-fg">
									/
								</span>
							) : (
								<button type="button" disabled={disabled} onClick={() => go("/")} className="h-[22px] rounded-sm border-0 bg-transparent px-1 text-fg-3 hover:bg-raised hover:text-fg" aria-label="根目录">
									/
								</button>
							)}
						</>
					)}
					{segments.map((seg, i) => {
						const last = i === segments.length - 1;
						return (
							<span key={seg.path} className="flex items-center gap-0.5">
								{i > 0 && (
									<span aria-hidden="true" className="text-fg-3">
										/
									</span>
								)}
								{last ? (
									<span aria-current="location" className="px-1 text-fg">
										{seg.name}
									</span>
								) : (
									<button
										type="button"
										disabled={disabled}
										onClick={() => go(seg.path)}
										className="h-[22px] rounded-sm border-0 bg-transparent px-1 text-xs text-fg-2 hover:bg-raised hover:text-fg"
									>
										{seg.name}
									</button>
								)}
							</span>
						);
					})}
				</nav>
				<Button
					size="sm"
					className="shrink-0"
					icon={<FolderPlus size={13} strokeWidth={1.8} className="text-fg-2" />}
					disabled={disabled || !list.data}
					onClick={() => {
						setCreating(true);
						setNewName("");
						setCreateError(null);
					}}
				>
					新建文件夹
				</Button>
			</div>
			<div className="flex max-h-[204px] min-h-[64px] flex-col gap-0.5 overflow-y-auto p-1">
				{creating && (
					<div className="flex flex-col gap-1 rounded-md border border-border-strong bg-panel p-1.5">
						<div className="flex items-center gap-1.5">
							<FolderPlus size={14} strokeWidth={1.7} className="shrink-0 text-accent" aria-hidden="true" />
							<div className="min-w-0 flex-1">
								<Input
									mono
									size="sm"
									autoFocus
									aria-label="新文件夹名称"
									placeholder="文件夹名称"
									value={newName}
									invalid={Boolean(createError)}
									disabled={busy}
									onChange={(e) => setNewName(e.target.value)}
									onKeyDown={onNameKeyDown}
								/>
							</div>
							<Button size="sm" variant="primary" loading={busy} onClick={() => void submitFolder()}>
								创建
							</Button>
							<Button size="sm" variant="ghost" disabled={busy} onClick={() => setCreating(false)}>
								取消
							</Button>
						</div>
						{createError && <span className="px-1 text-xs text-danger">{createError}</span>}
					</div>
				)}
				{list.isPending && !disabled && (
					<span className="flex h-7 items-center gap-2 px-2 text-xs text-fg-3">
						<Spinner size={11} /> 读取目录…
					</span>
				)}
				{list.isError && (
					<span className="flex min-h-7 items-center gap-2 px-2 text-xs text-danger">
						<span className="min-w-0 flex-1">{errorMessage(list.error)}</span>
						<button type="button" onClick={() => void list.refetch()} className="shrink-0 border-0 bg-transparent p-0 text-xs text-link hover:text-link-hover">
							重试
						</button>
					</span>
				)}
				{list.data && folders.length === 0 && !creating && <span className="flex h-7 items-center px-2 text-xs text-fg-3">没有子文件夹</span>}
				{folders.map((entry: FsEntry) => {
					const path = normalizePath(entry.path);
					const isSelected = selected === path;
					const already = existing.has(path);
					return (
						<div key={path} className="group relative flex items-center">
							<button
								type="button"
								aria-pressed={isSelected}
								disabled={disabled}
								onClick={() => onSelect(path)}
								onDoubleClick={() => go(path)}
								title={path}
								className={cn(ROW, "pr-9", isSelected ? "border-border-strong bg-selected text-fg" : "border-transparent bg-transparent text-fg-code hover:bg-raised")}
							>
								<Folder size={14} strokeWidth={1.7} className={cn("shrink-0", isSelected ? "text-accent" : "text-fg-2")} aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate">{entry.name}</span>
								{already && <span className="shrink-0 font-sans text-2xs text-fg-3">已是工作区</span>}
								{isSelected && <Check size={14} strokeWidth={2.2} className="shrink-0 text-accent" aria-hidden="true" />}
							</button>
							<IconButton
								aria-label={`打开 ${entry.name}`}
								size="xs"
								variant="subtle"
								disabled={disabled}
								onClick={() => go(path)}
								className="absolute right-1.5"
							>
								<ChevronRight size={13} strokeWidth={2} />
							</IconButton>
						</div>
					);
				})}
			</div>
			<div className="flex items-center justify-between gap-3 border-t border-border px-2.5 py-1.5 text-2xs text-fg-3">
				<span>{list.data ? `${folders.length} 个文件夹 · 双击打开` : " "}</span>
				<label htmlFor={hiddenId} className="flex cursor-pointer items-center gap-1.5">
					<input id={hiddenId} type="checkbox" checked={showHidden} disabled={disabled} onChange={(e) => setShowHidden(e.target.checked)} className="m-0 size-3 accent-primary" />
					显示隐藏文件夹
				</label>
			</div>
		</div>
	);
}
