import { createContext, type InputHTMLAttributes, type ReactNode, type Ref, useContext, useId } from "react";
import { cn } from "../../lib/cn";

// ---------- Checkbox ----------

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
	label?: ReactNode;
	description?: ReactNode;
	checked?: boolean;
	onChange?: (checked: boolean) => void;
	/** Bordered card look used by the sync item grid. */
	card?: boolean;
	ref?: Ref<HTMLInputElement>;
}

/** Native checkbox (accent-color primary) with optional label and description. */
export function Checkbox({ label, description, card, className, onChange, disabled, ref, ...rest }: CheckboxProps) {
	const input = (
		<input
			ref={ref}
			type="checkbox"
			disabled={disabled}
			onChange={(e) => onChange?.(e.target.checked)}
			className={cn("m-0 size-3.5 shrink-0 accent-primary", (label || description) && "mt-[3px]", !label && !description && className)}
			{...rest}
		/>
	);
	if (!label && !description) return input;
	return (
		<label
			className={cn(
				"flex items-start gap-2 text-sm text-fg",
				disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
				card && "gap-2.5 rounded-lg border border-border px-3 py-2.5 hover:border-border-strong",
				className,
			)}
		>
			{input}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				{label && <span className="leading-5">{label}</span>}
				{description && <span className="text-xs leading-[18px] text-fg-3">{description}</span>}
			</span>
		</label>
	);
}

// ---------- Radio ----------

interface RadioGroupContext {
	name: string;
	value: string | undefined;
	onChange: (value: string) => void;
	disabled?: boolean;
}

const RadioCtx = createContext<RadioGroupContext | null>(null);

export interface RadioGroupProps {
	label?: ReactNode;
	description?: ReactNode;
	value: string | undefined;
	onChange: (value: string) => void;
	name?: string;
	disabled?: boolean;
	children: ReactNode;
	className?: string;
	/** Lay radios out horizontally. */
	inline?: boolean;
	/** Vertical spacing between options: tight 4px (dialogs), loose 10px (settings with descriptions). */
	spacing?: "tight" | "loose";
}

/** role="radiogroup" with a label (12px) and hint (indented under the options, as in the artboards). */
export function RadioGroup({ label, description, value, onChange, name, disabled, children, className, inline, spacing = "tight" }: RadioGroupProps) {
	const id = useId();
	const groupName = name ?? `radio-${id}`;
	return (
		<div
			role="radiogroup"
			aria-labelledby={label ? `${id}-label` : undefined}
			aria-describedby={description ? `${id}-desc` : undefined}
			className={cn("flex flex-col gap-1.5", className)}
		>
			{label && (
				<span id={`${id}-label`} className="text-xs font-medium text-fg-2">
					{label}
				</span>
			)}
			<RadioCtx.Provider value={{ name: groupName, value, onChange, disabled }}>
				<div className={cn("flex", inline ? "flex-row flex-wrap gap-x-6 gap-y-2" : cn("flex-col", spacing === "loose" ? "gap-2.5" : "gap-1"))}>
					{children}
				</div>
			</RadioCtx.Provider>
			{description && (
				<span id={`${id}-desc`} className="pl-[22px] text-xs text-fg-3">
					{description}
				</span>
			)}
		</div>
	);
}

export interface RadioProps {
	value: string;
	label: ReactNode;
	description?: ReactNode;
	disabled?: boolean;
	className?: string;
}

export function Radio({ value, label, description, disabled, className }: RadioProps) {
	const ctx = useContext(RadioCtx);
	if (!ctx) throw new Error("<Radio> must be used inside <RadioGroup>");
	const isDisabled = disabled || ctx.disabled;
	return (
		<label className={cn("flex items-start gap-2 text-sm leading-5 text-fg", isDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer", className)}>
			<input
				type="radio"
				name={ctx.name}
				value={value}
				checked={ctx.value === value}
				disabled={isDisabled}
				onChange={() => ctx.onChange(value)}
				className="m-0 mt-[3px] size-3.5 shrink-0 accent-primary"
			/>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="flex flex-wrap items-center gap-1.5">{label}</span>
				{description && <span className="text-xs leading-[18px] text-fg-3">{description}</span>}
			</span>
		</label>
	);
}

// ---------- Switch ----------

export interface SwitchProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	/** Visible text next to the track (e.g. "已开启"). */
	label?: ReactNode;
	/** Accessible name when there is no visible label. */
	"aria-label"?: string;
	"aria-labelledby"?: string;
	disabled?: boolean;
	className?: string;
	id?: string;
}

/** Toggle switch (button role="switch"): 32×18 track, primary when on. */
export function Switch({ checked, onChange, label, disabled, className, id, ...aria }: SwitchProps) {
	return (
		<button
			id={id}
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={aria["aria-label"]}
			aria-labelledby={aria["aria-labelledby"]}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"inline-flex h-7 shrink-0 items-center gap-2 rounded-md bg-transparent px-1 text-xs text-fg-2 disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"flex h-[18px] w-8 rounded-full p-0.5 transition-colors",
					checked ? "justify-end bg-primary" : "justify-start bg-border",
				)}
			>
				<span className={cn("block size-3.5 rounded-full", checked ? "bg-white" : "bg-fg-2")} />
			</span>
			{label}
		</button>
	);
}

// ---------- Segmented ----------

export interface SegmentedOption<T extends string> {
	value: T;
	label: ReactNode;
	icon?: ReactNode;
	disabled?: boolean;
	title?: string;
}

export interface SegmentedProps<T extends string> {
	options: readonly SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	"aria-label"?: string;
	"aria-labelledby"?: string;
	/** sm: 24px segments (预览/源码); md: 28px (认证方式). */
	size?: "sm" | "md";
	/** "panel" (#13161C) or "sunken" (#0E1014) background. */
	tone?: "panel" | "sunken";
	className?: string;
}

/** Segmented control: group of aria-pressed buttons, selected segment uses the selection color. */
export function Segmented<T extends string>({ options, value, onChange, size = "sm", tone = "panel", className, ...aria }: SegmentedProps<T>) {
	return (
		<div
			role="group"
			aria-label={aria["aria-label"]}
			aria-labelledby={aria["aria-labelledby"]}
			className={cn("inline-flex w-fit gap-0.5 rounded-md border border-border p-0.5", tone === "panel" ? "bg-panel" : "bg-bg", className)}
		>
			{options.map((o) => {
				const on = o.value === value;
				return (
					<button
						key={o.value}
						type="button"
						aria-pressed={on}
						disabled={o.disabled}
						title={o.title}
						onClick={() => onChange(o.value)}
						className={cn(
							"inline-flex items-center justify-center gap-1.5 rounded-sm border-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
							size === "sm" ? "h-6 px-2.5 text-xs" : "h-7 px-3.5 text-sm",
							on ? "bg-selected font-semibold text-fg" : "bg-transparent font-medium text-fg-2 hover:text-fg",
						)}
					>
						{o.icon}
						{o.label}
					</button>
				);
			})}
		</div>
	);
}
