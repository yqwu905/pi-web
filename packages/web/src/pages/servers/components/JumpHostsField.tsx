import type { ServerView } from "@pi-web/shared";
import { Plus, X } from "lucide-react";
import { IconButton } from "../../../components/ui/IconButton";
import { Select } from "../../../components/ui/Select";
import { cn } from "../../../lib/cn";
import { jumpCandidates, serverTarget } from "../lib/connection-form";

export interface JumpHostsFieldProps {
	servers: readonly ServerView[];
	/** The server being edited (excluded from the candidates). */
	selfId?: string;
	value: readonly string[];
	onChange: (ids: string[]) => void;
	/** Wired to the first select by <Field>. */
	id?: string;
	"aria-describedby"?: string;
	"aria-invalid"?: boolean;
	disabled?: boolean;
	noneLabel?: string;
	className?: string;
	/** Width class of each select. */
	selectClassName?: string;
}

/** ProxyJump chain: one select per hop (first hop first), "添加下一跳" for multi-level chains. */
export function JumpHostsField({
	servers,
	selfId,
	value,
	onChange,
	id,
	disabled,
	noneLabel = "无",
	className,
	selectClassName,
	...aria
}: JumpHostsFieldProps) {
	const chain = value.length ? [...value] : [""];
	const label = (s: ServerView) => `${s.config.name} (${serverTarget(s.config)})`;
	const remaining = jumpCandidates(servers, selfId, value, -1);
	return (
		<div className={cn("flex flex-col gap-2", className)}>
			{chain.map((hop, i) => {
				const candidates = jumpCandidates(servers, selfId, value, i);
				const known = !hop || candidates.some((s) => s.config.id === hop);
				return (
					<div key={i} className="flex items-center gap-2">
						{chain.length > 1 && <span className="w-5 shrink-0 text-right font-mono text-2xs text-fg-3">{i + 1}</span>}
						<Select
							id={i === 0 ? id : undefined}
							aria-label={i === 0 ? undefined : `第 ${i + 1} 跳`}
							aria-describedby={i === 0 ? aria["aria-describedby"] : undefined}
							aria-invalid={i === 0 ? aria["aria-invalid"] : undefined}
							mono
							disabled={disabled}
							value={hop}
							wrapperClassName={selectClassName}
							onChange={(e) => {
								const next = [...value];
								if (!e.target.value) next.splice(i, 1);
								else if (i < next.length) next[i] = e.target.value;
								else next.push(e.target.value);
								onChange(next.filter(Boolean));
							}}
						>
							{i === 0 && <option value="">{noneLabel}</option>}
							{!known && <option value={hop}>{hop}（不存在）</option>}
							{candidates.map((s) => (
								<option key={s.config.id} value={s.config.id}>
									{label(s)}
								</option>
							))}
						</Select>
						{i > 0 && (
							<IconButton aria-label={`移除第 ${i + 1} 跳`} size="md" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))}>
								<X size={14} strokeWidth={2} />
							</IconButton>
						)}
					</div>
				);
			})}
			{value.length > 0 && remaining.length > 0 && (
				<button
					type="button"
					disabled={disabled}
					onClick={() => onChange([...value, remaining[0].config.id])}
					className="inline-flex w-fit items-center gap-1 border-0 bg-transparent p-0 text-xs text-link hover:text-link-hover disabled:opacity-50"
				>
					<Plus size={12} strokeWidth={2.2} aria-hidden="true" />
					添加下一跳
				</button>
			)}
		</div>
	);
}
