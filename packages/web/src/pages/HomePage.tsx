import type { SessionSummary } from "@pi-web/shared";
import { useQueries } from "@tanstack/react-query";
import { MessageSquarePlus, Server } from "lucide-react";
import { Navigate } from "react-router";
import { sessionsQueryOptions, useAllWorkspaces } from "../api/hooks";
import { ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/Display";
import { LoadingBlock } from "../components/ui/Spinner";
import { paths } from "../lib/routes";
import { pickResumeTarget } from "../lib/sessions";
import { useConvsStore, useLiveConversations } from "../stores/convs";
import { useServers, useServersStore } from "../stores/servers";
import { useUiStore } from "../stores/ui";

/**
 * Route "/": continues the last opened conversation (or the most recently active live one),
 * skipping archived sessions; otherwise an empty state that points to adding a server or
 * picking a workspace.
 */
export default function HomePage() {
	const serversReady = useServersStore((s) => s.loaded || s.error !== null);
	const convsReady = useConvsStore((s) => s.loaded || s.error !== null);
	const servers = useServers();
	const live = useLiveConversations();
	const lastVisited = useUiStore((s) => s.lastVisited);
	const workspaces = useAllWorkspaces();

	// Session lists of the candidate workspaces (where reachable) tell which candidates are archived.
	const online = new Set(servers.filter((s) => s.status.connection === "connected").map((s) => s.config.id));
	const candidateIds = [...new Set([lastVisited?.workspaceId, ...live.map((c) => c.workspaceId)])].filter(
		(id): id is string => Boolean(id) && (workspaces.data ?? []).some((w) => w.config.id === id && online.has(w.config.serverId)),
	);
	const lists = useQueries({
		queries: candidateIds.map((id) => ({ ...sessionsQueryOptions(id), retry: false })),
		combine: (results) => ({
			loading: results.some((r) => r.isLoading),
			byWorkspace: Object.fromEntries(results.map((r, i) => [candidateIds[i], r.data])) as Record<string, SessionSummary[] | undefined>,
		}),
	});

	if (!serversReady || !convsReady || workspaces.isLoading || lists.loading) return <LoadingBlock />;

	const workspaceIds = new Set((workspaces.data ?? []).map((w) => w.config.id));
	const target = pickResumeTarget(lastVisited, workspaceIds, live, lists.byWorkspace);
	if (target) return <Navigate to={paths.chat(target.workspaceId, target.sessionId)} replace />;

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
