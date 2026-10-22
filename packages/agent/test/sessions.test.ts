import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeCwdForSessions } from "@pi-web/shared";
import { SessionsHandler } from "../src/daemon/handlers/sessions.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

let root: string;
let agentDir: string;
let trashDir: string;
let running: Map<string, string>;
let handler: SessionsHandler;
const cwd = "/home/dev/project";

function jsonl(records: unknown[]): string {
	return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

const header = (id: string, ts: string, extra: Record<string, unknown> = {}) => ({ type: "session", version: 3, id, timestamp: ts, cwd, ...extra });
const msg = (id: string, parentId: string | null, role: string, content: unknown, timestamp: number) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(timestamp).toISOString(),
	message: { role, content, timestamp },
});

beforeEach(async () => {
	root = await tempDir();
	agentDir = join(root, "agent");
	trashDir = join(root, "trash", "sessions");
	running = new Map();
	handler = new SessionsHandler({ getAgentDir: () => agentDir, findRunning: (f) => running.get(f), trashDir });
});

afterEach(cleanupTempDirs);

async function writeSession(dir: string, name: string, records: unknown[]): Promise<string> {
	await mkdir(dir, { recursive: true });
	const file = join(dir, name);
	await writeFile(file, jsonl(records));
	return file;
}

describe("sessions.list", () => {
	it("summarizes session files and sorts by last activity", async () => {
		const dir = join(agentDir, "sessions", encodeCwdForSessions(cwd));
		const longText = "x".repeat(300);
		const older = await writeSession(dir, "2026-01-01_a.jsonl", [
			header("a", "2026-01-01T00:00:00.000Z"),
			msg("1", null, "user", [{ type: "text", text: "first question" }], Date.parse("2026-01-01T00:00:01Z")),
			msg("2", "1", "assistant", [{ type: "text", text: "answer" }], Date.parse("2026-01-01T00:00:02Z")),
			{ type: "session_info", id: "3", parentId: "2", timestamp: "2026-01-01T00:00:03Z", name: "Old name" },
			{ type: "session_info", id: "4", parentId: "3", timestamp: "2026-01-01T00:00:04Z", name: " Final " },
		]);
		const newer = await writeSession(dir, "2026-02-01_b.jsonl", [
			header("b", "2026-02-01T00:00:00.000Z", { parentSession: older }),
			msg("1", null, "user", longText, Date.parse("2026-02-01T00:00:05Z")),
		]);
		await writeSession(dir, "broken.jsonl", [{ type: "message", id: "x" }]);
		await writeFile(join(dir, "notes.txt"), "ignored");
		running.set(newer, "conv-1");

		const { sessions } = await handler.list({ cwd });
		expect(sessions.map((s) => s.id)).toEqual(["b", "a"]);
		const [b, a] = sessions;
		expect(a).toMatchObject({
			file: older,
			cwd,
			name: "Final",
			messageCount: 2,
			firstMessage: "first question",
			createdMs: Date.parse("2026-01-01T00:00:00.000Z"),
			modifiedMs: Date.parse("2026-01-01T00:00:02Z"),
		});
		expect(a.runningConvId).toBeUndefined();
		expect(b.runningConvId).toBe("conv-1");
		expect(b.parentSession).toBe(older);
		expect(b.firstMessage).toHaveLength(201);
		expect(await handler.list({ cwd: "/other" })).toEqual({ sessions: [] });
	});

	it("uses the cache until size or mtime change", async () => {
		const dir = join(agentDir, "sessions", encodeCwdForSessions(cwd));
		const file = await writeSession(dir, "s.jsonl", [header("s", "2026-01-01T00:00:00Z"), msg("1", null, "user", "one", 1)]);
		expect((await handler.list({ cwd })).sessions[0].messageCount).toBe(1);
		const st = await stat(file);
		await writeFile(file, jsonl([header("s", "2026-01-01T00:00:00Z"), msg("1", null, "user", "two", 1), msg("2", "1", "user", "three", 2)]));
		await utimes(file, st.atime, new Date(st.mtimeMs + 5000));
		expect((await handler.list({ cwd })).sessions[0].messageCount).toBe(2);
	});

	it("honours a custom sessionDir setting and filters by cwd", async () => {
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: join(root, "custom") }));
		await writeSession(join(root, "custom"), "a.jsonl", [header("mine", "2026-01-01T00:00:00Z")]);
		await writeSession(join(root, "custom"), "b.jsonl", [{ ...header("theirs", "2026-01-01T00:00:00Z"), cwd: "/elsewhere" }]);
		expect((await handler.list({ cwd })).sessions.map((s) => s.id)).toEqual(["mine"]);
		expect((await handler.location("/w")).dir).toBe(join(root, "custom"));
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "rel/sessions" }));
		expect((await handler.location("/w")).dir).toBe("/w/rel/sessions");
	});
});

describe("sessions.read", () => {
	it("returns entries, the last entry as leaf and the active branch", async () => {
		const file = await writeSession(join(root, "x"), "t.jsonl", [
			header("t", "2026-01-01T00:00:00Z"),
			msg("u1", null, "user", "q1", 1),
			msg("a1", "u1", "assistant", [{ type: "text", text: "r1" }], 2),
			msg("u2", "a1", "user", "branch A", 3),
			msg("u3", "a1", "user", "branch B", 4),
			msg("a3", "u3", "assistant", [{ type: "text", text: "rB" }], 5),
			{ type: "label", id: "l1", parentId: "a3", timestamp: "2026-01-01T00:00:06Z", targetId: "u2", label: "keep" },
		]);
		// a garbage line and an unterminated CRLF-free last record
		await writeFile(file, 'not json\n{"type":"custom","id":"c1","parentId":"l1","timestamp":"2026-01-01T00:00:07Z","customType":"x"}', { flag: "a" });
		const result = await handler.read({ file });
		expect(result.header?.id).toBe("t");
		expect(result.entries.map((e) => e.id)).toEqual(["u1", "a1", "u2", "u3", "a3", "l1", "c1"]);
		expect(result.leafId).toBe("c1");
		expect(result.branchIds).toEqual(["u1", "a1", "u3", "a3", "l1", "c1"]);
		await expect(handler.read({ file: join(root, "nope.jsonl") })).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("sessions.delete", () => {
	it("moves files to the trash and refuses running sessions", async () => {
		const file = await writeSession(join(root, "y"), "d.jsonl", [header("d", "2026-01-01T00:00:00Z")]);
		running.set(file, "conv-9");
		await expect(handler.delete({ file })).rejects.toMatchObject({ code: "BUSY" });
		running.clear();
		const { trashedTo } = await handler.delete({ file });
		expect(trashedTo.startsWith(trashDir)).toBe(true);
		expect(trashedTo.endsWith("-d.jsonl")).toBe(true);
		await expect(stat(file)).rejects.toThrow();
		expect(await readdir(trashDir)).toHaveLength(1);
	});
});
