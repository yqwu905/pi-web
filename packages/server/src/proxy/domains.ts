/**
 * Allowlist of LLM provider endpoints derived from the host pi configuration.
 *
 * Endpoints taken from configured base URLs are exact `host:port` pairs. Providers whose host
 * depends on the account or region are matched by service-specific patterns, never by a
 * registrable-domain wildcard such as `*.amazonaws.com`: anyone can run a server under those
 * (S3 buckets, EC2 public DNS names, API gateways), which would turn the tunnel into general
 * egress. Pattern endpoints are HTTPS only (port 443).
 */
import { isIP } from "node:net";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ProviderEndpoint {
	/** Exact host name/IP, or a pattern (see matchHostPattern). */
	host: string;
	port: number;
	/** True for exact entries taken from a configured base URL. */
	exact: boolean;
}

/** Providers whose endpoints are dynamic (per account, region or resource). */
export const DYNAMIC_PROVIDER_DOMAINS: readonly string[] = [
	"*.githubcopilot.com",
	"chatgpt.com",
	"*.chatgpt.com",
	"*.openai.azure.com",
	"*.cognitiveservices.azure.com",
	"*.ai.azure.com",
	// Amazon Bedrock (runtime + control plane, FIPS, China) and the credential endpoints of the AWS SDK.
	"bedrock-runtime.{aws-region}.amazonaws.com",
	"bedrock-runtime-fips.{aws-region}.amazonaws.com",
	"bedrock.{aws-region}.amazonaws.com",
	"bedrock-fips.{aws-region}.amazonaws.com",
	"bedrock-runtime.{aws-region}.amazonaws.com.cn",
	"bedrock.{aws-region}.amazonaws.com.cn",
	"sts.amazonaws.com",
	"sts.{aws-region}.amazonaws.com",
	"portal.sso.{aws-region}.amazonaws.com",
	"oidc.{aws-region}.amazonaws.com",
	// Google Vertex AI (regional and global endpoints) and Google's OAuth/STS endpoints.
	"{gcp-region}-aiplatform.googleapis.com",
	"aiplatform.googleapis.com",
	"oauth2.googleapis.com",
	"sts.googleapis.com",
	"iamcredentials.googleapis.com",
];

const PATTERN_TOKENS: Record<string, string> = {
	// us-east-1, eu-central-2, us-gov-west-1, cn-north-1, us-isob-east-1
	"{aws-region}": "[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}",
	// us-central1, europe-west4, northamerica-northeast1
	"{gcp-region}": "[a-z]+(?:-[a-z]+)*[0-9]{1,2}",
};

const patternCache = new Map<string, RegExp>();

function compilePattern(pattern: string): RegExp {
	let re = patternCache.get(pattern);
	if (re) return re;
	let source = "";
	let rest = pattern;
	if (rest.startsWith("*.")) {
		// "*.example.com": example.com itself or any subdomain of it.
		source = "(?:[a-z0-9_-]+\\.)*";
		rest = rest.slice(2);
	}
	source += rest
		.split(/(\{[a-z0-9-]+\})/)
		.map((part) => PATTERN_TOKENS[part] ?? part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("");
	re = new RegExp(`^${source}$`);
	patternCache.set(pattern, re);
	return re;
}

/** Matches a host against an exact name, "*.domain" or a pattern with {aws-region}/{gcp-region}. */
export function matchHostPattern(host: string, pattern: string): boolean {
	const h = host.toLowerCase().replace(/\.$/, "");
	const p = pattern.trim().toLowerCase();
	if (!p) return false;
	if (!p.includes("*") && !p.includes("{")) return h === p;
	return compilePattern(p).test(h);
}

/** True when host:port is one of the endpoints. */
export function matchProviderEndpoint(host: string, port: number, endpoints: readonly ProviderEndpoint[]): ProviderEndpoint | undefined {
	return endpoints.find((e) => e.port === port && matchHostPattern(host, e.host));
}

export function formatEndpoint(endpoint: Pick<ProviderEndpoint, "host" | "port">): string {
	return isIP(endpoint.host) === 6 ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`;
}

const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Host and port of a base URL ("https://h/v1" → h:443); undefined for templated or invalid hosts. */
export function endpointOf(url: unknown): { host: string; port: number } | undefined {
	if (typeof url !== "string") return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (!host || host.includes("{") || host.includes("%7b") || !(HOSTNAME_RE.test(host) || isIP(host))) return undefined;
	const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
	return { host, port };
}

/** Host name of a base URL (undefined for templated or invalid hosts). */
export function hostnameOf(url: unknown): string | undefined {
	return endpointOf(url)?.host;
}

type RuntimeLike = Pick<ModelRuntime, "getProviders">;

export function dynamicProviderEndpoints(): ProviderEndpoint[] {
	return DYNAMIC_PROVIDER_DOMAINS.map((host) => ({ host, port: 443, exact: false }));
}

export async function collectProviderEndpoints(runtime: RuntimeLike): Promise<ProviderEndpoint[]> {
	const byKey = new Map<string, ProviderEndpoint>();
	const add = (url: unknown) => {
		const endpoint = endpointOf(url);
		if (endpoint) byKey.set(formatEndpoint(endpoint), { ...endpoint, exact: true });
	};
	for (const provider of runtime.getProviders()) {
		add(provider.baseUrl);
		let models: readonly { baseUrl?: unknown }[] = [];
		try {
			models = provider.getAllModels?.() ?? provider.getModels();
		} catch {
			models = [];
		}
		for (const model of models) add(model.baseUrl);
	}
	for (const endpoint of dynamicProviderEndpoints()) byKey.set(`${endpoint.host}:${endpoint.port}`, endpoint);
	return [...byKey.values()].sort((a, b) => formatEndpoint(a).localeCompare(formatEndpoint(b)));
}

/** Display form of the endpoints ("host:port"). */
export async function collectProviderDomains(runtime: RuntimeLike): Promise<string[]> {
	return (await collectProviderEndpoints(runtime)).map(formatEndpoint);
}
