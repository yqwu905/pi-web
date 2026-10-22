import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createHostPi, parsePiVersion } from "../../src/hostpi.js";
import { makePaths, noopLogger, put, tempDir } from "../sync/fakes.js";

function installedPiVersion(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		try {
			const file = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
			return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
		} catch {
			if (dirname(dir) === dir) throw new Error("pi-coding-agent not installed");
			dir = dirname(dir);
		}
	}
}

describe("HostPi.version", () => {
	it("parses pi --version output", () => {
		expect(parsePiVersion("1.4.0\n")).toBe("1.4.0");
		expect(parsePiVersion("pi v1.5.0-beta.1 (node 22)")).toBe("1.5.0-beta.1");
		expect(parsePiVersion("nothing")).toBeNull();
	});

	it("uses pi on PATH when available", async () => {
		const dir = await tempDir();
		const script = join(dir, "pi");
		await put(script, "#!/bin/sh\n[ \"$1\" = \"--version\" ] && echo 9.8.7\n", 0o755);
		const hostPi = createHostPi({ agentDir: dir, piCommand: script });
		expect(await hostPi.version()).toBe("9.8.7");
	});

	it("falls back to the installed dependency's version", async () => {
		const dir = await tempDir();
		const hostPi = createHostPi({ agentDir: dir, piCommand: join(dir, "no-such-pi") });
		expect(await hostPi.version()).toBe(installedPiVersion());
	});
});

describe("HostPi.modelRuntime", () => {
	it("caches the runtime and recreates it when models.json or auth.json change", async () => {
		const dir = await tempDir();
		await put(join(dir, "models.json"), "{}");
		let n = 0;
		const createRuntime = vi.fn(async () => ({ id: ++n }) as unknown as ModelRuntime);
		const hostPi = createHostPi({ agentDir: dir, createRuntime });
		const invalidations = vi.fn();
		hostPi.on("invalidate", invalidations);

		const first = await hostPi.modelRuntime();
		expect(await hostPi.modelRuntime()).toBe(first);
		expect(createRuntime).toHaveBeenCalledWith({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false });

		await put(join(dir, "models.json"), '{"providers":{}}');
		const second = await hostPi.modelRuntime();
		expect(second).not.toBe(first);
		await put(join(dir, "auth.json"), "{}");
		const third = await hostPi.modelRuntime();
		expect(third).not.toBe(second);
		expect(await hostPi.modelRuntime()).toBe(third);

		hostPi.invalidate();
		expect(await hostPi.modelRuntime()).not.toBe(third);
		expect(createRuntime).toHaveBeenCalledTimes(4);
		expect(invalidations).toHaveBeenCalledTimes(3);
	});

	it("does not cache failures", async () => {
		const dir = await tempDir();
		const createRuntime = vi
			.fn<() => Promise<ModelRuntime>>()
			.mockRejectedValueOnce(new Error("bad models.json"))
			.mockResolvedValue({} as ModelRuntime);
		const hostPi = createHostPi({ agentDir: dir, createRuntime });
		await expect(hostPi.modelRuntime()).rejects.toThrow("bad models.json");
		await expect(hostPi.modelRuntime()).resolves.toEqual({});
	});

	it("loads the real pi ModelRuntime from the agent dir (ctx form)", async () => {
		const dir = await tempDir();
		const agentDir = join(dir, "agent");
		await put(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { mock: { baseUrl: "http://mock-llm.test:8080/v1", api: "openai-completions", apiKey: "x", models: [{ id: "m1" }] } } }),
		);
		const hostPi = createHostPi({ paths: makePaths(agentDir, join(dir, "data")), log: noopLogger });
		expect(hostPi.agentDir).toBe(agentDir);
		const runtime = await hostPi.modelRuntime();
		const mock = runtime.getProviders().find((p) => p.id === "mock");
		expect(mock?.getModels().map((m) => m.baseUrl)).toEqual(["http://mock-llm.test:8080/v1"]);
		expect(runtime.getProviders().some((p) => p.id === "anthropic")).toBe(true);
	});
});
