import { StringDecoder } from "node:string_decoder";

/**
 * Strict JSONL framing as required by pi's RPC protocol: records are split on LF only
 * (an optional preceding CR is stripped). Unlike readline, U+2028/U+2029 inside JSON
 * strings are left alone.
 *
 * Linear in the input size: a partial line is kept as a list of pieces and only the newly
 * decoded text is searched for LF. (Appending to one string and searching it would flatten the
 * whole pending line on every chunk, which is quadratic for multi-megabyte lines such as a
 * get_messages response full of base64 screenshots.)
 */
export class JsonlLineDecoder {
	private readonly decoder = new StringDecoder("utf8");
	/** Pieces of the current, not yet terminated line. */
	private pending: string[] = [];

	push(chunk: Buffer | string): string[] {
		const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines: string[] = [];
		let start = 0;
		let index = text.indexOf("\n");
		while (index >= 0) {
			const piece = text.slice(start, index);
			if (this.pending.length > 0) {
				this.pending.push(piece);
				lines.push(stripCr(this.pending.join("")));
				this.pending = [];
			} else {
				lines.push(stripCr(piece));
			}
			start = index + 1;
			index = text.indexOf("\n", start);
		}
		if (start < text.length) this.pending.push(start === 0 ? text : text.slice(start));
		return lines;
	}

	/** Returns a trailing unterminated line, if any. */
	end(): string[] {
		const tail = this.decoder.end();
		if (tail) this.pending.push(tail);
		const rest = this.pending.join("");
		this.pending = [];
		return rest.length > 0 ? [stripCr(rest)] : [];
	}
}

function stripCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}
