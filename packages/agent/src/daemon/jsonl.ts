import { StringDecoder } from "node:string_decoder";

/**
 * Strict JSONL framing as required by pi's RPC protocol: records are split on LF only
 * (an optional preceding CR is stripped). Unlike readline, U+2028/U+2029 inside JSON
 * strings are left alone.
 */
export class JsonlLineDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	/** Buffer offset up to which no LF exists (avoids rescanning long partial lines). */
	private scanned = 0;

	push(chunk: Buffer | string): string[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines: string[] = [];
		let start = 0;
		let index = this.buffer.indexOf("\n", this.scanned);
		while (index >= 0) {
			lines.push(stripCr(this.buffer.slice(start, index)));
			start = index + 1;
			index = this.buffer.indexOf("\n", start);
		}
		if (start > 0) this.buffer = this.buffer.slice(start);
		this.scanned = this.buffer.length;
		return lines;
	}

	/** Returns a trailing unterminated line, if any. */
	end(): string[] {
		this.buffer += this.decoder.end();
		const rest = this.buffer;
		this.buffer = "";
		this.scanned = 0;
		return rest.length > 0 ? [stripCr(rest)] : [];
	}
}

function stripCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}
