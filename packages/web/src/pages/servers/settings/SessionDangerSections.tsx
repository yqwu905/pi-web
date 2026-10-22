import { Rocket, Trash2, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Choice";
import { Select } from "../../../components/ui/Select";
import { paths } from "../../../lib/routes";
import { DeleteServerModal, DeployDialog, UninstallModal } from "../components/ServerDialogs";
import { Hint, SettingRow, SettingsSection } from "../components/SettingsLayout";
import { useDeployJob } from "../hooks";
import { idleTimeoutOptions } from "../lib/server-settings-form";
import type { SectionProps } from "./types";

export function SessionSection({ form, set, dirty }: SectionProps) {
	const ids = { idle: useId(), trust: useId() };
	return (
		<SettingsSection id="sec-session" title="会话" description="该服务器上 pi 进程的回收策略，以及新建工作区的默认值。">
			<SettingRow first label="空闲回收" htmlFor={ids.idle} dirty={dirty.has("idleTimeoutMin")}>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<Select
						id={ids.idle}
						wrapperClassName="max-w-[140px]"
						value={String(form.idleTimeoutMin)}
						onChange={(e) => set({ idleTimeoutMin: Number(e.target.value) })}
						options={idleTimeoutOptions(form.idleTimeoutMin).map((o) => ({ value: String(o.value), label: o.label }))}
					/>
					<Hint className="min-w-0 flex-[1_1_260px]">对话不在运行且空闲超过该时长后，关闭 stdin 让 pi 正常退出；再次发送消息时自动恢复。</Hint>
				</div>
			</SettingRow>
			<SettingRow label="默认 project trust" htmlFor={ids.trust} dirty={dirty.has("defaultTrust")}>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<Select
						id={ids.trust}
						wrapperClassName="max-w-[240px]"
						value={form.defaultTrust}
						onChange={(e) => set({ defaultTrust: e.target.value as typeof form.defaultTrust })}
						options={[
							{ value: "approve", label: "approve · 加载项目 .pi 资源" },
							{ value: "no-approve", label: "no-approve · 忽略项目资源" },
						]}
					/>
					<Hint className="min-w-0 flex-[1_1_260px]">应用于新建的工作区（RPC 模式无法弹出信任确认）；已有工作区不受影响。</Hint>
				</div>
			</SettingRow>
		</SettingsSection>
	);
}

export function DangerSection({ view }: Pick<SectionProps, "view">) {
	const c = view.config;
	const navigate = useNavigate();
	const job = useDeployJob(c.id).data;
	const [keepSessions, setKeepSessions] = useState(true);
	const [dialog, setDialog] = useState<"redeploy" | "uninstall" | "delete" | null>(null);
	const running = view.status.conversationsRunning;
	const waiting = view.status.conversationsWaiting;
	const active = running + waiting;
	const d = c.deployed;
	return (
		<SettingsSection
			id="sec-danger"
			danger
			title="危险操作"
			description={active > 0 ? `以下操作会中断 ${c.name} 上的 ${active} 个活动对话（运行中 ${running}、等待确认 ${waiting}）。` : `${c.name} 上当前没有活动对话。`}
		>
			{!c.jumpOnly && (
				<>
					<div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5">
						<div className="flex min-w-0 flex-[999_1_320px] flex-col gap-1">
							<span className="text-sm leading-5 font-medium text-fg">重新部署</span>
							<Hint>
								{d
									? `重新上传 Node ${d.nodeVersion}、pi ${d.piVersion} 与 pi-web-agent（命中 Host 缓存），重启 daemon 并执行一次完整同步。`
									: "上传 Node 运行时、pi 与 pi-web-agent，启动 daemon 并执行一次完整同步。"}
							</Hint>
						</div>
						<Button icon={<Rocket size={14} strokeWidth={1.8} />} disabled={job?.state === "running"} onClick={() => setDialog("redeploy")}>
							{job?.state === "running" ? "部署中…" : "重新部署"}
						</Button>
					</div>
					<div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border px-4 py-3.5">
						<div className="flex min-w-0 flex-[999_1_320px] flex-col gap-1.5">
							<span className="text-sm leading-5 font-medium text-fg">卸载 Pi-Web</span>
							<Hint>
								{keepSessions
									? `停止 daemon 并删除服务器上的 ${c.remoteRoot}；会话文件先移动到 ~/pi-web-backups（仅本人可读）。`
									: `停止 daemon 并删除服务器上的 ${c.remoteRoot}，会话文件一并删除，无法恢复。`}
							</Hint>
							<Checkbox className="text-xs text-fg-2" checked={keepSessions} onChange={setKeepSessions} label={<span className="text-xs text-fg-2">保留会话文件（移动到 ~/pi-web-backups）</span>} />
						</div>
						<Button variant="warning" icon={<TriangleAlert size={14} strokeWidth={2} />} disabled={!d && view.status.deployState !== "deployed"} onClick={() => setDialog("uninstall")}>
							卸载 Pi-Web
						</Button>
					</div>
				</>
			)}
			<div className={c.jumpOnly ? "flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5" : "flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border px-4 py-3.5"}>
				<div className="flex min-w-0 flex-[999_1_320px] flex-col gap-1">
					<span className="text-sm leading-5 font-medium text-fg">删除服务器</span>
					<Hint>从 Pi-Web 中移除该服务器、其工作区与保存的凭据；服务器上的文件不受影响。</Hint>
				</div>
				<Button variant="danger" icon={<Trash2 size={14} strokeWidth={1.8} />} onClick={() => setDialog("delete")}>
					删除服务器
				</Button>
			</div>
			{dialog === "redeploy" && <DeployDialog view={view} open mode="redeploy" onClose={() => setDialog(null)} onStarted={() => navigate(paths.server(c.id))} />}
			{dialog === "uninstall" && <UninstallModal view={view} open defaultKeepSessions={keepSessions} onClose={() => setDialog(null)} />}
			{dialog === "delete" && <DeleteServerModal view={view} open onClose={() => setDialog(null)} />}
		</SettingsSection>
	);
}
