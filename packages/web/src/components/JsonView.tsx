import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/cn";

export interface JsonViewProps {
	value: unknown;
	/** Nodes deeper than this start collapsed (default 2). */
	collapsedDepth?: number;
	/** Strings longer than this are truncated with a "展开" toggle (default 400). */
	maxStringLength?: number;
	/** Name shown for the root (optional). */
	rootName?: string;
	className?: string;
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
	return typeof v === "object" && v !== null;
}

function LongString({ value, max }: { value: string; max: number }) {
	const [full, setFull] = useState(false);
	const shown = full || value.length <= max ? value : `${value.slice(0, max)}…`;
	return (
		<span className="break-all whitespace-pre-wrap text-syn-string">
			{JSON.stringify(shown)}
			{value.length > max && (
				<button type="button" className="ml-1.5 bg-transparent p-0 font-sans text-2xs text-link hover:text-link-hover" onClick={() => setFull((f) => !f)}>
					{full ? "收起" : `展开（${value.length} 字符）`}
				</button>
			)}
		</span>
	);
}

function Primitive({ value, maxStringLength }: { value: unknown; maxStringLength: number }) {
	if (value === null) return <span className="text-syn-keyword">null</span>;
	switch (typeof value) {
		case "string":
			return <LongString value={value} max={maxStringLength} />;
		case "number":
		case "bigint":
			return <span className="text-syn-number">{String(value)}</span>;
		case "boolean":
			return <span className="text-syn-keyword">{String(value)}</span>;
		case "undefined":
			return <span className="text-fg-3">undefined</span>;
		default:
			return <span className="text-fg-code">{String(value)}</span>;
	}
}

function Node({
	name,
	value,
	depth,
	collapsedDepth,
	maxStringLength,
	last,
}: {
	name?: ReactNode;
	value: unknown;
	depth: number;
	collapsedDepth: number;
	maxStringLength: number;
	last: boolean;
}) {
	const [open, setOpen] = useState(depth < collapsedDepth);
	const comma = last ? "" : ",";
	const label =
		name !== undefined ? (
			<>
				<span className="text-syn-title">{name}</span>
				<span className="text-fg-3">: </span>
			</>
		) : null;

	if (!isContainer(value)) {
		return (
			<div className="pl-[18px]">
				{label}
				<Primitive value={value} maxStringLength={maxStringLength} />
				<span className="text-fg-3">{comma}</span>
			</div>
		);
	}

	const isArray = Array.isArray(value);
	const entries: [string, unknown][] = isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value);
	const [openCh, closeCh] = isArray ? ["[", "]"] : ["{", "}"];
	if (entries.length === 0) {
		return (
			<div className="pl-[18px]">
				{label}
				<span className="text-fg-3">
					{openCh}
					{closeCh}
					{comma}
				</span>
			</div>
		);
	}
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-0.5 border-0 bg-transparent p-0 text-left font-mono text-mono hover:bg-raised"
			>
				<span className="flex w-4 justify-center text-fg-3" aria-hidden="true">
					{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				</span>
				<span>
					{label}
					<span className="text-fg-3">{openCh}</span>
					{!open && (
						<span className="text-fg-3">
							{" "}
							{isArray ? `${entries.length} 项` : `${entries.length} 个字段`} {closeCh}
							{comma}
						</span>
					)}
				</span>
			</button>
			{open && (
				<>
					<div className="ml-[7px] border-l border-border pl-2">
						{entries.map(([k, v], i) => (
							<Node
								key={k}
								name={isArray ? undefined : JSON.stringify(k)}
								value={v}
								depth={depth + 1}
								collapsedDepth={collapsedDepth}
								maxStringLength={maxStringLength}
								last={i === entries.length - 1}
							/>
						))}
					</div>
					<div className="pl-[18px] text-fg-3">
						{closeCh}
						{comma}
					</div>
				</>
			)}
		</div>
	);
}

/** Collapsible JSON tree (keys blue, strings green, numbers orange, literals purple). */
export function JsonView({ value, collapsedDepth = 2, maxStringLength = 400, rootName, className }: JsonViewProps) {
	return (
		<div className={cn("overflow-x-auto bg-code px-3 py-2.5 font-mono text-mono text-fg-code", className)}>
			<Node name={rootName} value={value} depth={0} collapsedDepth={collapsedDepth} maxStringLength={maxStringLength} last />
		</div>
	);
}
