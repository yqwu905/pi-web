/** How the file viewer presents an fs/read result. */
import type { FsReadResult } from "@pi-web/shared";
import { formatBytes, formatRelativeTime } from "../../../lib/format";
import { imageMimeType, isImagePath, isMarkdownPath, languageFromPath, languageLabel } from "../../../lib/languages";

export type PreviewKind =
	/** Raster image delivered as base64. */
	| "image"
	/** SVG text: image preview with a source toggle. */
	| "svg"
	| "markdown"
	| "code"
	/** Binary content that cannot be previewed (or an image cut off by the size limit). */
	| "binary";

export function previewKind(path: string, read: Pick<FsReadResult, "binary" | "truncated" | "encoding">): PreviewKind {
	const svg = /\.svg$/i.test(path);
	if (svg && !read.binary) return read.truncated ? "code" : "svg";
	if (read.binary || read.encoding === "base64") {
		return isImagePath(path) && imageMimeType(path) && !read.truncated ? "image" : "binary";
	}
	if (isMarkdownPath(path)) return "markdown";
	return "code";
}

/** data: URL for an image preview. */
export function imageDataUrl(path: string, read: Pick<FsReadResult, "content" | "encoding">): string | null {
	if (/\.svg$/i.test(path) && read.encoding === "utf8") return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(read.content)}`;
	const mime = imageMimeType(path);
	if (!mime || read.encoding !== "base64") return null;
	return `data:${mime};base64,${read.content}`;
}

export function countLines(text: string): number {
	if (!text) return 0;
	let n = 1;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return text.endsWith("\n") ? n - 1 : n;
}

/** "Python · 36 行 · 1.3 KB · UTF-8 · 修改于 5 分钟前" (parts joined with " · "). */
export function fileMetaText(path: string, read: FsReadResult, now: number = Date.now()): string {
	const kind = previewKind(path, read);
	const parts: string[] = [];
	if (kind === "image" || kind === "binary") {
		parts.push(kind === "image" ? (imageMimeType(path) ?? "图片") : "二进制");
	} else {
		parts.push(languageLabel(languageFromPath(path), path));
		if (!read.truncated) parts.push(`${countLines(read.content)} 行`);
	}
	parts.push(formatBytes(read.size));
	parts.push(read.encoding === "utf8" ? "UTF-8" : "base64");
	if (read.mtimeMs) parts.push(`修改于 ${formatRelativeTime(read.mtimeMs, now)}`);
	return parts.join(" · ");
}
