import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Layout of the remote install root R (see IMPLEMENTATION.md §2.2). */
export interface RemotePaths {
	root: string;
	daemonDir: string;
	binDir: string;
	defaultAgentDir: string;
	runDir: string;
	socket: string;
	lockFile: string;
	proxyEnv: string;
	/** Server-level env (AgentConfig.extraEnv) for R/bin/pi and the web terminal. */
	envFile: string;
	logsDir: string;
	agentLog: string;
	daemonOut: string;
	stateDir: string;
	configFile: string;
	syncManifest: string;
	hashCache: string;
	backupDir: string;
	incomingDir: string;
	exportsDir: string;
	trashSessionsDir: string;
}

export function remotePaths(root: string): RemotePaths {
	const runDir = join(root, "run");
	const logsDir = join(root, "logs");
	const stateDir = join(root, "state");
	return {
		root,
		daemonDir: join(root, "daemon"),
		binDir: join(root, "bin"),
		defaultAgentDir: join(root, "agent"),
		runDir,
		socket: join(runDir, "agent.sock"),
		lockFile: join(runDir, "agent.pid"),
		proxyEnv: join(runDir, "proxy.env"),
		envFile: join(runDir, "env.sh"),
		logsDir,
		agentLog: join(logsDir, "agent.log"),
		daemonOut: join(logsDir, "daemon.out"),
		stateDir,
		configFile: join(stateDir, "config.json"),
		syncManifest: join(stateDir, "sync-manifest.json"),
		hashCache: join(stateDir, "hash-cache.json"),
		backupDir: join(stateDir, "backup"),
		incomingDir: join(stateDir, "incoming"),
		exportsDir: join(stateDir, "exports"),
		trashSessionsDir: join(root, "trash", "sessions"),
	};
}

/** Creates the daemon's own directories with mode 0700. */
export async function ensureRemoteDirs(paths: RemotePaths): Promise<void> {
	const dirs = [
		paths.root,
		paths.runDir,
		paths.logsDir,
		paths.stateDir,
		paths.backupDir,
		paths.incomingDir,
		paths.exportsDir,
		join(paths.root, "trash"),
		paths.trashSessionsDir,
	];
	for (const dir of dirs) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700).catch(() => {});
	}
}
