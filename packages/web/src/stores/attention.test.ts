import type { ConversationView } from "@pi-web/shared";
import { afterEach, describe, expect, it } from "vitest";
import { noteConversationChange, setViewing, useAttentionStore } from "./attention";

function view(convId: string, status: ConversationView["info"]["status"], sessionId = `s-${convId}`): ConversationView {
	return {
		convId,
		serverId: "srv",
		workspaceId: "ws",
		info: { convId, cwd: "/w", status, startedAt: 0, lastActivityAt: 0, lastSeq: 0, pendingUi: [], statuses: {}, widgets: {}, sessionId },
	} as ConversationView;
}

afterEach(() => useAttentionStore.setState({ unread: {} }));

describe("attention", () => {
	it("marks finished runs and new dialogs of conversations the user is not looking at", () => {
		const path = () => null;
		noteConversationChange(view("a", "running"), view("a", "idle"), path);
		noteConversationChange(view("b", "running"), view("b", "waiting_ui"), path);
		noteConversationChange(view("c", "idle"), view("c", "idle"), path);
		noteConversationChange(undefined, view("d", "idle"), path);
		expect(useAttentionStore.getState().unread).toEqual({
			"s-a": { reason: "done", serverId: "srv", workspaceId: "ws" },
			"s-b": { reason: "waiting", serverId: "srv", workspaceId: "ws" },
		});
	});

	it("leaves the open conversation alone and clears it when it is opened", () => {
		const path = () => null;
		const stop = setViewing("a", "s-a");
		noteConversationChange(view("a", "running"), view("a", "idle"), path);
		expect(useAttentionStore.getState().unread).toEqual({});
		stop();
		noteConversationChange(view("a", "running"), view("a", "idle"), path);
		expect(useAttentionStore.getState().unread).toEqual({ "s-a": { reason: "done", serverId: "srv", workspaceId: "ws" } });
		setViewing("a", "s-a")();
		expect(useAttentionStore.getState().unread).toEqual({});
	});
});
