/**
 * Pi-Web companion extension, loaded into every pi process with `-e pi-web-ext.mjs`.
 * It exposes hidden commands for operations pi's RPC protocol lacks. The agent sends
 * `/pi-web-<action> <json>` as a prompt; results are reported through
 * ctx.ui.setStatus("pi-web:result", JSON.stringify({ reqId, ok, error?, cancelled? })).
 *
 * The interfaces below are the structural subset of pi's ExtensionAPI /
 * ExtensionCommandContext (dist/core/extensions/types.d.ts) this extension uses.
 */
import { COMPANION_COMMAND_PREFIX, COMPANION_STATUS_KEY } from "@pi-web/shared";

interface CompanionUi {
	setStatus(key: string, text: string | undefined): void;
}

interface CompanionCommandContext {
	readonly ui: CompanionUi;
	waitForIdle(): Promise<void>;
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;
	reload(): Promise<void>;
}

interface CompanionApi {
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: CompanionCommandContext) => Promise<void> },
	): void;
	setLabel(entryId: string, label: string | undefined): void;
}

interface ActionOutcome {
	cancelled?: boolean;
}

type Payload = Record<string, unknown> & { reqId?: unknown };

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function stringArg(payload: Payload, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function requiredArg(payload: Payload, key: string): string {
	const value = stringArg(payload, key);
	if (!value) throw new Error(`missing argument: ${key}`);
	return value;
}

export default function piWebCompanion(pi: CompanionApi): void {
	const register = (action: string, run: (payload: Payload, ctx: CompanionCommandContext) => Promise<ActionOutcome | void>) => {
		pi.registerCommand(`${COMPANION_COMMAND_PREFIX}${action}`, {
			description: "Pi-Web internal command",
			handler: async (args, ctx) => {
				// Capture ui first: after ctx.reload() the old ctx is stale and its getters throw.
				const ui = ctx.ui;
				let payload: Payload;
				try {
					const parsed = JSON.parse(args) as unknown;
					payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Payload) : {};
				} catch {
					payload = {};
				}
				const reqId = typeof payload.reqId === "string" ? payload.reqId : "";
				let result: { reqId: string; ok: boolean; error?: string; cancelled?: boolean };
				try {
					const outcome = (await run(payload, ctx)) ?? {};
					result = { reqId, ok: true };
					if (outcome.cancelled !== undefined) result.cancelled = outcome.cancelled;
				} catch (err) {
					result = { reqId, ok: false, error: errorText(err) };
				}
				ui.setStatus(COMPANION_STATUS_KEY, JSON.stringify(result));
			},
		});
	};

	register("navigate", async (payload, ctx) => {
		const targetId = requiredArg(payload, "targetId");
		await ctx.waitForIdle();
		const result = await ctx.navigateTree(targetId, {
			summarize: payload.summarize === true,
			customInstructions: stringArg(payload, "customInstructions"),
			label: stringArg(payload, "label"),
		});
		return { cancelled: result.cancelled };
	});

	register("label", async (payload) => {
		const entryId = requiredArg(payload, "entryId");
		pi.setLabel(entryId, stringArg(payload, "label"));
	});

	register("reload", async (_payload, ctx) => {
		await ctx.waitForIdle();
		await ctx.reload();
	});
}
