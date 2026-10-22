/** Cross-page links of the workspace views (chat prefill, Git selection). */
import type { GitArea } from "@pi-web/shared";
import { paths } from "../../../lib/routes";

/**
 * Chat URL with `?prefill=` text for the composer. Goes to `sessionId` when given (the
 * workspace's last opened conversation), otherwise to a new conversation.
 */
export function chatPrefillPath(workspaceId: string, text: string, sessionId?: string): string {
	return `${paths.chat(workspaceId, sessionId)}?${new URLSearchParams({ prefill: text }).toString()}`;
}

/** "@src/a.py"; paths with whitespace are quoted. */
export function mentionText(relativePath: string): string {
	return /\s/.test(relativePath) ? `@"${relativePath.replace(/"/g, '\\"')}"` : `@${relativePath}`;
}

/** Git tab with a file preselected (`path` relative to the repository root). */
export function gitFilePath(workspaceId: string, path?: string, area?: GitArea): string {
	const params = new URLSearchParams();
	if (path) params.set("path", path);
	if (path && area) params.set("area", area);
	const qs = params.toString();
	return `${paths.git(workspaceId)}${qs ? `?${qs}` : ""}`;
}
