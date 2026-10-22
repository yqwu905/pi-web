import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSecrets, createSecrets, decryptSecret, encryptSecret } from "../../src/core/secrets.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-web-secrets-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("secrets", () => {
	it("round-trips values and never stores plaintext", async () => {
		const secrets = createSecrets({ dataDir: dir });
		expect(await secrets.get("server:a:secret")).toBeUndefined();
		await secrets.set("server:a:secret", "hunter2-密码");
		await secrets.set("accessToken", "tok");
		expect(await secrets.get("server:a:secret")).toBe("hunter2-密码");
		const raw = await readFile(path.join(dir, "secrets.json"), "utf8");
		expect(raw).not.toContain("hunter2");
		expect((await stat(path.join(dir, "master.key"))).mode & 0o777).toBe(0o600);
		expect((await stat(path.join(dir, "secrets.json"))).mode & 0o777).toBe(0o600);

		const reopened = new FileSecrets(dir);
		expect(await reopened.get("server:a:secret")).toBe("hunter2-密码");
		await reopened.delete("server:a:secret");
		expect(await new FileSecrets(dir).get("server:a:secret")).toBeUndefined();
		expect(await new FileSecrets(dir).get("accessToken")).toBe("tok");
	});

	it("handles concurrent writes", async () => {
		const secrets = createSecrets({ dataDir: dir });
		await Promise.all(Array.from({ length: 20 }, (_, i) => secrets.set(`k${i}`, `v${i}`)));
		const reopened = new FileSecrets(dir);
		for (let i = 0; i < 20; i++) expect(await reopened.get(`k${i}`)).toBe(`v${i}`);
	});

	it("binds ciphertexts to their key name", () => {
		const key = Buffer.alloc(32, 7);
		const entry = encryptSecret(key, "a", "value");
		expect(decryptSecret(key, "a", entry)).toBe("value");
		expect(() => decryptSecret(key, "b", entry)).toThrow();
	});

	it("returns undefined when the master key changed", async () => {
		const secrets = createSecrets({ dataDir: dir });
		await secrets.set("x", "y");
		await writeFile(path.join(dir, "master.key"), `${Buffer.alloc(32, 1).toString("hex")}\n`);
		expect(await new FileSecrets(dir).get("x")).toBeUndefined();
	});
});
