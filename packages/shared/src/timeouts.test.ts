import { describe, expect, it } from "vitest";
import {
	companionActionTimeout,
	CONV_START_TIMEOUT_MS,
	defaultCommandTimeout,
	LONG_RPC_TIMEOUT_MS,
	RPC_TIMEOUT_MS,
} from "./timeouts.js";

describe("conversation timeouts", () => {
	it("gives long-running commands and extension slash commands the long timeout", () => {
		expect(defaultCommandTimeout({ type: "get_state" })).toBe(RPC_TIMEOUT_MS);
		expect(defaultCommandTimeout({ type: "prompt", message: "hello /x" })).toBe(RPC_TIMEOUT_MS);
		expect(defaultCommandTimeout({ type: "prompt", message: "/deploy now" })).toBe(LONG_RPC_TIMEOUT_MS);
		for (const type of ["compact", "export_html", "abort", "bash", "fork", "clone", "new_session", "switch_session"]) {
			expect(defaultCommandTimeout({ type })).toBe(LONG_RPC_TIMEOUT_MS);
		}
	});

	it("lets navigate and reload wait for pi to become idle", () => {
		expect(companionActionTimeout("label")).toBe(RPC_TIMEOUT_MS);
		expect(companionActionTimeout("reload")).toBe(LONG_RPC_TIMEOUT_MS);
		expect(companionActionTimeout("navigate")).toBe(LONG_RPC_TIMEOUT_MS);
	});

	it("leaves room for the initial get_state inside the start budget", () => {
		expect(CONV_START_TIMEOUT_MS).toBeGreaterThan(RPC_TIMEOUT_MS + 5_000);
	});
});
