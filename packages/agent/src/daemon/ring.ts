/**
 * FIFO with a fixed item capacity and an optional byte budget; the oldest items are
 * dropped first (at least the newest item is always kept).
 */
export class RingBuffer<T> {
	private readonly items: Array<T | undefined>;
	private readonly sizes: number[];
	private start = 0;
	private count = 0;
	private bytes = 0;

	constructor(
		readonly capacity: number,
		readonly maxBytes = Number.POSITIVE_INFINITY,
	) {
		if (capacity < 1) throw new Error("capacity must be >= 1");
		this.items = new Array<T | undefined>(capacity);
		this.sizes = new Array<number>(capacity).fill(0);
	}

	get size(): number {
		return this.count;
	}

	get totalBytes(): number {
		return this.bytes;
	}

	push(item: T, bytes = 0): void {
		if (this.count === this.capacity) this.shift();
		const index = (this.start + this.count) % this.capacity;
		this.items[index] = item;
		this.sizes[index] = bytes;
		this.bytes += bytes;
		this.count++;
		while (this.count > 1 && this.bytes > this.maxBytes) this.shift();
	}

	first(): T | undefined {
		return this.count > 0 ? this.items[this.start] : undefined;
	}

	toArray(): T[] {
		const out: T[] = [];
		for (let i = 0; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity] as T);
		return out;
	}

	/** Items for which `predicate` holds, scanning from the newest end until it fails. */
	tailWhile(predicate: (item: T) => boolean): T[] {
		const out: T[] = [];
		for (let i = this.count - 1; i >= 0; i--) {
			const item = this.items[(this.start + i) % this.capacity] as T;
			if (!predicate(item)) break;
			out.push(item);
		}
		return out.reverse();
	}

	private shift(): void {
		this.bytes -= this.sizes[this.start];
		this.items[this.start] = undefined;
		this.sizes[this.start] = 0;
		this.start = (this.start + 1) % this.capacity;
		this.count--;
	}
}
