import { Plus, X } from "lucide-react";
import { type ClipboardEvent, type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { type EnvRow, envValueErrorKey, newEnvRow } from "../lib/env-rows";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Input, Textarea } from "./ui/Input";

export interface EnvEditorProps {
	rows: EnvRow[];
	/** From rowsToEnv: row id → name problem, envValueErrorKey(row id) → value problem. */
	errors: Record<string, string>;
	onChange: (rows: EnvRow[]) => void;
	disabled?: boolean;
	/** Heading above the rows (dialog layout); omit when an outer label names the editor (`labelledBy`). */
	label?: ReactNode;
	/** Short note next to the heading. */
	hint?: ReactNode;
	/** Id of the element labelling the group when `label` is omitted. */
	labelledBy?: string;
}

/** Where focus goes after the next render: a row's field (with the caret), or the 添加变量 button. */
type FocusTarget = { rowId: string; field: "name" | "value"; caret?: number } | "add";

/** Most lines a multi-line value field shows before it scrolls. */
const MAX_VALUE_ROWS = 8;

/**
 * NAME = value rows with add/remove (workspace env in the workspace dialogs, server-level env in 服务器设置).
 * A value containing line breaks is edited in a textarea (a single-line input would drop them).
 */
export function EnvEditor({ rows, errors, onChange, disabled, label, hint, labelledBy }: EnvEditorProps) {
	const labelId = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const addRef = useRef<HTMLButtonElement>(null);
	const pendingFocus = useRef<FocusTarget | null>(null);

	// Rows mount and unmount (and a value field switches between input and textarea): keep the
	// keyboard focus on a sensible element instead of letting it fall back to <body>.
	useLayoutEffect(() => {
		const target = pendingFocus.current;
		if (!target) return;
		pendingFocus.current = null;
		if (target === "add") {
			addRef.current?.focus();
			return;
		}
		const el = rootRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
			`[data-env-row="${CSS.escape(target.rowId)}"][data-env-field="${target.field}"]`,
		);
		if (!el) return;
		el.focus();
		if (target.caret !== undefined) el.setSelectionRange(target.caret, target.caret);
	});

	const update = (id: string, patch: Partial<EnvRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	const changeValue = (row: EnvRow, value: string, caret: number | null) => {
		if (value.includes("\n") !== row.value.includes("\n")) pendingFocus.current = { rowId: row.id, field: "value", caret: caret ?? value.length };
		update(row.id, { value });
	};
	const pasteValue = (row: EnvRow, e: ClipboardEvent<HTMLInputElement>) => {
		const text = e.clipboardData.getData("text/plain");
		if (!/[\r\n]/.test(text)) return;
		// The input would drop the line breaks: insert the text as is (a single line copied with its
		// trailing newline stays one line).
		e.preventDefault();
		let pasted = text.replace(/\r\n?/g, "\n");
		if (!pasted.replace(/\n+$/, "").includes("\n")) pasted = pasted.replace(/\n+$/, "");
		const start = e.currentTarget.selectionStart ?? row.value.length;
		const end = e.currentTarget.selectionEnd ?? start;
		// The field is re-rendered with the new value (maybe as a textarea): put the caret after the text.
		pendingFocus.current = { rowId: row.id, field: "value", caret: start + pasted.length };
		update(row.id, { value: row.value.slice(0, start) + pasted + row.value.slice(end) });
	};
	const add = () => {
		const row = newEnvRow();
		pendingFocus.current = { rowId: row.id, field: "name" };
		onChange([...rows, row]);
	};
	const remove = (index: number) => {
		const neighbour = rows[index + 1] ?? rows[index - 1];
		pendingFocus.current = neighbour ? { rowId: neighbour.id, field: "name" } : "add";
		onChange(rows.filter((_, i) => i !== index));
	};

	return (
		<div ref={rootRef} role="group" aria-labelledby={label !== undefined ? labelId : labelledBy} className="flex flex-col gap-1.5">
			{label !== undefined && (
				<div className="flex items-baseline justify-between gap-3">
					<span id={labelId} className="text-xs font-medium text-fg-2">
						{label}
					</span>
					{hint && <span className="text-xs text-fg-3">{hint}</span>}
				</div>
			)}
			{rows.length > 0 && (
				<div className="flex flex-col gap-1.5">
					{rows.map((row, i) => {
						const nameError = errors[row.id];
						const valueError = errors[envValueErrorKey(row.id)];
						const errorId = `${labelId}-${row.id}-error`;
						const valueProps = {
							"aria-label": `第 ${i + 1} 个变量值`,
							"aria-describedby": valueError ? errorId : undefined,
							"data-env-row": row.id,
							"data-env-field": "value",
							placeholder: "value",
							value: row.value,
							invalid: Boolean(valueError),
							disabled,
							spellCheck: false,
							autoComplete: "off",
						};
						return (
							<div key={row.id} className="flex flex-col gap-1">
								<div className="flex items-center gap-1.5">
									<div className="w-[40%] shrink-0">
										<Input
											mono
											size="sm"
											aria-label={`第 ${i + 1} 个变量名`}
											aria-describedby={nameError ? errorId : undefined}
											data-env-row={row.id}
											data-env-field="name"
											placeholder="NAME"
											value={row.name}
											invalid={Boolean(nameError)}
											disabled={disabled}
											spellCheck={false}
											autoComplete="off"
											onChange={(e) => update(row.id, { name: e.target.value })}
										/>
									</div>
									<span aria-hidden="true" className="font-mono text-xs text-fg-3">
										=
									</span>
									<div className="min-w-0 flex-1">
										{row.value.includes("\n") ? (
											<Textarea
												mono
												{...valueProps}
												rows={Math.min(row.value.split("\n").length, MAX_VALUE_ROWS)}
												onChange={(e) => changeValue(row, e.target.value, e.target.selectionStart)}
											/>
										) : (
											<Input
												mono
												size="sm"
												{...valueProps}
												onChange={(e) => changeValue(row, e.target.value, e.target.selectionStart)}
												onPaste={(e) => pasteValue(row, e)}
											/>
										)}
									</div>
									<IconButton aria-label={`删除变量 ${row.name || i + 1}`} size="md" variant="subtle" disabled={disabled} onClick={() => remove(i)}>
										<X size={13} strokeWidth={2} />
									</IconButton>
								</div>
								{(nameError || valueError) && (
									<span id={errorId} className="text-xs text-danger">
										{nameError ?? valueError}
									</span>
								)}
							</div>
						);
					})}
				</div>
			)}
			<div>
				<Button ref={addRef} size="sm" variant="ghost" icon={<Plus size={12} strokeWidth={2} />} disabled={disabled} onClick={add} className="-ml-2">
					添加变量
				</Button>
			</div>
		</div>
	);
}
