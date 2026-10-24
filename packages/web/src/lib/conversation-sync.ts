/**
 * Pure helpers for keeping a ConversationState in sync with a live conversation:
 * snapshot → state, ordered event application and gap detection. The reducer itself
 * (applyConvRecord) lives in @pi-web/shared and must not be reimplemented here.
 */
import {
	type ConvEvent,
	type ConversationState,
	type ConvSnapshot,
	type SessionsReadResult,
	applyConvRecord,
	createConversationState,
	entriesToMessages,
} from "@pi-web/shared";

/** Initial ConversationState from an atomic agent snapshot (apply only events with seq > snapshot.seq). */
export function stateFromSnapshot(snapshot: ConvSnapshot): ConversationState {
	const info = snapshot.info;
	return createConversationState({
		messages: snapshot.messages,
		streaming: snapshot.streaming,
		streamingToolArgs: snapshot.streamingToolArgs ?? {},
		tools: Object.fromEntries((snapshot.runningTools ?? []).map((t) => [t.toolCallId, t])),
		queue: snapshot.queue ?? { steering: [], followUp: [] },
		ui: snapshot.ui ?? { pending: [], statuses: {}, widgets: {}, notifications: [] },
		isRunning: snapshot.isRunning,
		isCompacting: snapshot.isCompacting,
		sessionName: info.sessionName ?? snapshot.state.sessionName,
		thinkingLevel: snapshot.state.thinkingLevel,
		status: info.status,
		exited:
			info.status === "exited"
				? { code: info.exitCode ?? null, signal: info.exitSignal ?? null, stderrTail: "" }
				: undefined,
		seq: snapshot.seq,
		timing: snapshot.timing ?? { streaming: null, messages: {} },
	});
}

/** Read-only state for a session file rendered without a pi process. */
export function stateFromSessionFile(file: SessionsReadResult, sessionName?: string): ConversationState {
	return createConversationState({
		messages: entriesToMessages(file.entries, file.branchIds),
		sessionName,
		status: undefined,
	});
}

export type EventDisposition = "apply" | "stale" | "gap";

/** How an incoming event relates to the state's last applied seq. */
export function classifyEvent(stateSeq: number, eventSeq: number): EventDisposition {
	if (eventSeq <= stateSeq) return "stale";
	if (eventSeq === stateSeq + 1) return "apply";
	return "gap";
}

/** Applies events in seq order, skipping ones already reflected in `state`. */
export function applyEvents(state: ConversationState, events: readonly ConvEvent[]): ConversationState {
	if (events.length === 0) return state;
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	let next = state;
	for (const ev of sorted) next = applyConvRecord(next, ev.record, ev.seq, ev.ts);
	return next;
}

/** True when any event in the batch is `agent_settled` (stats should be refreshed). */
export function containsSettled(events: readonly ConvEvent[]): boolean {
	return events.some((e) => e.record.type === "agent_settled");
}
