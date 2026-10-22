import type { FastifyInstance } from "fastify";
import { handleTerminalSocket } from "./terminal.js";
import type { TerminalDeps, TerminalOptions, TerminalQuery } from "./terminal.js";

export { buildTerminalCommand, handleTerminalSocket, remoteShellPath } from "./terminal.js";
export type { TerminalDeps, TerminalOptions, TerminalQuery } from "./terminal.js";

/** GET /ws/term?serverId=…&cwd=…&cols=…&rows=… (WebSocket). Requires @fastify/websocket to be registered. */
export function registerTerminalRoute(app: FastifyInstance, deps: TerminalDeps, options?: TerminalOptions): void {
	app.get<{ Querystring: TerminalQuery }>("/ws/term", { websocket: true }, (socket, request) => {
		void handleTerminalSocket(deps, socket, request.query ?? {}, options);
	});
}
