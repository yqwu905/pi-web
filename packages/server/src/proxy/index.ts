export { createTunnelProxy, normalizeDomainPattern, type TunnelProxyContext, type TunnelProxyOptions } from "./tunnel-proxy.js";
export { collectProviderDomains, DYNAMIC_PROVIDER_DOMAINS } from "./domains.js";
export { matchesNoProxy, parseNoProxy } from "./no-proxy.js";
export { dialUpstream, selectUpstreamProxy } from "./upstream.js";
