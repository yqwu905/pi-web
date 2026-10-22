import type { FsEntry, WorkspaceConfig } from "@pi-web/shared";
import { useQueries } from "@tanstack/react-query";
import { FolderX, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../../api/client";
import { invalidateGitStatus, useGitStatus } from "../../api/hooks";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Display";
import { LoadingBlock } from "../../components/ui/Spinner";
import { paths } from "../../lib/routes";
import { FileTreePanel } from "./FileTree";
import { FileViewer } from "./FileViewer";
import { countIgnored, type DirListing, flattenTree, revealPath, setExpanded } from "./lib/file-tree";
import { changedFileCount, gitMarksByPath } from "./lib/git";
import { displayPath, normalizePath, resolveInRoot } from "./lib/remote-path";
import { useWorkspacePrefs } from "./prefs";
import { dirListQuery, invalidateWorkspaceFs } from "./queries";
import { WorkspaceGate } from "./WorkspaceGate";

const README_RE = /^readme(\.(md|markdown|txt|rst))?$/i;

function FilesView({ workspace }: { workspace: WorkspaceConfig }) {
	const wsId = workspace.id;
	const root = normalizePath(workspace.path);
	const [params, setParams] = useSearchParams();
	const pathParam = params.get("path");
	const selected = pathParam ? resolveInRoot(root, pathParam) : undefined;

	const hideIgnored = useWorkspacePrefs((s) => s.hideIgnored);
	const showHidden = useWorkspacePrefs((s) => s.showHidden);
	const setPrefs = useWorkspacePrefs((s) => s.set);
	const listOpts = useMemo(() => ({ hideIgnored, showHidden }), [hideIgnored, showHidden]);

	const [expanded, setExpandedState] = useState<ReadonlySet<string>>(() => (selected ? revealPath(new Set(), root, selected) : new Set()));
	// Reveal files selected from outside the tree (URL, links from Git).
	useEffect(() => {
		if (!selected) return;
		setExpandedState((prev) => {
			const next = revealPath(prev, root, selected);
			return next.size === prev.size ? prev : next;
		});
	}, [root, selected]);

	const dirs = useMemo(() => [root, ...[...expanded].filter((d) => d !== root)], [root, expanded]);
	const combine = useCallback(
		(results: { data?: { entries: FsEntry[] }; isError: boolean; error: Error | null }[]) => {
			const map = new Map<string, DirListing>();
			dirs.forEach((d, i) => {
				const r = results[i];
				if (!r) return;
				if (r.data) map.set(d, { status: "success", entries: r.data.entries });
				else if (r.isError) map.set(d, { status: "error", message: errorMessage(r.error) });
				else map.set(d, { status: "loading" });
			});
			return map;
		},
		[dirs],
	);
	const listings = useQueries({ queries: dirs.map((d) => dirListQuery(wsId, d, listOpts)), combine });
	const rows = useMemo(() => flattenTree(root, (p) => listings.get(p), expanded), [root, listings, expanded]);
	const rootListing = listings.get(root);

	const git = useGitStatus(wsId, { retry: false });
	const marks = useMemo(() => gitMarksByPath(git.data), [git.data]);
	const changed = changedFileCount(git.data);

	const select = useCallback(
		(path: string, replace = false) => {
			setParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					next.set("path", displayPath(root, path));
					return next;
				},
				{ replace },
			);
		},
		[root, setParams],
	);

	// Open the README of the workspace when nothing is selected yet.
	const autoOpened = useRef(false);
	useEffect(() => {
		if (autoOpened.current || selected || rootListing?.status !== "success") return;
		autoOpened.current = true;
		const readme = rootListing.entries.find((e) => e.type !== "dir" && README_RE.test(e.name));
		if (readme) select(readme.path, true);
	}, [rootListing, selected, select]);

	const [refreshing, setRefreshing] = useState(false);
	const refresh = async () => {
		setRefreshing(true);
		try {
			await Promise.all([invalidateWorkspaceFs(wsId), invalidateGitStatus(wsId)]);
		} finally {
			setRefreshing(false);
		}
	};

	if (rootListing?.status === "error") {
		return (
			<EmptyState
				icon={<FolderX />}
				title="无法读取工作区目录"
				description={rootListing.message}
				actions={
					<Button icon={<RefreshCw size={13} />} onClick={() => void refresh()}>
						重试
					</Button>
				}
			/>
		);
	}
	if (!rootListing || rootListing.status === "loading") return <LoadingBlock text="读取目录…" />;

	const ignoredShown = hideIgnored ? 0 : countIgnored(listings.values());
	const footer = (
		<>
			<span>
				{hideIgnored ? "已隐藏被 .gitignore 忽略的文件" : ignoredShown > 0 ? `正在显示 ${ignoredShown} 项被 .gitignore 忽略的文件` : "未隐藏 .gitignore 忽略的文件"}
			</span>
			{changed > 0 && (
				<Link to={paths.git(wsId)} className="text-2xs">
					{changed} 个文件有变更
				</Link>
			)}
		</>
	);

	return (
		<div className="flex min-h-0 flex-1 max-md:flex-col">
			<FileTreePanel
				root={root}
				rows={rows}
				selected={selected}
				marks={marks}
				onToggle={(path, open) => setExpandedState((prev) => setExpanded(prev, path, open))}
				onSelect={(entry: FsEntry) => select(entry.path)}
				onRetry={(dir) => void invalidateWorkspaceFs(wsId).then(() => setExpandedState((prev) => setExpanded(prev, dir, true)))}
				hideIgnored={hideIgnored}
				showHidden={showHidden}
				onHideIgnored={(v) => setPrefs({ hideIgnored: v })}
				onShowHidden={(v) => setPrefs({ showHidden: v })}
				onRefresh={() => void refresh()}
				refreshing={refreshing}
				footer={footer}
			/>
			<FileViewer workspaceId={wsId} root={root} path={selected} gitMark={selected ? marks.get(selected) : undefined} />
		</div>
	);
}

/** Route: /w/:workspaceId/files (?path= relative to the workspace, or absolute). Read-only file browser. */
export default function FilesPage() {
	return <WorkspaceGate title="文件浏览">{({ workspace }) => <FilesView key={workspace.id} workspace={workspace} />}</WorkspaceGate>;
}
