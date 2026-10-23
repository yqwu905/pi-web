import { Lock } from "lucide-react";
import { useId } from "react";
import { EnvEditor } from "../../../components/EnvEditor";
import { Hint, SettingRow, SettingsSection } from "../components/SettingsLayout";
import { agentWritesEnvFile } from "../lib/server-settings-form";
import type { SectionProps } from "./types";

/** 服务器级环境变量: R/run/env.sh on the server, extraEnv of every pi process. */
export function EnvSection({ view, form, set, errors, dirty }: SectionProps) {
	const labelId = useId();
	const root = view.config.remoteRoot;
	// An older agent passes the variables to pi processes but writes no run/env.sh, and the
	// R/bin/pi it was deployed with does not read one.
	const agentVersion = view.status.agent?.version ?? view.config.deployed?.agentVersion;
	const needsUpgrade = agentVersion !== undefined && !agentWritesEnvFile(agentVersion);
	return (
		<SettingsSection
			id="sec-env"
			title="环境变量"
			description={
				<>
					服务器级环境变量，作用于该服务器上所有工作区的 pi 进程、Web 终端以及 <code className="text-fg-code">{root}/bin/pi</code>。
				</>
			}
		>
			<SettingRow first label="服务器级变量" labelId={labelId} dirty={dirty.has("env")}>
				<EnvEditor rows={form.env} errors={errors.env ?? {}} onChange={(env) => set({ env })} labelledBy={labelId} />
				{needsUpgrade && (
					<Hint tone="warning">
						该服务器上的 pi-web-agent {agentVersion} 需要升级：对话中新启动的 pi 进程已能读取这些变量，Web 终端和 <code>{root}/bin/pi</code>{" "}
						需在“危险操作 → 重新部署”后生效。
					</Hint>
				)}
				<Hint>工作区中设置的同名变量优先。修改后对新启动的 pi 进程和新打开的终端生效，运行中的对话保持原有环境。</Hint>
				<span className="inline-flex items-start gap-1.5 text-xs leading-[18px] text-fg-3">
					<Lock size={12} className="mt-[3px] shrink-0" aria-hidden="true" />
					<span>
						变量值以明文保存在 Host 数据目录和服务器上的 <code className="text-fg-code">{root}/run/env.sh</code>（权限 0600）中，请勿在此存放高价值密钥。
					</span>
				</span>
			</SettingRow>
		</SettingsSection>
	);
}
