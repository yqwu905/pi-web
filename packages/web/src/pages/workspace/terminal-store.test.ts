import { beforeEach, describe, expect, it } from "vitest";
import { closeTerminal, closeWorkspaceTerminals, setActiveTerminal, type TerminalTab, terminalSessions, useTerminalStore } from "./terminal-store";

const tab = (id: string, workspaceId: string): TerminalTab => ({
	id,
	workspaceId,
	serverId: "s1",
	cwd: "/w",
	label: id,
	status: "connected",
	cols: 80,
	rows: 24,
});

const disposed: string[] = [];

function seed(tabs: TerminalTab[], active: Record<string, string>) {
	terminalSessions.clear();
	for (const t of tabs) terminalSessions.set(t.id, { dispose: () => disposed.push(t.id) });
	useTerminalStore.setState({ tabs, active });
}

describe("terminal store", () => {
	beforeEach(() => {
		disposed.length = 0;
		seed([tab("a", "w1"), tab("b", "w1"), tab("c", "w1"), tab("x", "w2")], { w1: "b", w2: "x" });
	});

	it("activates the next tab when the active one closes", () => {
		closeTerminal("b");
		expect(disposed).toEqual(["b"]);
		expect(terminalSessions.has("b")).toBe(false);
		const s = useTerminalStore.getState();
		expect(s.tabs.map((t) => t.id)).toEqual(["a", "c", "x"]);
		expect(s.active.w1).toBe("c");
	});

	it("falls back to the previous tab, then to none", () => {
		closeTerminal("c");
		expect(useTerminalStore.getState().active.w1).toBe("b");
		setActiveTerminal("w1", "a");
		closeTerminal("b");
		expect(useTerminalStore.getState().active.w1).toBe("a");
		closeTerminal("x");
		expect(useTerminalStore.getState().active.w2).toBeUndefined();
	});

	it("closes every terminal of a workspace", () => {
		closeWorkspaceTerminals("w1");
		expect(disposed.sort()).toEqual(["a", "b", "c"]);
		const s = useTerminalStore.getState();
		expect(s.tabs.map((t) => t.id)).toEqual(["x"]);
		expect(s.active).toEqual({ w2: "x" });
	});

	it("ignores unknown ids", () => {
		const before = useTerminalStore.getState();
		closeTerminal("nope");
		expect(useTerminalStore.getState()).toBe(before);
	});
});
