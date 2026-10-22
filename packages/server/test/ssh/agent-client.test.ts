import { describe, expect, it } from "vitest";
import { LinkRequestError } from "@pi-web/shared/link";
import { ApiError } from "../../src/core/errors.js";
import { linkErrorToApiError } from "../../src/ssh/agent-client.js";

const status = (code: string) => (linkErrorToApiError(new LinkRequestError(code, "boom"), "m") as ApiError).status;

describe("linkErrorToApiError", () => {
	it("maps the agent's error codes to HTTP statuses", () => {
		expect(status("CONV_NOT_FOUND")).toBe(404);
		expect(status("SESSION_NOT_FOUND")).toBe(404);
		expect(status("CWD_NOT_FOUND")).toBe(404);
		expect(status("CONV_EXITED")).toBe(409);
		expect(status("NOT_A_REPO")).toBe(409);
		expect(status("COMPANION_UNAVAILABLE")).toBe(409);
		expect(status("BAD_PARAMS")).toBe(400);
		expect(status("BAD_PATH")).toBe(400);
		expect(status("NOT_CONFIGURED")).toBe(503);
		expect(status("TIMEOUT")).toBe(504);
		expect(status("GIT_FAILED")).toBe(502);
	});

	it("keeps code, message and data", () => {
		const err = linkErrorToApiError(new LinkRequestError("CONV_EXITED", "已退出", { x: 1 }), "conv.send") as ApiError;
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 409, code: "CONV_EXITED", details: { x: 1 } });
		expect(err.message).toBe("已退出");
		const closed = linkErrorToApiError(new LinkRequestError("LINK_CLOSED", "closed"), "conv.send") as ApiError;
		expect(closed.status).toBe(503);
		expect(closed.message).toBe("与 Remote Agent 的连接已断开（conv.send）");
		const other = new Error("x");
		expect(linkErrorToApiError(other, "m")).toBe(other);
	});
});
