import { describe, expect, it } from "vitest";
import type { SyncItemKey, SyncManifestResult } from "@pi-web/shared";
import type { DesiredEntry, DesiredTree } from "../../src/sync/desired.js";
import { rootsForItems } from "../../src/sync/items.js";
import { computePlan } from "../../src/sync/planner.js";

function desired(
	entries: Array<Partial<DesiredEntry> & { path: string; sha256: string }>,
	items: SyncItemKey[] = ["settings", "extensions", "skills"],
): DesiredTree {
	const map = new Map<string, DesiredEntry>();
	for (const entry of entries) {
		map.set(entry.path, { item: "extensions", size: 10, ...entry });
	}
	return { entries: map, roots: rootsForItems(items), warnings: ["w1", "w1"], externalPaths: [] };
}

function manifest(files: Record<string, string>, managed: Record<string, string>): SyncManifestResult {
	return {
		agentDir: "/r/agent",
		files: Object.fromEntries(Object.entries(files).map(([path, sha256]) => [path, { size: 5, mtimeMs: 0, sha256 }])),
		managed,
	};
}

describe("computePlan", () => {
	it("classifies add, update, unchanged and conflicts", () => {
		const tree = desired([
			{ path: "extensions/new.ts", sha256: "n1" },
			{ path: "extensions/same.ts", sha256: "s1" },
			{ path: "extensions/changed.ts", sha256: "c2" },
			{ path: "extensions/edited-remotely.ts", sha256: "e2" },
			{ path: "extensions/unmanaged.ts", sha256: "u2" },
			{ path: "settings.json", sha256: "set", item: "settings" },
		]);
		const { plan, writes, deletes } = computePlan(
			"s1",
			tree,
			manifest(
				{
					"extensions/same.ts": "s1",
					"extensions/changed.ts": "c1",
					"extensions/edited-remotely.ts": "e-remote",
					"extensions/unmanaged.ts": "u1",
				},
				{ "extensions/same.ts": "s1", "extensions/changed.ts": "c1", "extensions/edited-remotely.ts": "e1" },
			),
		);
		const byPath = Object.fromEntries(plan.entries.map((e) => [e.path, e]));
		expect(byPath["extensions/new.ts"]).toMatchObject({ action: "add", conflict: false });
		expect(byPath["extensions/same.ts"]).toBeUndefined();
		expect(byPath["extensions/changed.ts"]).toMatchObject({ action: "update", conflict: false });
		expect(byPath["extensions/edited-remotely.ts"]).toMatchObject({ action: "update", conflict: true });
		expect(byPath["extensions/edited-remotely.ts"].note).toContain("备份");
		expect(byPath["extensions/unmanaged.ts"]).toMatchObject({ action: "update", conflict: true });
		expect(byPath["settings.json"]).toMatchObject({ action: "add", item: "settings" });
		expect(writes.map((w) => w.path).sort()).toEqual(Object.keys(byPath).sort());
		expect(deletes).toEqual([]);
		expect(plan.summary).toEqual({ add: 2, update: 3, delete: 0, conflict: 2 });
		expect(plan.warnings).toEqual(["w1"]);
		expect(plan.entries.map((e) => e.path)).toEqual([...plan.entries.map((e) => e.path)].sort());
	});

	it("deletes only managed files inside the synced roots", () => {
		const tree = desired([{ path: "extensions/keep.ts", sha256: "k" }]);
		const { plan, deletes } = computePlan(
			"s1",
			tree,
			manifest(
				{
					"extensions/keep.ts": "k",
					"extensions/gone.ts": "g",
					"extensions/gone-edited.ts": "edited",
					"extensions/local-only.ts": "l",
					"prompts/managed.md": "p",
					"external/abc-pkg/index.ts": "x",
				},
				{
					"extensions/keep.ts": "k",
					"extensions/gone.ts": "g",
					"extensions/gone-edited.ts": "orig",
					"extensions/already-removed.ts": "r",
					"prompts/managed.md": "p",
					"external/abc-pkg/index.ts": "x",
				},
			),
		);
		const byPath = Object.fromEntries(plan.entries.map((e) => [e.path, e]));
		expect(byPath["extensions/gone.ts"]).toMatchObject({ action: "delete", conflict: false, item: "extensions" });
		expect(byPath["extensions/gone-edited.ts"]).toMatchObject({ action: "delete", conflict: true });
		// Server-local files and files already gone are never touched.
		expect(byPath["extensions/local-only.ts"]).toBeUndefined();
		expect(byPath["extensions/already-removed.ts"]).toBeUndefined();
		// prompts is disabled: its managed files are not deleted.
		expect(byPath["prompts/managed.md"]).toBeUndefined();
		// external belongs to the (enabled) settings item and is no longer referenced.
		expect(byPath["external/abc-pkg/index.ts"]).toMatchObject({ action: "delete", item: "settings" });
		expect(deletes.sort()).toEqual(["extensions/gone-edited.ts", "extensions/gone.ts", "external/abc-pkg/index.ts"]);
		expect(plan.summary).toEqual({ add: 0, update: 0, delete: 3, conflict: 1 });
	});

	it("never deletes when the owning item is disabled", () => {
		const tree = desired([], ["models"]);
		const { plan } = computePlan(
			"s1",
			tree,
			manifest({ "settings.json": "a", "external/x-y/z": "b", "models.json": "m" }, { "settings.json": "a", "external/x-y/z": "b", "models.json": "m" }),
		);
		expect(plan.entries.map((e) => e.path)).toEqual(["models.json"]);
		expect(plan.entries[0].action).toBe("delete");
	});
});
