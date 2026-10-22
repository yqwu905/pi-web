/**
 * Query keys and hooks for the workspace views. Keys live under ["workspaces", id, …] and
 * ["servers", id, "fs", …] so the foundation's invalidation helpers keep working.
 */
import type { GitArea } from "@pi-web/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getGitDiff, getGitLog, listServerDir, listWorkspaceDir, readWorkspaceFile } from "../../api/client";
import { queryClient } from "../../api/queryClient";
import { diffAreaFor } from "./lib/git";

export interface DirListOptions {
	showHidden: boolean;
	hideIgnored: boolean;
}

export const workspaceKeys = {
	fs: (wsId: string) => ["workspaces", wsId, "fs"] as const,
	fsList: (wsId: string, path: string, opts: DirListOptions) => ["workspaces", wsId, "fs", "list", path, opts.showHidden, opts.hideIgnored] as const,
	fsRead: (wsId: string, path: string) => ["workspaces", wsId, "fs", "read", path] as const,
	git: (wsId: string) => ["workspaces", wsId, "git"] as const,
	gitDiff: (wsId: string, path: string, area: GitArea) => ["workspaces", wsId, "git", "diff", area, path] as const,
	gitLog: (wsId: string, limit: number) => ["workspaces", wsId, "git", "log", limit] as const,
	serverDir: (serverId: string, path: string, showHidden: boolean) => ["servers", serverId, "fs", path, showHidden] as const,
	serverFs: (serverId: string) => ["servers", serverId, "fs"] as const,
};

export function dirListQuery(wsId: string, path: string, opts: DirListOptions) {
	return {
		queryKey: workspaceKeys.fsList(wsId, path, opts),
		queryFn: () => listWorkspaceDir(wsId, { path, showHidden: opts.showHidden, hideIgnored: opts.hideIgnored }),
		staleTime: 30_000,
		// Files change behind our back (terminal, agent tools): every visit shows the current tree.
		refetchOnMount: "always",
		retry: false,
		// Keep the old listing visible while a filter toggle refetches it.
		placeholderData: keepPreviousData,
	} as const;
}

export function useFileRead(wsId: string, path: string | undefined) {
	return useQuery({
		queryKey: workspaceKeys.fsRead(wsId, path ?? ""),
		queryFn: () => readWorkspaceFile(wsId, path as string),
		enabled: Boolean(path),
		staleTime: 15_000,
		refetchOnMount: "always",
		retry: false,
	});
}

export function useGitDiff(wsId: string, file: { path: string; area: GitArea } | undefined) {
	return useQuery({
		queryKey: workspaceKeys.gitDiff(wsId, file?.path ?? "", file?.area ?? "unstaged"),
		queryFn: () => getGitDiff(wsId, { path: file?.path, area: diffAreaFor(file?.area ?? "unstaged") }),
		enabled: Boolean(file),
		staleTime: 15_000,
		refetchOnMount: "always",
		retry: false,
	});
}

export function useGitLog(wsId: string, enabled: boolean, limit = 30) {
	return useQuery({
		queryKey: workspaceKeys.gitLog(wsId, limit),
		queryFn: () => getGitLog(wsId, limit),
		enabled,
		staleTime: 30_000,
		refetchOnMount: "always",
		retry: false,
	});
}

export function useServerDir(serverId: string, path: string, showHidden: boolean, enabled: boolean) {
	return useQuery({
		queryKey: workspaceKeys.serverDir(serverId, path, showHidden),
		queryFn: () => listServerDir(serverId, { path, showHidden }),
		enabled,
		staleTime: 10_000,
		retry: false,
	});
}

export const invalidateWorkspaceFs = (wsId: string) => queryClient.invalidateQueries({ queryKey: workspaceKeys.fs(wsId) });
export const invalidateWorkspaceGit = (wsId: string) => queryClient.invalidateQueries({ queryKey: workspaceKeys.git(wsId) });
