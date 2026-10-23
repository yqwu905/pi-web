import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { deleteSession, errorMessage } from "../../../api/client";
import { invalidateSessions } from "../../../api/hooks";
import { Button, Callout, Modal, toast } from "../../../components/ui";
import { useUiStore } from "../../../stores/ui";

export interface DeleteSessionTarget {
	serverId: string | null;
	sessionFile: string | undefined;
	workspaceId: string | undefined;
	/** Ids the session is remembered under (route id, live session id). */
	sessionIds: readonly string[];
	/** A live pi process serves the file: it is stopped first. */
	isLive: boolean;
	stop: () => Promise<void>;
}

/**
 * Moves a session file to the server's trash (`~/.pi-web/trash`), stopping its pi process first.
 * Used by the chat view (DeleteSessionDialog) and the sidebar's archived sessions.
 */
export function DeleteSessionModal({
	open,
	onClose,
	target,
	title,
	onDeleted,
}: {
	open: boolean;
	onClose: () => void;
	target: DeleteSessionTarget;
	title: string;
	onDeleted: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [prevOpen, setPrevOpen] = useState(open);
	if (prevOpen !== open) {
		setPrevOpen(open);
		if (open) setError(null);
	}
	const { serverId, sessionFile, workspaceId, sessionIds, isLive, stop } = target;

	const remove = async () => {
		if (!serverId || !sessionFile || busy) return;
		setBusy(true);
		setError(null);
		try {
			// The agent refuses to delete a file a running pi process still writes to.
			if (isLive) await stop();
			await deleteSession(serverId, sessionFile);
			if (workspaceId) {
				// The 对话 tab, "/" and the Files/Git links must not lead back to the deleted session.
				for (const id of sessionIds) useUiStore.getState().forgetSession(workspaceId, id);
				void invalidateSessions(workspaceId);
			}
			toast.success("会话已移到服务器的回收站");
			onClose();
			onDeleted();
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			open={open}
			role="alertdialog"
			size="sm"
			onClose={onClose}
			icon={<TriangleAlert className="text-warning" />}
			title="删除会话？"
			description={
				<>
					<span className="text-fg">{title}</span> 的会话文件将移到服务器上的 <code className="text-xs text-fg-code">~/.pi-web/trash</code>
					，可以从那里手动恢复。{isLive ? "正在运行的 pi 进程会先被停止。" : ""}
				</>
			}
			footer={
				<>
					<Button onClick={onClose} data-autofocus>
						取消
					</Button>
					<Button variant="danger" loading={busy} disabled={!serverId || !sessionFile} onClick={() => void remove()}>
						删除
					</Button>
				</>
			}
		>
			{error && (
				<Callout tone="danger" title="删除失败">
					{error}
				</Callout>
			)}
		</Modal>
	);
}
