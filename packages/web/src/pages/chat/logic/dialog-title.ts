/**
 * Extension titles can span lines (a question with its option list or previews under it):
 * the first non-empty line is the heading, the rest is shown under it as is.
 */
export function splitDialogTitle(title: string): { heading: string; detail: string } {
	const lines = title.replace(/\r\n?/g, "\n").split("\n");
	const first = lines.findIndex((line) => line.trim());
	if (first < 0) return { heading: title, detail: "" };
	return { heading: lines[first], detail: lines.slice(first + 1).join("\n").replace(/^\s*\n/, "").trimEnd() };
}
