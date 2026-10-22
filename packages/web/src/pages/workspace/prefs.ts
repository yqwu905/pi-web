/** Persisted view preferences of the workspace pages (files, git, terminal). */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { DiffMode } from "../../components/DiffView";
import { DEFAULT_TERMINAL_FONT_SIZE } from "./lib/terminal";

interface WorkspacePrefs {
	hideIgnored: boolean;
	showHidden: boolean;
	diffMode: DiffMode;
	terminalFontSize: number;
	set(patch: Partial<Omit<WorkspacePrefs, "set">>): void;
}

export const useWorkspacePrefs = create<WorkspacePrefs>()(
	persist(
		(set) => ({
			hideIgnored: true,
			showHidden: false,
			diffMode: "inline",
			terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
			set: (patch) => set(patch),
		}),
		{
			name: "pi-web:workspace-views",
			version: 1,
			storage: createJSONStorage(() => localStorage),
			partialize: (s) => ({ hideIgnored: s.hideIgnored, showHidden: s.showHidden, diffMode: s.diffMode, terminalFontSize: s.terminalFontSize }),
		},
	),
);
