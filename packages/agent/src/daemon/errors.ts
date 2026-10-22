/** Error carrying a machine-readable code; LinkPeer forwards `code`, `message` and `data` to the host. */
export class AgentError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "AgentError";
	}
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function errnoCode(err: unknown): string | undefined {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}
