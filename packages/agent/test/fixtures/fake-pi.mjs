#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc`, speaking the JSONL protocol on stdin/stdout.
// Behaviour is driven by prompt text and env flags so tests can exercise every path:
//   prompt "ask" / "ask-timeout"  → confirm dialog (answered via extension_ui_response)
//   prompt "crash"                → stderr output and exit(3)
//   prompt "flood"                → 60 stderr lines at once
//   prompt "slow"                 → never answers
//   prompt "/pi-web-<action> {…}" → companion result via setStatus("pi-web:result")
//   anything else                 → a streamed assistant reply
// Env: FAKE_PI_NO_COMPANION, FAKE_PI_COMPANION_SILENT, FAKE_PI_IGNORE_STDIN_END, FAKE_PI_IGNORE_SIGTERM
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const argv = process.argv.slice(2);
const argValue = (flag) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};

const state = {
	sessionFile: argValue("--session") ?? `/tmp/fake-pi-sessions/${randomUUID()}.jsonl`,
	sessionId: randomUUID(),
	sessionName: argValue("--name"),
	isStreaming: false,
	messages: [],
};
const pendingUi = new Map();

function write(obj, crlf = false) {
	process.stdout.write(JSON.stringify(obj) + (crlf ? "\r\n" : "\n"));
}
function respond(id, command, data, success = true, error) {
	const r = { id, type: "response", command, success };
	if (data !== undefined) r.data = data;
	if (error) r.error = error;
	write(r);
}
function getState() {
	return {
		model: { id: "fake-model", provider: "fake", api: "openai-completions" },
		thinkingLevel: argValue("--thinking") ?? "off",
		isStreaming: state.isStreaming,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionFile: state.sessionFile,
		sessionId: state.sessionId,
		sessionName: state.sessionName,
		autoCompactionEnabled: true,
		messageCount: state.messages.length,
		pendingMessageCount: 0,
	};
}

function streamReply(text) {
	const now = Date.now();
	const user = { role: "user", content: text, timestamp: now };
	state.messages.push(user);
	state.isStreaming = true;
	write({ type: "agent_start" }, true);
	write({ type: "message_start", message: user });
	write({ type: "message_end", message: user });
	const assistant = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: now + 1,
	};
	write({ type: "message_start", message: assistant });
	write({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
	write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
	write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo world" } });
	const final = { ...assistant, content: [{ type: "text", text: "Hello world" }], stopReason: "stop" };
	write({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello world" } });
	write({ type: "message_end", message: final });
	state.messages.push(final);
	write({ type: "agent_end", messages: [user, final] });
	state.isStreaming = false;
	write({ type: "agent_settled", aborted: false });
}

function companion(id, message) {
	const space = message.indexOf(" ");
	const name = message.slice(1, space < 0 ? undefined : space);
	const payload = space < 0 ? {} : JSON.parse(message.slice(space + 1));
	if (!process.env.FAKE_PI_COMPANION_SILENT) {
		const result = { reqId: payload.reqId, ok: true };
		if (name === "pi-web-label" && payload.entryId === "missing") {
			result.ok = false;
			result.error = "Entry missing not found";
		}
		if (name === "pi-web-navigate") result.cancelled = false;
		write({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: "pi-web:result", statusText: JSON.stringify(result) });
	}
	respond(id, "prompt", { disposition: "handled" });
}

function handle(cmd) {
	const { id, type } = cmd;
	switch (type) {
		case "get_state":
			return respond(id, type, getState());
		case "get_messages":
			return respond(id, type, { messages: state.messages });
		case "get_session_stats":
			return respond(id, type, { sessionId: state.sessionId, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: state.messages.length, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
		case "get_commands":
			return respond(id, type, {
				commands: process.env.FAKE_PI_NO_COMPANION
					? []
					: ["pi-web-navigate", "pi-web-label", "pi-web-reload"].map((name) => ({ name, source: "extension" })),
			});
		case "debug_env":
			return respond(id, type, {
				argv,
				cwd: process.cwd(),
				env: Object.fromEntries(
					Object.entries(process.env).filter(([k]) => /PROXY|^PI_|^PATH$|^EXTRA_|^WS_/i.test(k)),
				),
			});
		case "set_session_name":
			state.sessionName = cmd.name;
			write({ type: "session_info_changed", name: cmd.name });
			return respond(id, type);
		case "new_session":
			state.sessionFile = `/tmp/fake-pi-sessions/${randomUUID()}.jsonl`;
			state.sessionId = randomUUID();
			state.messages = [];
			return respond(id, type, { cancelled: false });
		case "prompt": {
			const message = String(cmd.message ?? "");
			if (message.startsWith("/pi-web-")) return companion(id, message);
			if (message === "slow") return;
			if (message === "crash") {
				process.stderr.write("fatal: boom\n");
				respond(id, type, { disposition: "started" });
				setTimeout(() => process.exit(3), 20);
				return;
			}
			if (message === "flood") {
				for (let i = 0; i < 60; i++) process.stderr.write(`line ${i}\n`);
				return respond(id, type, { disposition: "handled" });
			}
			if (message === "ask" || message === "ask-timeout") {
				respond(id, type, { disposition: "started" });
				state.isStreaming = true;
				write({ type: "agent_start" });
				const uiId = randomUUID();
				const request = { type: "extension_ui_request", id: uiId, method: "confirm", title: "Allow?", message: "Run it" };
				if (message === "ask-timeout") request.timeout = 200;
				pendingUi.set(uiId, () => {
					state.isStreaming = false;
					write({ type: "agent_settled", aborted: false });
				});
				write(request);
				if (message === "ask-timeout") {
					setTimeout(() => {
						const done = pendingUi.get(uiId);
						pendingUi.delete(uiId);
						done?.();
					}, 200);
				}
				return;
			}
			respond(id, type, { disposition: "started" });
			setTimeout(() => streamReply(message), 5);
			return;
		}
		default:
			return respond(id, type, undefined, false, `Unknown command: ${type}`);
	}
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).replace(/\r$/, "");
		buffer = buffer.slice(index + 1);
		if (line.trim()) {
			let cmd;
			try {
				cmd = JSON.parse(line);
			} catch (err) {
				respond(undefined, "parse", undefined, false, `Failed to parse command: ${err.message}`);
				continue;
			}
			if (cmd.type === "extension_ui_response") {
				const done = pendingUi.get(cmd.id);
				pendingUi.delete(cmd.id);
				done?.();
			} else {
				handle(cmd);
			}
		}
		index = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => {
	if (process.env.FAKE_PI_IGNORE_STDIN_END) return;
	setTimeout(() => process.exit(0), 10);
});
process.on("SIGTERM", () => {
	if (process.env.FAKE_PI_IGNORE_SIGTERM) return;
	process.exit(143);
});
if (process.env.FAKE_PI_IGNORE_STDIN_END) setInterval(() => {}, 1000);
process.stderr.write("fake-pi ready\n");
