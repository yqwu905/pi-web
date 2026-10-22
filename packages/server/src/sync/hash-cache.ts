/** sha256 cache for host files keyed by (path, size, mtimeMs), persisted in the store state. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Platform of a native addon (*.node), detected from its binary header. */
export type NativeKind = "linux-x64" | "linux-arm64" | "linux-other" | "darwin" | "win32" | "unknown";

export interface HashCacheEntry {
	size: number;
	mtimeMs: number;
	sha256: string;
	native?: NativeKind;
	/** Last time the entry was used (entries unused for a week are pruned). */
	seenAt: number;
}

export interface HashResult {
	sha256: string;
	native?: NativeKind;
}

export interface HashCachePersistence {
	load(): Record<string, HashCacheEntry> | undefined;
	save(data: Record<string, HashCacheEntry>): Promise<void>;
}

const PRUNE_AFTER_MS = 7 * 24 * 3600_000;

export function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function linkSha256(target: string): string {
	return sha256(`symlink:${target}`);
}

export function classifyNative(header: Buffer): NativeKind {
	if (header.length >= 20 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
		const littleEndian = header[5] !== 2;
		const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
		if (machine === 62) return "linux-x64";
		if (machine === 183) return "linux-arm64";
		return "linux-other";
	}
	if (header.length >= 4) {
		const magic = header.readUInt32BE(0);
		if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return "darwin";
	}
	if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) return "win32";
	return "unknown";
}

/** Hash a file by streaming it; also classifies native addons. */
export async function hashFile(path: string): Promise<HashResult> {
	const hash = createHash("sha256");
	let header: Buffer | undefined;
	const wantHeader = path.endsWith(".node");
	for await (const chunk of createReadStream(path)) {
		const buf = chunk as Buffer;
		if (wantHeader && !header) header = Buffer.from(buf.subarray(0, 64));
		hash.update(buf);
	}
	const result: HashResult = { sha256: hash.digest("hex") };
	if (wantHeader) result.native = classifyNative(header ?? Buffer.alloc(0));
	return result;
}

export class HashCache {
	private data: Map<string, HashCacheEntry> | undefined;
	private dirty = false;
	private saveTimer: NodeJS.Timeout | undefined;
	private saving: Promise<void> = Promise.resolve();

	constructor(
		private readonly persistence: HashCachePersistence,
		private readonly saveDelayMs = 2000,
	) {}

	async hash(path: string, size: number, mtimeMs: number): Promise<HashResult> {
		const data = this.load();
		const now = Date.now();
		const cached = data.get(path);
		if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
			if (now - cached.seenAt > 3600_000) {
				cached.seenAt = now;
				this.markDirty();
			}
			return { sha256: cached.sha256, native: cached.native };
		}
		const result = await hashFile(path);
		data.set(path, { size, mtimeMs, sha256: result.sha256, native: result.native, seenAt: now });
		this.markDirty();
		return result;
	}

	/** Persist pending changes now. */
	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (!this.dirty || !this.data) return this.saving;
		this.dirty = false;
		const cutoff = Date.now() - PRUNE_AFTER_MS;
		const out: Record<string, HashCacheEntry> = {};
		for (const [path, entry] of this.data) {
			if (entry.seenAt >= cutoff) out[path] = entry;
			else this.data.delete(path);
		}
		this.saving = this.saving.then(() => this.persistence.save(out)).catch(() => {});
		return this.saving;
	}

	private load(): Map<string, HashCacheEntry> {
		if (!this.data) {
			let stored: Record<string, HashCacheEntry> | undefined;
			try {
				stored = this.persistence.load();
			} catch {
				stored = undefined;
			}
			this.data = new Map(Object.entries(stored ?? {}));
		}
		return this.data;
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush();
		}, this.saveDelayMs);
		this.saveTimer.unref?.();
	}
}
