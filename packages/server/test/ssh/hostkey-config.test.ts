import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareHostKey, hostKeyFingerprint, hostKeyInfo, parseHostKeyAlgorithm, parsePublicKeyLine } from "../../src/ssh/hostkey.js";
import { dq, resolveRemotePath, sftpPath, shPath } from "../../src/ssh/remote-path.js";
import { parseJumpSpec, parseSshConfig, tokenizeArgs } from "../../src/ssh/ssh-config.js";

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-web-hostkey-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("host key fingerprints", () => {
	for (const type of ["ed25519", "ecdsa", "rsa"]) {
		it(`matches ssh-keygen -l for ${type}`, async () => {
			const keyFile = path.join(dir, `id_${type}`);
			execFileSync("ssh-keygen", ["-q", "-t", type, "-N", "", "-f", keyFile]);
			const blob = parsePublicKeyLine(await readFile(`${keyFile}.pub`, "utf8"))!;
			const expected = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", `${keyFile}.pub`], { encoding: "utf8" }).split(/\s+/)[1];
			expect(hostKeyFingerprint(blob)).toBe(expected);
			const algorithm = parseHostKeyAlgorithm(blob);
			expect(algorithm).toBe(type === "ed25519" ? "ssh-ed25519" : type === "rsa" ? "ssh-rsa" : "ecdsa-sha2-nistp256");
			expect(hostKeyInfo(blob)).toEqual({ algorithm, fingerprint: expected });
		});
	}

	it("handles garbage", () => {
		expect(parseHostKeyAlgorithm(Buffer.from([0, 0]))).toBe("unknown");
		expect(parseHostKeyAlgorithm(Buffer.from([0xff, 0xff, 0xff, 0xff, 1]))).toBe("unknown");
		expect(parsePublicKeyLine("nothing here")).toBeNull();
	});

	it("compares fingerprints tolerating padding", () => {
		const actual = { algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" };
		expect(compareHostKey(undefined, actual)).toBe("unknown");
		expect(compareHostKey({ fingerprint: "SHA256:abc=" }, actual)).toBe("trusted");
		expect(compareHostKey({ fingerprint: "SHA256:abd" }, actual)).toBe("mismatch");
	});
});

describe("ssh config", () => {
	const text = `
# global
User fallback
ServerAliveInterval 30

Host bastion
  HostName bastion.example.com
  User jump
  Port 2200
  IdentityFile ~/.ssh/jump_key

Host dev prod !bad
  HostName %h.internal
  ProxyJump bastion
  IdentityFile "~/.ssh/my key"

Host prod
  Port=2222
  User root

Host *.example.com !secret.example.com
  User wildcard

Host *
  IdentityFile ~/.ssh/default
  Port 22

Match host foo
  User matched

Host plain
`;

	it("extracts concrete aliases with ssh precedence", () => {
		const hosts = parseSshConfig(text, { home: "/home/me", readFile: () => null, listDir: () => [] });
		expect(hosts.map((h) => h.alias)).toEqual(["bastion", "dev", "prod", "plain"]);
		const byAlias = Object.fromEntries(hosts.map((h) => [h.alias, h]));
		expect(byAlias.bastion).toEqual({
			alias: "bastion",
			hostName: "bastion.example.com",
			user: "fallback",
			port: 2200,
			identityFile: "~/.ssh/jump_key",
		});
		expect(byAlias.dev).toEqual({
			alias: "dev",
			hostName: "dev.internal",
			user: "fallback",
			port: 22,
			identityFile: "~/.ssh/my key",
			proxyJump: "bastion",
		});
		expect(byAlias.prod.port).toBe(2222);
		expect(byAlias.prod.user).toBe("fallback");
		expect(byAlias.plain).toEqual({ alias: "plain", user: "fallback", port: 22, identityFile: "~/.ssh/default" });
	});

	it("follows Include", () => {
		const files: Record<string, string> = {
			"/home/me/.ssh/config.d/a.conf": "Host included\n  HostName 10.0.0.1\n  User inc\n",
			"/home/me/.ssh/config.d/b.txt": "Host ignored\n",
		};
		const hosts = parseSshConfig("Include config.d/*.conf\nHost after\n", {
			home: "/home/me",
			readFile: (f) => files[f] ?? null,
			listDir: (d) => (d === "/home/me/.ssh/config.d" ? ["a.conf", "b.txt"] : []),
		});
		expect(hosts).toEqual([{ alias: "included", hostName: "10.0.0.1", user: "inc" }, { alias: "after" }]);
	});

	it("tokenizes quoted arguments", () => {
		expect(tokenizeArgs(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
	});

	it("parses jump specs", () => {
		expect(parseJumpSpec("user@host:2200")).toEqual({ user: "user", host: "host", port: 2200 });
		expect(parseJumpSpec("host")).toEqual({ host: "host" });
		expect(parseJumpSpec("[::1]:22")).toEqual({ host: "::1", port: 22 });
	});
});

describe("remote paths", () => {
	it("quotes for sh keeping ~ expandable", () => {
		expect(shPath("~")).toBe('"$HOME"');
		expect(shPath("~/a b")).toBe(`"$HOME"/'a b'`);
		expect(shPath("/x/y")).toBe("/x/y");
		expect(shPath("/x/it's")).toBe(`'/x/it'\\''s'`);
		expect(sftpPath("~/a")).toBe("a");
		expect(resolveRemotePath("~/.pi-web/", "/home/u")).toBe("/home/u/.pi-web");
		expect(resolveRemotePath("rel", "/home/u")).toBe("/home/u/rel");
		expect(dq('a"$b`\\')).toBe('a\\"\\$b\\`\\\\');
	});
});
