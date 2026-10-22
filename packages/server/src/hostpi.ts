/** HostPi: access to the host's own pi installation and agent dir configuration. */
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type CreateModelRuntimeOptions, ModelRuntime, VERSION as BUNDLED_PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { AppContext, HostPi, Logger } from "./core/types.js";

export interface HostPiOptions {
	/** Host agent dir, or a getter when it can change at runtime (settings.hostAgentDir). */
	agentDir: string | (() => string);
	log?: Logger;
	/** Executable used for `--version` (default "pi", looked up on PATH). */
	piCommand?: string;
	/** Environment for the version probe (default process.env). */
	env?: NodeJS.ProcessEnv;
	/** Version cache lifetime (default 5 min). */
	versionTtlMs?: number;
	/** Test hook: replaces ModelRuntime.create. */
	createRuntime?: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
}

export type HostPiSource = Pick<AppContext, "paths" | "log"> | HostPiOptions;

const VERSION_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/;

/** Parses the first semver in `pi --version` output. */
export function parsePiVersion(output: string): string | null {
	return VERSION_RE.exec(output)?.[1] ?? null;
}

async function fileSignature(path: string): Promise<string> {
	try {
		const st = await stat(path);
		return `${st.ino}:${st.size}:${st.mtimeMs}`;
	} catch {
		return "-";
	}
}

/**
 * Emits "invalidate" whenever the cached ModelRuntime is dropped (explicitly or because
 * models.json/auth.json changed on disk).
 */
export class HostPiImpl extends EventEmitter implements HostPi {
	private readonly agentDirSource: string | (() => string);
	private readonly log?: Logger;
	private readonly piCommand: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly versionTtlMs: number;
	private readonly createRuntime: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
	private cachedRuntime: { signature: string; promise: Promise<ModelRuntime> } | undefined;
	private cachedVersion: { at: number; promise: Promise<string | null> } | undefined;

	constructor(options: HostPiOptions) {
		super();
		this.agentDirSource = options.agentDir;
		this.log = options.log;
		this.piCommand = options.piCommand ?? "pi";
		this.env = options.env ?? process.env;
		this.versionTtlMs = options.versionTtlMs ?? 5 * 60_000;
		this.createRuntime = options.createRuntime ?? ((opts) => ModelRuntime.create(opts));
	}

	get agentDir(): string {
		return typeof this.agentDirSource === "function" ? this.agentDirSource() : this.agentDirSource;
	}

	get modelsPath(): string {
		return join(this.agentDir, "models.json");
	}

	get authPath(): string {
		return join(this.agentDir, "auth.json");
	}

	version(): Promise<string | null> {
		const now = Date.now();
		if (this.cachedVersion && now - this.cachedVersion.at < this.versionTtlMs) return this.cachedVersion.promise;
		const promise = this.probeVersion();
		this.cachedVersion = { at: now, promise };
		return promise;
	}

	async modelRuntime(): Promise<ModelRuntime> {
		const signature = `${this.agentDir}|${await fileSignature(this.modelsPath)}|${await fileSignature(this.authPath)}`;
		const cached = this.cachedRuntime;
		if (cached && cached.signature === signature) return cached.promise;
		if (cached) this.emit("invalidate");
		const promise = this.createRuntime({ authPath: this.authPath, modelsPath: this.modelsPath, refreshOnCreate: false });
		this.cachedRuntime = { signature, promise };
		promise.catch((err: unknown) => {
			if (this.cachedRuntime?.promise === promise) this.cachedRuntime = undefined;
			this.log?.warn("failed to load host pi model runtime", { error: (err as Error)?.message ?? String(err) });
		});
		return promise;
	}

	invalidate(): void {
		this.cachedRuntime = undefined;
		this.cachedVersion = undefined;
		this.emit("invalidate");
	}

	private async probeVersion(): Promise<string | null> {
		const fromPath = await new Promise<string | null>((resolve) => {
			execFile(
				this.piCommand,
				["--version"],
				{ timeout: 15_000, env: { ...this.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, windowsHide: true },
				(err, stdout, stderr) => resolve(err ? null : parsePiVersion(`${stdout}\n${stderr}`)),
			);
		});
		return fromPath ?? (BUNDLED_PI_VERSION && BUNDLED_PI_VERSION !== "0.0.0" ? BUNDLED_PI_VERSION : null);
	}
}

export function createHostPi(source: HostPiSource): HostPiImpl {
	if ("paths" in source) {
		const ctx = source;
		return new HostPiImpl({ agentDir: () => ctx.paths.hostAgentDir, log: ctx.log.child("hostpi") });
	}
	return new HostPiImpl(source);
}
