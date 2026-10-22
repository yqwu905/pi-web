/** Stages the files of a plan, uploads them as one tar.gz and asks the agent to apply it. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { create as tarCreate } from "tar";
import type { SyncApplyParams, SyncApplyResult } from "@pi-web/shared";
import type { AgentClient, ServerConnection } from "../core/types.js";
import type { DesiredEntry } from "./desired.js";
import { sha256 } from "./hash-cache.js";
import type { ComputedPlan } from "./planner.js";
import { isWithin } from "./walk.js";

export const SYNC_APPLY_TIMEOUT_MS = 10 * 60_000;

export interface ExecuteOptions {
	computed: ComputedPlan;
	connection: Pick<ServerConnection, "upload">;
	client: Pick<AgentClient, "call">;
	/** Absolute remote install root. */
	remoteRoot: string;
	/** Host scratch directory (paths.tmpDir). */
	tmpDir: string;
	runId: string;
	backupLabel: string;
	signal?: AbortSignal;
}

async function copyAndHash(source: string, target: string): Promise<string> {
	const hash = createHash("sha256");
	const tap = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		},
	});
	await pipeline(createReadStream(source), tap, createWriteStream(target));
	return hash.digest("hex");
}

async function stageEntry(stageDir: string, entry: DesiredEntry): Promise<SyncApplyParams["writes"][number]> {
	const target = join(stageDir, entry.path);
	if (!isWithin(stageDir, target) || target === stageDir) throw new Error(`invalid sync path: ${entry.path}`);
	await mkdir(dirname(target), { recursive: true });
	if (entry.link !== undefined) {
		await symlink(entry.link, target);
		return { path: entry.path, sha256: entry.sha256, link: entry.link };
	}
	let digest: string;
	if (entry.content) {
		await writeFile(target, entry.content);
		digest = sha256(entry.content);
	} else if (entry.source) {
		digest = await copyAndHash(entry.source, target);
	} else {
		throw new Error(`desired entry without content: ${entry.path}`);
	}
	const mode = entry.mode ?? 0o644;
	await chmod(target, mode);
	return { path: entry.path, sha256: digest, mode };
}

export async function executePlan(options: ExecuteOptions): Promise<SyncApplyResult> {
	const { computed, runId } = options;
	const stageDir = join(options.tmpDir, `sync-${runId}`);
	const archive = join(options.tmpDir, `sync-${runId}.tar.gz`);
	try {
		let archivePath: string | null = null;
		const writes: SyncApplyParams["writes"] = [];
		if (computed.writes.length > 0) {
			await mkdir(stageDir, { recursive: true, mode: 0o700 });
			for (const entry of computed.writes) {
				options.signal?.throwIfAborted();
				writes.push(await stageEntry(stageDir, entry));
			}
			await tarCreate({ gzip: true, cwd: stageDir, portable: true, file: archive }, writes.map((w) => w.path));
			archivePath = posix.join(options.remoteRoot, "state", "incoming", `${runId}.tar.gz`);
			options.signal?.throwIfAborted();
			await options.connection.upload(archive, archivePath, { mode: 0o600, signal: options.signal });
		}
		const params: SyncApplyParams = { archivePath, writes, deletes: computed.deletes, backupLabel: options.backupLabel };
		return await options.client.call("sync.apply", params, { timeoutMs: SYNC_APPLY_TIMEOUT_MS });
	} finally {
		await rm(stageDir, { recursive: true, force: true }).catch(() => {});
		await rm(archive, { force: true }).catch(() => {});
	}
}
