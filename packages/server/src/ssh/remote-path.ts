import { posix } from "node:path";
import { shellQuote } from "@pi-web/shared";

/**
 * Quotes a remote path for sh, keeping a leading "~" expandable
 * ("~/a b" → "$HOME"/'a b').
 */
export function shPath(p: string): string {
	if (p === "~") return '"$HOME"';
	if (p.startsWith("~/")) {
		const rest = p.slice(2);
		return rest ? `"$HOME"/${shellQuote(rest)}` : '"$HOME"';
	}
	return shellQuote(p);
}

/** SFTP does not expand "~"; relative paths resolve against the login directory instead. */
export function sftpPath(p: string): string {
	if (p === "~") return ".";
	if (p.startsWith("~/")) return p.slice(2) || ".";
	return p;
}

/** Resolves "~" against a known remote home and normalizes the result. */
export function resolveRemotePath(p: string, home: string): string {
	let out = p.trim();
	if (out === "~") out = home;
	else if (out.startsWith("~/")) out = posix.join(home, out.slice(2));
	else if (!out.startsWith("/")) out = posix.join(home, out);
	out = posix.normalize(out);
	return out.length > 1 ? out.replace(/\/+$/, "") : out;
}

/** Escapes a value for use inside a double-quoted sh string. */
export function dq(value: string): string {
	return value.replace(/[\\"$`]/g, "\\$&");
}
