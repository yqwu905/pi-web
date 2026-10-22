/** Allowlist of LLM provider host names derived from the host pi configuration. */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Providers whose endpoints are dynamic (per account, region or resource): allowed by wildcard. */
export const DYNAMIC_PROVIDER_DOMAINS: readonly string[] = [
	"*.githubcopilot.com",
	"chatgpt.com",
	"*.chatgpt.com",
	"*.openai.azure.com",
	"*.cognitiveservices.azure.com",
	"*.ai.azure.com",
	"*.amazonaws.com",
];

/** Added only when one of these providers is configured on the host (Vertex AI uses regional hosts). */
export const GOOGLE_WILDCARD = "*.googleapis.com";
const GOOGLE_WILDCARD_PROVIDERS = ["google-vertex"];

const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function hostnameOf(url: unknown): string | undefined {
	if (typeof url !== "string" || url.includes("{") || url.includes("}")) return undefined;
	try {
		const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return host && (HOSTNAME_RE.test(host) || host.includes(":")) ? host : undefined;
	} catch {
		return undefined;
	}
}

type RuntimeLike = Pick<ModelRuntime, "getProviders" | "checkAuth">;

export async function collectProviderDomains(runtime: RuntimeLike): Promise<string[]> {
	const domains = new Set<string>();
	for (const provider of runtime.getProviders()) {
		const providerHost = hostnameOf(provider.baseUrl);
		if (providerHost) domains.add(providerHost);
		let models: readonly { baseUrl?: unknown }[] = [];
		try {
			models = provider.getAllModels?.() ?? provider.getModels();
		} catch {
			models = [];
		}
		for (const model of models) {
			const host = hostnameOf(model.baseUrl);
			if (host) domains.add(host);
		}
	}
	for (const domain of DYNAMIC_PROVIDER_DOMAINS) domains.add(domain);
	for (const providerId of GOOGLE_WILDCARD_PROVIDERS) {
		const configured = await runtime.checkAuth(providerId).catch(() => undefined);
		if (configured) {
			domains.add(GOOGLE_WILDCARD);
			break;
		}
	}
	return [...domains].sort();
}
