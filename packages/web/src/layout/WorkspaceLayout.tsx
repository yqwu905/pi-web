import { FolderX } from "lucide-react";
import { useEffect } from "react";
import { Outlet, useLocation, useParams } from "react-router";
import { useWorkspace, useWorkspaceSessions } from "../api/hooks";
import { ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/Display";
import { LoadingBlock } from "../components/ui/Spinner";
import { parseRoute, paths } from "../lib/routes";
import { canRememberSession, findSessionById, isArchived } from "../lib/sessions";
import { useConvsStore } from "../stores/convs";
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
	const sessions = useWorkspaceSessions(workspaceId);
	// Archived sessions are viewed but not remembered: the 对话 tab, "/" and the Files/Git links skip
	// them. So the session is remembered once the list told (or failed to tell) whether it is archived.
	const remember = canRememberSession(sessionId, sessions);

	useEffect(() => {
		if (remember && sessionId) rememberSession(workspaceId, sessionId);
	}, [workspaceId, sessionId, remember, rememberSession]);

	// A remembered session that no longer exists (deleted, e.g. from another tab) is forgotten
	// once the session list says so, unless a live conversation serves it (not listed yet).
	// So is one that was archived meanwhile.
	const lastSession = useUiStore((s) => s.lastSession[workspaceId]);
	const convsById = useConvsStore((s) => s.byId);
	useEffect(() => {
		if (!lastSession || !sessions.isSuccess) return;
		const remembered = findSessionById(sessions.data, lastSession);
		if (remembered) {
			if (isArchived(remembered)) useUiStore.getState().forgetSession(workspaceId, lastSession);
			return;
		}
		if (lastSession === sessionId) return;
		if (Object.values(convsById).some((c) => c.info.sessionId === lastSession && c.info.status !== "exited")) return;
		useUiStore.getState().forgetSession(workspaceId, lastSession);
	}, [lastSession, sessionId, sessions.isSuccess, sessions.data, convsById, workspaceId]);

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
