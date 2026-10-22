import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { KeyedQueue, writeFileAtomic } from "./store.js";
import type { HostPaths, Logger, Secrets } from "./types.js";

interface EncryptedEntry {
	iv: string;
	tag: string;
	data: string;
}
interface SecretsFile {
	version: 1;
	entries: Record<string, EncryptedEntry>;
}

const ALGORITHM = "aes-256-gcm";

export function encryptSecret(key: Buffer, name: string, value: string): EncryptedEntry {
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	cipher.setAAD(Buffer.from(name, "utf8"));
	const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function decryptSecret(key: Buffer, name: string, entry: EncryptedEntry): string {
	const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, "base64"));
	decipher.setAAD(Buffer.from(name, "utf8"));
	decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
}

async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * AES-256-GCM encrypted secrets in dataDir/secrets.json, keyed by dataDir/master.key
 * (32 random bytes, hex, mode 0600). The entry name is bound as additional
 * authenticated data so ciphertexts cannot be swapped between keys.
 */
export class FileSecrets implements Secrets {
	private readonly keyFile: string;
	private readonly secretsFile: string;
	private readonly queue = new KeyedQueue();
	private masterKey?: Promise<Buffer>;
	private entries?: Promise<Record<string, EncryptedEntry>>;

	constructor(
		dataDir: string,
		private readonly log?: Logger,
	) {
		this.keyFile = path.join(dataDir, "master.key");
		this.secretsFile = path.join(dataDir, "secrets.json");
	}

	async get(key: string): Promise<string | undefined> {
		const entries = await this.load();
		const entry = entries[key];
		if (!entry) return undefined;
		try {
			return decryptSecret(await this.key(), key, entry);
		} catch {
			this.log?.error("failed to decrypt secret (master.key changed or file corrupt)", { secret: key });
			return undefined;
		}
	}

	set(key: string, value: string): Promise<void> {
		return this.queue.run("secrets", async () => {
			const entries = await this.load();
			entries[key] = encryptSecret(await this.key(), key, value);
			await this.save(entries);
		});
	}

	delete(key: string): Promise<void> {
		return this.queue.run("secrets", async () => {
			const entries = await this.load();
			if (!(key in entries)) return;
			delete entries[key];
			await this.save(entries);
		});
	}

	/** Names of the stored secrets (values stay encrypted). */
	async keys(): Promise<string[]> {
		return Object.keys(await this.load());
	}

	private load(): Promise<Record<string, EncryptedEntry>> {
		this.entries ??= (async () => {
			const text = await readIfExists(this.secretsFile);
			if (!text) return {};
			try {
				const parsed = JSON.parse(text) as Partial<SecretsFile>;
				return parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
			} catch {
				this.log?.error("secrets.json is corrupt; ignoring it", { file: this.secretsFile });
				return {};
			}
		})();
		this.entries.catch(() => {
			this.entries = undefined;
		});
		return this.entries;
	}

	private key(): Promise<Buffer> {
		this.masterKey ??= this.queue.run("master.key", async () => {
			const text = await readIfExists(this.keyFile);
			if (text !== undefined) {
				const key = Buffer.from(text.trim(), "hex");
				if (key.length !== 32) throw new Error(`invalid master key in ${this.keyFile}`);
				await chmod(this.keyFile, 0o600).catch(() => {});
				return key;
			}
			const key = randomBytes(32);
			await writeFileAtomic(this.keyFile, `${key.toString("hex")}\n`, 0o600);
			return key;
		});
		this.masterKey.catch(() => {
			this.masterKey = undefined;
		});
		return this.masterKey;
	}

	private async save(entries: Record<string, EncryptedEntry>): Promise<void> {
		const file: SecretsFile = { version: 1, entries };
		await writeFileAtomic(this.secretsFile, `${JSON.stringify(file, null, "\t")}\n`, 0o600);
	}
}

export function createSecrets(paths: Pick<HostPaths, "dataDir">, options: { log?: Logger } = {}): FileSecrets {
	return new FileSecrets(paths.dataDir, options.log);
}

/** Secret key naming conventions (see Secrets in core/types.ts). */
export const secretKeys = {
	serverSecret: (serverId: string) => `server:${serverId}:secret`,
	proxyToken: (serverId: string) => `server:${serverId}:proxyToken`,
	accessToken: "accessToken",
} as const;
