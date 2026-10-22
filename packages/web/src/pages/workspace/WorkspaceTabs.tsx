import { FileText, GitBranch, MessageSquare, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { useGitStatus, useWorkspace } from "../../api/hooks";
import { Badge } from "../../components/ui/Display";
import { NavTabs } from "../../components/ui/Tabs";
import { cn } from "../../lib/cn";
import { parseRoute, paths } from "../../lib/routes";
import { useServer } from "../../stores/servers";
import { useUiStore } from "../../stores/ui";
import { changedFileCount } from "./lib/git";

export interface WorkspaceTabsProps {
	workspaceId: string;
	/** Extra content right-aligned in the tab bar. */
	aside?: ReactNode;
	className?: string;
}

/** Number of changed files in the workspace's repository (0 when offline or not a repo). */
export function useGitChangeCount(workspaceId: string): number {
	const { workspace } = useWorkspace(workspaceId);
	const server = useServer(workspace?.config.serverId);
	const connected = server?.status.connection === "connected";
	const git = useGitStatus(connected ? workspaceId : undefined, { retry: false });
	return changedFileCount(git.data);
}

/**
 * The 对话 / 文件 / 终端 / Git tab bar of a workspace (40px, accent underline), with the
 * number of changed files on the Git tab. The chat tab returns to the last opened session.
 * Rendered by WorkspaceLayout for every /w/:workspaceId/* page.
 */
export function WorkspaceTabs({ workspaceId, aside, className }: WorkspaceTabsProps) {
	const route = parseRoute(useLocation().pathname);
	const here = route.kind === "workspace" && route.workspaceId === workspaceId ? route : undefined;
	const onChat = here?.tab === "chat";
	const lastSession = useUiStore((s) => s.lastSession[workspaceId]);
	const changed = useGitChangeCount(workspaceId);
	const sessionId = here?.sessionId ?? lastSession;
	const chatTarget = paths.chat(workspaceId, sessionId);

	const tabs = (
		<NavTabs
			aria-label="工作区视图"
			className={cn(aside ? "min-w-0 flex-1 border-b-0" : undefined, !aside && className)}
			items={[
				{ to: chatTarget, label: "对话", icon: <MessageSquare strokeWidth={1.8} />, active: onChat },
				{ to: paths.files(workspaceId), label: "文件", icon: <FileText strokeWidth={1.8} /> },
				{ to: paths.terminal(workspaceId), label: "终端", icon: <SquareTerminal strokeWidth={1.8} /> },
				{
					to: paths.git(workspaceId),
					label: "Git",
					icon: <GitBranch strokeWidth={1.8} />,
					badge:
						changed > 0 ? (
							<Badge shape="count" tone="warning" title={`${changed} 个文件有变更`}>
								{changed}
							</Badge>
						) : undefined,
				},
			]}
		/>
	);
	if (!aside) return tabs;
	return (
		<div className={cn("flex h-10 shrink-0 items-center gap-2 border-b border-border pr-4", className)}>
			{tabs}
			{aside}
		</div>
	);
}
