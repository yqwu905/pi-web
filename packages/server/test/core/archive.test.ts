import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionSummary } from "@pi-web/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activeSessionCount,
	applyArchiveMarks,
	archiveSession,
	archivedSessions,
	forgetArchivedServer,
	unarchiveSession,
} from "../../src/core/archive.js";
import { JsonStore } from "../../src/core/store.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-web-archive-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const summary = (file: string): SessionSummary => ({ file, id: file, cwd: "/w", createdMs: 1, modifiedMs: 1, messageCount: 0, firstMessage: "" });

describe("archived session records", () => {
	it("persist in state.json across store instances and are removed with the last record", async () => {
		const store = new JsonStore(dir);
		expect(await archiveSession(store, "s1", "/a.jsonl", 100)).toBe(100);
		expect(await archiveSession(store, "s1", "/a.jsonl", 200)).toBe(100);
		await archiveSession(store, "s2", "/b.jsonl", 300);
		await store.flush();

		const reloaded = new JsonStore(dir);
		expect(archivedSessions(reloaded, "s1")).toEqual({ "/a.jsonl": { archivedAt: 100 } });
		expect(archivedSessions(reloaded, "s2")).toEqual({ "/b.jsonl": { archivedAt: 300 } });

		expect(await unarchiveSession(reloaded, "s1", "/a.jsonl")).toBe(true);
		expect(await unarchiveSession(reloaded, "s1", "/a.jsonl")).toBe(false);
		await forgetArchivedServer(reloaded, "s2");
		await reloaded.flush();
		expect(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"))).toEqual({});
	});

	it("marks listed sessions and prunes only the workspace's vanished files", async () => {
		const store = new JsonStore(dir);
		await archiveSession(store, "s1", "/w/a.jsonl", 10);
		await archiveSession(store, "s1", "/v/b.jsonl", 10);
		const marked = await applyArchiveMarks(store, "s1", "/w", [summary("/w/a.jsonl"), summary("/w/c.jsonl")], 50);
		expect(marked.map((s) => s.archivedAt)).toEqual([10, undefined]);
		expect(activeSessionCount(store, "s1", ["/w/a.jsonl", "/w/c.jsonl"])).toBe(1);
		expect(archivedSessions(store, "s1")["/w/a.jsonl"]).toEqual({ archivedAt: 10, cwd: "/w" });

		await applyArchiveMarks(store, "s1", "/w", [summary("/w/c.jsonl")], 50);
		expect(Object.keys(archivedSessions(store, "s1"))).toEqual(["/v/b.jsonl"]);
		expect(activeSessionCount(store, "s1", ["/w/a.jsonl", "/w/c.jsonl"])).toBe(2);
	});

	it("keeps the records of a directory the list did not read (the session directory changed)", async () => {
		const store = new JsonStore(dir);
		const old = "/r/agent/sessions/--w--/a.jsonl";
		await archiveSession(store, "s1", old, 10);
		await applyArchiveMarks(store, "s1", "/w", [summary(old), summary("/r/agent/sessions/--w--/b.jsonl")], 50);
		expect(archivedSessions(store, "s1")[old]).toEqual({ archivedAt: 10, cwd: "/w" });

		// e.g. agentDirMode switched to shared: the agent now lists ~/.pi/agent/sessions/--w--.
		await applyArchiveMarks(store, "s1", "/w", [summary("/home/u/.pi/agent/sessions/--w--/x.jsonl")], 50);
		// An empty list does not show the directory was read either.
		await applyArchiveMarks(store, "s1", "/w", [], 50);
		expect(archivedSessions(store, "s1")[old]).toEqual({ archivedAt: 10, cwd: "/w" });

		// Back to the old directory: still archived, and pruned once that directory lists without it.
		const back = await applyArchiveMarks(store, "s1", "/w", [summary(old)], 50);
		expect(back[0]?.archivedAt).toBe(10);
		await applyArchiveMarks(store, "s1", "/w", [summary("/r/agent/sessions/--w--/b.jsonl")], 50);
		expect(archivedSessions(store, "s1")).toEqual({});
	});
});
