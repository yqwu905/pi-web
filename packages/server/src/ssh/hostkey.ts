import { createHash } from "node:crypto";
import type { HostKeyInfo } from "@pi-web/shared";

export type HostKeyStatus = "trusted" | "unknown" | "mismatch";

/** Reads the key type, the first SSH `string` of a public key blob (e.g. "ssh-ed25519"). */
export function parseHostKeyAlgorithm(key: Buffer): string {
	if (key.length < 4) return "unknown";
	const len = key.readUInt32BE(0);
	if (len <= 0 || len > 64 || key.length < 4 + len) return "unknown";
	const name = key.subarray(4, 4 + len).toString("latin1");
	return /^[\x21-\x7e]+$/.test(name) ? name : "unknown";
}

/** OpenSSH-style fingerprint: "SHA256:" + unpadded base64 of sha256(blob). */
export function hostKeyFingerprint(key: Buffer): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function hostKeyInfo(key: Buffer): HostKeyInfo {
	return { algorithm: parseHostKeyAlgorithm(key), fingerprint: hostKeyFingerprint(key) };
}

/** Parses an OpenSSH public key line ("ssh-ed25519 AAAA… comment") into its blob. */
export function parsePublicKeyLine(line: string): Buffer | null {
	const parts = line.trim().split(/\s+/);
	for (const part of parts) {
		if (/^AAAA[0-9A-Za-z+/]+={0,3}$/.test(part)) return Buffer.from(part, "base64");
	}
	return null;
}

function normalizeFingerprint(fp: string): string {
	const trimmed = fp.trim();
	const body = trimmed.startsWith("SHA256:") ? trimmed.slice(7) : trimmed;
	return `SHA256:${body.replace(/=+$/, "")}`;
}

export function compareHostKey(trusted: Pick<HostKeyInfo, "fingerprint"> | undefined, actual: HostKeyInfo): HostKeyStatus {
	if (!trusted?.fingerprint) return "unknown";
	return normalizeFingerprint(trusted.fingerprint) === normalizeFingerprint(actual.fingerprint) ? "trusted" : "mismatch";
}
