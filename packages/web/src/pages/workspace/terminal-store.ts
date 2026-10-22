/**
 * Terminal tab metadata (zustand) and the session registry. Kept free of xterm.js so that
 * code outside the terminal page (e.g. removing a workspace) can close terminals without
 * pulling xterm into the main bundle. Sessions themselves live in terminal-sessions.ts.
 */
import { create } from "zustand";
import type { TerminalStatus } from "./lib/terminal";

export interface TerminalTab {
	id: string;
	workspaceId: string;
	serverId: string;
	/** Remote working directory ("~" for the home directory). */
	cwd: string;
	label: string;
	status: TerminalStatus;
	cols: number;
	rows: number;
	exitCode?: number | null;
	error?: string;
	/** Window title set by the shell (OSC 0/2), if any. */
	title?: string;
}

interface TerminalStoreState {
	tabs: TerminalTab[];
	/** Active tab per workspace. */
	active: Record<string, string>;
}

export const useTerminalStore = create<TerminalStoreState>(() => ({ tabs: [], active: {} }));

export function patchTab(id: string, patch: Partial<TerminalTab>) {
	useTerminalStore.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

/** What the registry needs from a live session. */
export interface DisposableSession {
	dispose(): void;
}

/** Live sessions by tab id (filled by terminal-sessions.ts). */
export const terminalSessions = new Map<string, DisposableSession>();

export function setActiveTerminal(workspaceId: string, id: string): void {
	useTerminalStore.setState((s) => ({ active: { ...s.active, [workspaceId]: id } }));
}

/** Ends the shell and removes the tab; the neighbouring tab becomes active. */
export function closeTerminal(id: string): void {
	terminalSessions.get(id)?.dispose();
	terminalSessions.delete(id);
	useTerminalStore.setState((s) => {
		const tab = s.tabs.find((t) => t.id === id);
		if (!tab) return s;
		const siblings = s.tabs.filter((t) => t.workspaceId === tab.workspaceId);
		const index = siblings.findIndex((t) => t.id === id);
		const rest = s.tabs.filter((t) => t.id !== id);
		const active = { ...s.active };
		if (active[tab.workspaceId] === id) {
			const next = siblings[index + 1] ?? siblings[index - 1];
			if (next && next.id !== id) active[tab.workspaceId] = next.id;
			else delete active[tab.workspaceId];
		}
		return { tabs: rest, active };
	});
}

/** Closes every terminal of a workspace (e.g. when the workspace is removed). */
export function closeWorkspaceTerminals(workspaceId: string): void {
	for (const tab of useTerminalStore.getState().tabs) if (tab.workspaceId === workspaceId) closeTerminal(tab.id);
}
