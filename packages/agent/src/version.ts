declare const __AGENT_VERSION__: string | undefined;

/** Injected by build.mjs; "0.0.0-dev" when running from source (tests). */
export const AGENT_VERSION: string = typeof __AGENT_VERSION__ === "string" ? __AGENT_VERSION__ : "0.0.0-dev";
