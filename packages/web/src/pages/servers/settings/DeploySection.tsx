import { Lock, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";
import { useMeta, useSettings } from "../../../api/hooks";
import { Radio, RadioGroup } from "../../../components/ui/Choice";
import { paths } from "../../../lib/routes";
import { Hint, SettingRow, SettingsSection } from "../components/SettingsLayout";
import type { SectionProps } from "./types";

export function DeploySection({ view, form, base, set, dirty }: SectionProps) {
	const meta = useMeta();
	const settings = useSettings();
	const ids = { dir: useId(), root: useId() };
	const c = view.config;
	const d = c.deployed;
	const hostPi = meta.data?.hostPiVersion;
	const pinned = settings.data?.piVersionPolicy === "pinned";
	const target = pinned ? settings.data?.piPinnedVersion : hostPi;
	const inSync = Boolean(d && target && d.piVersion === target);
	return (
		<SettingsSection id="sec-deploy" title="部署与目录" description="远端运行时位置，以及 pi 读取配置的 agent 目录（PI_CODING_AGENT_DIR）。">
			<SettingRow first label="Agent 目录" labelId={ids.dir} dirty={dirty.has("agentDirMode")} align="text">
				<RadioGroup value={form.agentDirMode} onChange={(v) => set({ agentDirMode: v as typeof form.agentDirMode })} spacing="loose" name={ids.dir}>
					<Radio
						value="isolated"
						label={
							<>
								独立 <code className="text-xs text-fg-code">{c.remoteRoot}/agent</code>
								<span className="rounded-sm bg-success-soft px-1.5 text-2xs leading-4 text-success-fg">推荐</span>
							</>
						}
						description="与服务器上已有的 pi 配置互不影响"
					/>
					<Radio
						value="shared"
						label={
							<>
								共用 <code className="text-xs text-fg-code">~/.pi/agent</code>
							</>
						}
						description="与服务器上直接运行的 pi CLI 共用配置和会话"
					/>
				</RadioGroup>
				{form.agentDirMode === "shared" && base.agentDirMode !== "shared" && (
					<div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-2.5">
						<TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
						<span className="text-xs leading-[18px] text-warning-fg">
							<strong className="font-semibold">注意：</strong>切换后同步将写入 ~/.pi/agent，会覆盖服务器上已有的同名配置；已有会话不会迁移。
						</span>
					</div>
				)}
				{form.agentDirMode === "isolated" && base.agentDirMode === "shared" && (
					<Hint tone="warning">切换回独立目录后，~/.pi/agent 中已同步的文件保留不动；已有会话不会迁移。</Hint>
				)}
			</SettingRow>
			<SettingRow label="远端安装根目录" htmlFor={ids.root}>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<input
						id={ids.root}
						readOnly
						value={c.remoteRoot}
						className="h-8 w-[200px] max-w-full cursor-default rounded-md border border-border bg-raised px-2.5 font-mono text-mono text-fg-2 outline-none"
					/>
					<span className="inline-flex items-center gap-1.5 text-xs leading-[18px] text-fg-3">
						<Lock size={12} aria-hidden="true" />
						只读：部署时确定，更换需卸载后重新部署
					</span>
				</div>
			</SettingRow>
			<SettingRow label="pi 版本" align="text">
				<span className="text-sm leading-5 text-fg">
					{pinned ? "指定版本" : "跟随 Host"}
					{target ? (
						<>
							（<code className="text-xs text-fg-code">{target}</code>）
						</>
					) : !pinned ? (
						<span className="text-fg-3">（未检测到 Host 上的 pi）</span>
					) : null}
				</span>
				<Hint>
					{d ? `服务器当前 pi ${d.piVersion} · Node ${d.nodeVersion} · pi-web-agent ${d.agentVersion}` : "尚未部署"}
					{d && target ? (inSync ? "，与目标版本一致。" : "，与目标版本不一致，可在“危险操作”中重新部署。") : "。"}
					<Link to={`${paths.settings()}#set-pi`}>在全局设置中指定版本</Link>
				</Hint>
			</SettingRow>
		</SettingsSection>
	);
}
