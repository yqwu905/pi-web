import type { ServerView, WorkspaceConfig } from "@pi-web/shared";
import { CloudOff, Plug, ServerCrash } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useParams } from "react-router";
import { connectServer, errorMessage } from "../../api/client";
import { useWorkspace } from "../../api/hooks";
import { Button, ButtonLink } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Display";
import { LoadingBlock } from "../../components/ui/Spinner";
import { toast } from "../../components/ui";
import { paths } from "../../lib/routes";
import { useServer, useServersStore } from "../../stores/servers";

export interface WorkspaceContext {
	workspace: WorkspaceConfig;
	server: ServerView;
}

/** The current route's workspace and its server (undefined while loading). */
export function useWorkspaceRoute(): { workspaceId: string; workspace?: WorkspaceConfig; server?: ServerView; serversLoaded: boolean } {
	const { workspaceId = "" } = useParams();
	const { workspace } = useWorkspace(workspaceId);
	const server = useServer(workspace?.config.serverId);
	const serversLoaded = useServersStore((s) => s.loaded);
	return { workspaceId, workspace: workspace?.config, server, serversLoaded };
}

export function ConnectButton({ serverId, size, label = "连接服务器" }: { serverId: string; size?: "sm" | "md"; label?: string }) {
	const [busy, setBusy] = useState(false);
	return (
		<Button
			variant="primary"
			size={size}
			icon={<Plug size={14} />}
			loading={busy}
			onClick={async () => {
				setBusy(true);
				try {
					useServersStore.getState().upsertServer(await connectServer(serverId));
				} catch (e) {
					toast.error(errorMessage(e), { title: "连接失败" });
				} finally {
					setBusy(false);
				}
			}}
		>
			{label}
		</Button>
	);
}

/**
 * Renders `children` only when the workspace's server is connected (files, terminal and git
 * all go through the remote agent); otherwise a loading or "服务器未连接" state.
 */
export function WorkspaceGate({ title, children }: { title: string; children: (ctx: WorkspaceContext) => ReactNode }) {
	const { workspace, server, serversLoaded } = useWorkspaceRoute();
	if (!workspace || (!server && !serversLoaded)) return <LoadingBlock />;
	if (!server) {
		return <EmptyState icon={<ServerCrash />} title="找不到服务器" description="该工作区所属的服务器已不存在。" />;
	}
	const { connection, error, deployState } = server.status;
	if (connection === "connecting") return <LoadingBlock text={`正在连接 ${server.config.name}…`} />;
	if (connection !== "connected") {
		return (
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<EmptyState
					icon={<CloudOff />}
					title="服务器未连接"
					description={
						<>
							{title}需要通过 SSH 连接到 <span className="text-fg">{server.config.name}</span>。
							{connection === "error" && error ? <span className="mt-1 block text-danger">{error}</span> : null}
						</>
					}
					actions={
						<>
							<ConnectButton serverId={server.config.id} />
							<ButtonLink to={paths.server(server.config.id)}>查看服务器</ButtonLink>
						</>
					}
				/>
			</div>
		);
	}
	if (deployState === "not_deployed") {
		return (
			<EmptyState
				icon={<ServerCrash />}
				title="服务器尚未部署 pi"
				description="请先在服务器页面完成部署。"
				actions={<ButtonLink to={paths.server(server.config.id)}>前往部署</ButtonLink>}
			/>
		);
	}
	return <>{children({ workspace, server })}</>;
}
