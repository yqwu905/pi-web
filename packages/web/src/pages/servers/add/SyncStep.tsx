import type { ServerView, SyncItemKey } from "@pi-web/shared";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { previewSync } from "../../../api/client";
import { useMeta } from "../../../api/hooks";
import { Button } from "../../../components/ui/Button";
import { Switch } from "../../../components/ui/Choice";
import { Callout } from "../../../components/ui/Display";
import { tildify } from "../../../lib/format";
import { selectedSummary, SyncItemsChecklist } from "../components/SyncItemsChecklist";
import { agentAvailable, serverQueryKeys, useSyncInventory } from "../hooks";

export interface SyncStepProps {
	view: ServerView;
	saving: boolean;
	error: string | null;
	onBack: () => void;
	onFinish: (items: Record<SyncItemKey, boolean>, auto: boolean) => void;
}

export function SyncStep({ view, saving, error, onBack, onFinish }: SyncStepProps) {
	const c = view.config;
	const [items, setItems] = useState<Record<SyncItemKey, boolean>>(() => ({ ...c.sync.items }));
	const [auto, setAuto] = useState(c.sync.auto);
	const inventory = useSyncInventory();
	const meta = useMeta();
	const autoLabelId = useId();
	// Warnings of the current plan (e.g. stdio MCP servers that need npx), from the saved selection.
	const preview = useQuery({
		queryKey: serverQueryKeys.syncPreview(c.id),
		queryFn: () => previewSync(c.id),
		enabled: agentAvailable(view),
		staleTime: 30_000,
		retry: false,
	});
	const hostDir = inventory.data?.agentDir ?? meta.data?.hostAgentDir ?? "~/.pi/agent";
	const remoteDir = c.deployed ? tildify(c.deployed.agentDir, c.deployed.home) : c.agentDirMode === "shared" ? "~/.pi/agent" : `${c.remoteRoot}/agent`;
	const warnings = preview.data?.warnings ?? [];
	return (
		<section aria-labelledby="as-sync-t" className="flex flex-col rounded-xl border border-border bg-panel">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3.5">
				<h2 id="as-sync-t" className="m-0 text-base font-semibold">
					首次同步
				</h2>
				<span className="flex flex-1 flex-wrap items-center gap-1.5 text-xs text-fg-2">
					Host <code className="text-xs text-fg-code">{hostDir}</code> → 服务器 <code className="text-xs text-fg-code">{remoteDir}</code> · 单向
				</span>
				<span className="text-xs text-fg-2">{selectedSummary(items, inventory.data)}</span>
			</div>
			<div className="flex flex-col gap-3 p-4">
				<SyncItemsChecklist aria-label="同步项目" value={items} onChange={setItems} inventory={inventory.data} />
				{warnings.length > 0 && (
					<Callout tone="warning" title="同步提示">
						<ul className="m-0 flex list-disc flex-col gap-0.5 pl-4">
							{warnings.map((w) => (
								<li key={w}>{w}</li>
							))}
						</ul>
					</Callout>
				)}
				<span className="text-xs leading-[18px] text-fg-3">永不同步：sessions/、trust.json、*.log、bin/、tools/。服务器上本地新增的文件不会被删除。</span>
			</div>
			<div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
				<div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
					<span id={autoLabelId} className="text-sm text-fg">
						自动同步（监听 Host {hostDir}）
					</span>
					<span className="text-xs text-fg-3">变更 2 秒后增量推送；服务器离线时标记为待同步，重连后补上</span>
				</div>
				<Switch checked={auto} onChange={setAuto} aria-labelledby={autoLabelId} label={auto ? "已开启" : "已关闭"} />
			</div>
			{error && (
				<div className="px-4 pb-3">
					<Callout tone="danger" title="保存失败">
						{error}
					</Callout>
				</div>
			)}
			<div className="flex justify-end gap-2 border-t border-border px-4 py-3">
				<Button onClick={onBack}>上一步</Button>
				<Button variant="primary" loading={saving} onClick={() => onFinish(items, auto)}>
					完成并打开服务器
				</Button>
			</div>
		</section>
	);
}
