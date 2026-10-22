import { FolderX } from "lucide-react";
import { useEffect } from "react";
import { Outlet, useLocation, useParams } from "react-router";
import { useWorkspace } from "../api/hooks";
import { ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/Display";
import { LoadingBlock } from "../components/ui/Spinner";
import { parseRoute, paths } from "../lib/routes";
import { WorkspaceTabs } from "../pages/workspace/WorkspaceTabs";
import { useUiStore } from "../stores/ui";

/**
 * Layout for /w/:workspaceId/*: the 对话 / 文件 / 终端 / Git tab bar (40px) above the page.
 * The chat tab links back to the last opened session of the workspace.
 */
export function WorkspaceLayout() {
	const { workspaceId = "" } = useParams();
	const route = parseRoute(useLocation().pathname);
	const sessionId = route.kind === "workspace" ? route.sessionId : undefined;
	const { workspace, isLoading, error } = useWorkspace(workspaceId);
	const rememberSession = useUiStore((s) => s.rememberSession);

	useEffect(() => {
		if (sessionId) rememberSession(workspaceId, sessionId);
	}, [workspaceId, sessionId, rememberSession]);

	if (isLoading) return <LoadingBlock />;
	if (!workspace) {
		return (
			<EmptyState
				icon={<FolderX />}
				title="工作区不存在"
				description={error ? error.message : "它可能已被移除。请从左侧选择其他工作区。"}
				actions={<ButtonLink to={paths.home()}>返回首页</ButtonLink>}
			/>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<WorkspaceTabs workspaceId={workspaceId} />
			<div className="flex min-h-0 flex-1 flex-col">
				<Outlet />
			</div>
		</div>
	);
}
