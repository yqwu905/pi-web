import { MessageSquarePlus, Server } from "lucide-react";
import { Navigate } from "react-router";
import { useAllWorkspaces } from "../api/hooks";
import { ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/Display";
import { LoadingBlock } from "../components/ui/Spinner";
import { paths } from "../lib/routes";
import { mostRecentConversation, useConvsStore, useLiveConversations } from "../stores/convs";
import { useServers, useServersStore } from "../stores/servers";
import { useUiStore } from "../stores/ui";

/**
 * Route "/": continues the last opened conversation (or the most recently active live one);
 * otherwise an empty state that points to adding a server or picking a workspace.
 */
export default function HomePage() {
	const serversReady = useServersStore((s) => s.loaded || s.error !== null);
	const convsReady = useConvsStore((s) => s.loaded || s.error !== null);
	const servers = useServers();
	const live = useLiveConversations();
	const lastVisited = useUiStore((s) => s.lastVisited);
	const workspaces = useAllWorkspaces();

	if (!serversReady || !convsReady || workspaces.isLoading) return <LoadingBlock />;

	const workspaceIds = new Set((workspaces.data ?? []).map((w) => w.config.id));
	if (lastVisited && workspaceIds.has(lastVisited.workspaceId)) {
		return <Navigate to={paths.chat(lastVisited.workspaceId, lastVisited.sessionId)} replace />;
	}
	const recent = mostRecentConversation(live);
	if (recent?.workspaceId && recent.info.sessionId) {
		return <Navigate to={paths.chat(recent.workspaceId, recent.info.sessionId)} replace />;
	}

	if (servers.length === 0) {
		return (
			<EmptyState
				icon={<Server />}
				title="欢迎使用 Pi-Web"
				description="添加一台 SSH 服务器，Pi-Web 会离线部署 pi 并同步你的配置，然后就可以在浏览器里开始对话。"
				actions={
					<ButtonLink to={paths.addServer()} variant="primary" icon={<Server size={14} />}>
						添加服务器
					</ButtonLink>
				}
			/>
		);
	}

	const first = workspaces.data?.[0];
	return (
		<EmptyState
			icon={<MessageSquarePlus />}
			title="选择一个工作区开始对话"
			description={first ? "从左侧的服务器列表选择工作区与会话，或直接新建对话。" : "服务器上还没有工作区，请先在服务器页面添加一个工作区。"}
			actions={
				first ? (
					<ButtonLink to={paths.chat(first.config.id)} variant="primary" icon={<MessageSquarePlus size={14} />}>
						在 {first.config.alias} 中新建对话
					</ButtonLink>
				) : (
					<ButtonLink to={paths.server(servers[0].config.id)} variant="primary">
						前往 {servers[0].config.name}
					</ButtonLink>
				)
			}
		/>
	);
}
