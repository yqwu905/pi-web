import { type HostInventory, SYNC_ITEMS, type SyncItemDefinition, type SyncItemKey } from "@pi-web/shared";
import { cn } from "../../../lib/cn";
import { formatBytes } from "../../../lib/format";

/** Descriptions closer to the artboards than the shared one-liners. */
const ROW_DESCRIPTIONS: Partial<Record<SyncItemKey, string>> = {
	settings: "剔除 npmCommand/shellPath/httpProxy，注入代理设置，合并服务器级覆盖",
	models: "模型列表与自定义 provider",
	auth: "OAuth 仅推送 access token，refresh token 留在 Host",
	mcp: "MCP 服务器配置；stdio 命令需在服务器上可用",
	instructions: "全局指令与系统提示",
	extensions: "扩展；settings 引用的外部路径一并上传",
	skills: "技能（SKILL.md 及其资源）",
	prompts: "提示模板",
	themes: "TUI 主题",
	npm: "pi 管理的 npm 包",
	git: "git 包，含 node_modules",
	agentsSkills: "跨工具共享的技能目录",
	keybindings: "TUI 快捷键，仅在终端里直接运行 pi 时用到",
};

const ROW_NAMES: Partial<Record<SyncItemKey, string>> = {
	instructions: "AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md",
};

export function syncItemName(item: SyncItemDefinition): string {
	return ROW_NAMES[item.key] ?? item.label;
}

/** "3 条凭据", "7 个", "1.2 KB" from the host inventory; undefined when unknown. */
export function inventoryCount(inventory: HostInventory | undefined, key: SyncItemKey): { text: string; missing: boolean } | undefined {
	const item = inventory?.items.find((i) => i.key === key);
	if (!item) return undefined;
	if (!item.present) return { text: "Host 上不存在", missing: true };
	if (item.detail) return { text: item.detail, missing: false };
	if (item.fileCount > 1) return { text: `${item.fileCount} 个文件`, missing: false };
	return { text: formatBytes(item.bytes), missing: false };
}

export function selectedSummary(value: Record<SyncItemKey, boolean>, inventory: HostInventory | undefined): string {
	const keys = SYNC_ITEMS.filter((i) => value[i.key]).map((i) => i.key);
	const bytes = inventory?.items.filter((i) => keys.includes(i.key) && i.present).reduce((n, i) => n + i.bytes, 0);
	return `已选 ${keys.length} 项${bytes ? ` · 约 ${formatBytes(bytes)}` : ""}`;
}

export interface SyncItemsChecklistProps {
	value: Record<SyncItemKey, boolean>;
	onChange: (next: Record<SyncItemKey, boolean>) => void;
	inventory?: HostInventory;
	/** "cards": wizard grid; "rows": compact settings list. */
	variant?: "cards" | "rows";
	disabled?: boolean;
	"aria-labelledby"?: string;
	"aria-label"?: string;
}

export function SyncItemsChecklist({ value, onChange, inventory, variant = "cards", disabled, ...aria }: SyncItemsChecklistProps) {
	const toggle = (key: SyncItemKey, on: boolean) => onChange({ ...value, [key]: on });

	if (variant === "rows") {
		return (
			<div role="group" {...aria} className="overflow-hidden rounded-md border border-border bg-bg">
				{SYNC_ITEMS.map((item, i) => {
					const on = Boolean(value[item.key]);
					const count = inventoryCount(inventory, item.key);
					return (
						<label
							key={item.key}
							className={cn(
								"flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-[7px]",
								disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-panel",
								i > 0 && "border-t border-border",
							)}
						>
							<input
								type="checkbox"
								checked={on}
								disabled={disabled}
								onChange={(e) => toggle(item.key, e.target.checked)}
								className="m-0 size-3.5 shrink-0 accent-primary"
							/>
							<code className={cn("min-w-0 flex-[0_1_290px] text-xs leading-[18px]", on ? "text-fg" : "text-fg-2")}>{syncItemName(item)}</code>
							<span className="min-w-0 flex-[1_1_220px] text-xs leading-[18px] text-fg-3">{ROW_DESCRIPTIONS[item.key] ?? item.description}</span>
							{count && <span className={cn("shrink-0 text-xs", count.missing ? "text-fg-4" : "text-fg-3")}>{count.text}</span>}
						</label>
					);
				})}
			</div>
		);
	}

	return (
		<div role="group" {...aria} className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-2">
			{SYNC_ITEMS.map((item) => {
				const on = Boolean(value[item.key]);
				const count = inventoryCount(inventory, item.key);
				const optional = !item.defaultEnabled;
				return (
					<label
						key={item.key}
						className={cn(
							"flex items-start gap-2.5 rounded-lg border px-3 py-2.5",
							optional ? "border-dashed border-border-strong" : "border-border",
							disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-border-strong",
						)}
					>
						<input
							type="checkbox"
							checked={on}
							disabled={disabled}
							onChange={(e) => toggle(item.key, e.target.checked)}
							className="m-0 mt-0.5 size-3.5 shrink-0 accent-primary"
						/>
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="text-sm leading-[18px] text-fg">
								<code className="text-mono">{item.label}</code>
							</span>
							<span className="text-xs leading-[18px] text-fg-3">{optional ? `${item.description}（可选，默认不同步）` : item.description}</span>
						</span>
						{count && (
							<span className={cn("max-w-[45%] shrink-0 truncate text-right text-xs leading-[18px]", count.missing ? "text-fg-4" : "text-fg-2")} title={count.text}>
								{count.text}
							</span>
						)}
					</label>
				);
			})}
		</div>
	);
}
