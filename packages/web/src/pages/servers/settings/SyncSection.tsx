import { SYNC_ITEMS } from "@pi-web/shared";
import { Wand2 } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";
import { useSyncStatus } from "../../../api/hooks";
import { Button } from "../../../components/ui/Button";
import { Switch } from "../../../components/ui/Choice";
import { Textarea } from "../../../components/ui/Input";
import { paths } from "../../../lib/routes";
import { DirtyTag, Hint, SettingRow, SettingsSection } from "../components/SettingsLayout";
import { SyncItemsChecklist } from "../components/SyncItemsChecklist";
import { useSyncInventory } from "../hooks";
import { formatOverride, parseSettingsOverride } from "../lib/json-override";
import type { SectionProps } from "./types";

export function SyncSection({ form, set, dirty }: SectionProps) {
	const ids = { auto: useId(), items: useId(), override: useId() };
	const inventory = useSyncInventory();
	const status = useSyncStatus();
	const hostDir = status.data?.hostAgentDir ?? inventory.data?.agentDir ?? "~/.pi/agent";
	const selected = SYNC_ITEMS.filter((i) => form.syncItems[i.key]).length;
	const parsed = parseSettingsOverride(form.overrideText);
	// The JSON editor validates live; other fields only after a save attempt.
	const overrideError = parsed.ok ? undefined : parsed.error;
	return (
		<SettingsSection
			id="sec-sync"
			title="配置同步"
			description={
				<>
					Host <code className="text-[11.5px] text-fg-code">{hostDir}</code> → 服务器 agent 目录，单向增量；只删除由同步写入、且已在 Host 上删除的文件。
				</>
			}
			actions={
				<Link to={paths.sync()} className="text-xs">
					在同步中心查看差异
				</Link>
			}
		>
			<SettingRow first label="自动同步" labelId={ids.auto} dirty={dirty.has("syncAuto")} align="text">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<Switch checked={form.syncAuto} onChange={(syncAuto) => set({ syncAuto })} aria-labelledby={ids.auto} label={form.syncAuto ? "已开启" : "已关闭"} />
					<Hint className="min-w-0 flex-[1_1_260px]">Host 配置变更 2 秒后增量推送；离线时标记为待同步，重连后补上。</Hint>
				</div>
			</SettingRow>
			<div className="flex flex-col gap-2.5 border-t border-border px-4 py-3.5">
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
					<span id={ids.items} className="text-sm leading-5 font-medium text-fg">
						同步项目
					</span>
					<DirtyTag show={dirty.has("syncItems")} />
					<span className="text-xs text-fg-3">
						已选 {selected} / {SYNC_ITEMS.length}
					</span>
				</div>
				<SyncItemsChecklist variant="rows" aria-labelledby={ids.items} value={form.syncItems} onChange={(syncItems) => set({ syncItems })} inventory={inventory.data} />
				<Hint>
					永不同步：<code className="text-[11.5px] text-fg-2">sessions/</code>、<code className="text-[11.5px] text-fg-2">trust.json</code>、
					<code className="text-[11.5px] text-fg-2">*.log</code>、<code className="text-[11.5px] text-fg-2">bin/</code>、
					<code className="text-[11.5px] text-fg-2">tools/</code>。取消勾选不会删除服务器上已同步的文件；服务器上本地新增的文件不会被删除。
				</Hint>
			</div>
			<SettingRow label="服务器级 settings 覆盖" htmlFor={ids.override} dirty={dirty.has("overrideText")}>
				<Textarea
					id={ids.override}
					mono
					rows={8}
					spellCheck={false}
					value={form.overrideText}
					invalid={Boolean(overrideError)}
					aria-describedby={`${ids.override}-hint`}
										onChange={(e) => set({ overrideText: e.target.value })}
				/>
				<div id={`${ids.override}-hint`} className="flex flex-wrap items-start gap-x-3 gap-y-1">
					<div className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
						{overrideError ? (
							<Hint tone="danger">{overrideError}</Hint>
						) : (
							<Hint>深度合并到同步后的 settings.json（对象递归合并，数组整体替换）。</Hint>
						)}
						{parsed.ok &&
							parsed.warnings.map((w) => (
								<Hint key={w} tone="warning">
									{w}
								</Hint>
							))}
					</div>
					<Button
						size="sm"
						variant="ghost"
						icon={<Wand2 size={12} strokeWidth={2} />}
						disabled={!parsed.ok}
						onClick={() => parsed.ok && set({ overrideText: formatOverride(parsed.value) })}
					>
						格式化
					</Button>
				</div>
			</SettingRow>
		</SettingsSection>
	);
}
