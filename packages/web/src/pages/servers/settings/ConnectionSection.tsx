import type { TestConnectionResult } from "@pi-web/shared";
import { useMutation } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Fingerprint, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { errorMessage, testConnection, testServer } from "../../../api/client";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Select } from "../../../components/ui/Select";
import { cn } from "../../../lib/cn";
import { useServers } from "../../../stores/servers";
import { JumpHostsField } from "../components/JumpHostsField";
import { HostKeyModal } from "../components/ServerDialogs";
import { Hint, SettingRow, SettingsSection } from "../components/SettingsLayout";
import { AUTH_METHOD_LABELS, toTestRequest } from "../lib/connection-form";
import type { SectionProps } from "./types";

function shortFingerprint(fp: string): string {
	const body = fp.replace(/^SHA256:/, "");
	return body.length > 12 ? `SHA256:${body.slice(0, 4)}…${body.slice(-4)}` : fp;
}

function TestResult({ result, error }: { result: TestConnectionResult | null; error: unknown }) {
	if (error)
		return (
			<span role="alert" className="flex items-center gap-1.5 text-xs text-danger">
				<CircleAlert size={13} aria-hidden="true" />
				{errorMessage(error)}
			</span>
		);
	if (!result) return null;
	if (result.ok)
		return (
			<span role="status" className="flex items-center gap-1.5 text-xs text-success-fg">
				<CircleCheck size={13} className="text-success" aria-hidden="true" />
				连接正常{result.latencyMs !== undefined ? ` · ${Math.round(result.latencyMs)}ms` : ""}
			</span>
		);
	return (
		<span role="alert" className="flex min-w-0 items-center gap-1.5 text-xs text-danger">
			<CircleAlert size={13} className="shrink-0" aria-hidden="true" />
			<span className="min-w-0 break-words">
				{result.hostKeyStatus === "unknown" && result.hostKey ? "主机指纹与已信任的不同或尚未确认，请使用“重置指纹”核对" : (result.error ?? "连接失败")}
			</span>
		</span>
	);
}

export function ConnectionSection({ view, form, set, errors, dirty }: SectionProps) {
	const servers = useServers({ includeJumpOnly: true });
	const [hostKeyOpen, setHostKeyOpen] = useState(false);
	const ids = { name: useId(), group: useId(), host: useId(), port: useId(), user: useId(), auth: useId(), key: useId(), secret: useId(), jump: useId() };
	const connDirty = ["host", "port", "username", "authMethod", "keyPath", "secret", "jumpServerIds"].some((f) => dirty.has(f as never));
	// Unsaved connection fields are tested as typed; otherwise the saved configuration (with its stored secret).
	const test = useMutation({
		mutationFn: () => (connDirty ? testConnection(toTestRequest(form)) : testServer(view.config.id)),
	});
	const hostKey = view.config.hostKey;
	const auth = view.config.auth;
	const secretStored = Boolean(auth.hasSecret && auth.method === form.authMethod);
	return (
		<SettingsSection
			id="sec-conn"
			title="连接"
			description="修改后将重新连接；pi 进程由服务器上的 daemon 持有，不会中断。"
			actions={
				<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
					<TestResult result={test.data ?? null} error={test.error} />
					<Button size="sm" loading={test.isPending} onClick={() => test.mutate()}>
						测试连接
					</Button>
				</div>
			}
		>
			<SettingRow first label="名称" htmlFor={ids.name} dirty={dirty.has("name") || dirty.has("group")}>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<Input id={ids.name} value={form.name} className="min-w-0 flex-[1_1_200px]" invalid={Boolean(errors.name)} onChange={(e) => set({ name: e.target.value })} />
					<label htmlFor={ids.group} className="text-sm text-fg-2">
						分组
					</label>
					<Input id={ids.group} value={form.group} placeholder="可选" className="max-w-40" onChange={(e) => set({ group: e.target.value })} />
				</div>
				{errors.name && <Hint tone="danger">{errors.name}</Hint>}
			</SettingRow>
			<SettingRow label="主机" htmlFor={ids.host} dirty={dirty.has("host") || dirty.has("port")}>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<Input
						id={ids.host}
						mono
						value={form.host}
						spellCheck={false}
						className="min-w-0 flex-[1_1_200px]"
						invalid={Boolean(errors.host)}
						onChange={(e) => set({ host: e.target.value })}
					/>
					<label htmlFor={ids.port} className="text-sm text-fg-2">
						端口
					</label>
					<Input id={ids.port} mono inputMode="numeric" value={form.port} className="max-w-20" invalid={Boolean(errors.port)} onChange={(e) => set({ port: e.target.value })} />
				</div>
				{(errors.host || errors.port) && <Hint tone="danger">{errors.host ?? errors.port}</Hint>}
			</SettingRow>
			<SettingRow label="用户名" htmlFor={ids.user} dirty={dirty.has("username")}>
				<Input id={ids.user} mono value={form.username} spellCheck={false} className="max-w-[280px]" invalid={Boolean(errors.username)} onChange={(e) => set({ username: e.target.value })} />
				{errors.username && <Hint tone="danger">{errors.username}</Hint>}
			</SettingRow>
			<SettingRow label="认证" htmlFor={ids.auth} dirty={dirty.has("authMethod") || dirty.has("keyPath") || dirty.has("secret")}>
				<div className="flex flex-wrap items-center gap-2">
					<Select
						id={ids.auth}
						value={form.authMethod}
						wrapperClassName="max-w-[120px]"
						onChange={(e) => set({ authMethod: e.target.value as typeof form.authMethod, secret: "" })}
						options={(["key", "password", "agent"] as const).map((m) => ({ value: m, label: AUTH_METHOD_LABELS[m] }))}
					/>
					{form.authMethod === "key" && (
						<>
							<label htmlFor={ids.key} className="sr-only">
								私钥路径
							</label>
							<Input
								id={ids.key}
								mono
								value={form.keyPath}
								spellCheck={false}
								className="min-w-0 flex-[1_1_220px]"
								invalid={Boolean(errors.keyPath)}
								onChange={(e) => set({ keyPath: e.target.value })}
							/>
						</>
					)}
					{form.authMethod !== "agent" && (
						<>
							<label htmlFor={ids.secret} className="sr-only">
								{form.authMethod === "key" ? "私钥口令" : "密码"}
							</label>
							<Input
								id={ids.secret}
								type="password"
								autoComplete="new-password"
								value={form.secret}
								placeholder={
									form.authMethod === "key"
										? secretStored
											? "口令已保存，留空保持不变"
											: "口令（私钥未加密时留空）"
										: secretStored
											? "密码已保存，留空保持不变"
											: "密码"
								}
								className={cn("min-w-0", form.authMethod === "key" ? "flex-[1_1_200px]" : "flex-[1_1_260px]")}
								invalid={Boolean(errors.secret)}
								onChange={(e) => set({ secret: e.target.value })}
							/>
						</>
					)}
				</div>
				{errors.keyPath || errors.secret ? (
					<Hint tone="danger">{errors.keyPath ?? errors.secret}</Hint>
				) : form.authMethod === "agent" ? (
					<Hint>使用 Host 上 SSH_AUTH_SOCK 中的密钥。</Hint>
				) : (
					<Hint>{form.authMethod === "key" ? "私钥从 Host 读取，不会上传到服务器。" : "密码用 Host 主密钥加密保存。"}</Hint>
				)}
			</SettingRow>
			<SettingRow label="跳板机" htmlFor={ids.jump} dirty={dirty.has("jumpServerIds")}>
				<div className="flex flex-wrap items-start gap-x-3 gap-y-2">
					<JumpHostsField
						id={ids.jump}
						servers={servers}
						selfId={view.config.id}
						value={form.jumpServerIds}
						noneLabel="不使用"
						selectClassName="max-w-[240px]"
						onChange={(jumpServerIds) => set({ jumpServerIds })}
					/>
					<Hint className="pt-1.5">ProxyJump，按顺序经过，可多级</Hint>
				</div>
				{errors.jumpServerIds && <Hint tone="danger">{errors.jumpServerIds}</Hint>}
			</SettingRow>
			<SettingRow label="主机指纹" align="text">
				<div className="flex flex-wrap items-center gap-2">
					{hostKey ? (
						<>
							<code
								title={hostKey.fingerprint}
								className="inline-flex h-7 items-center rounded-md border border-border bg-code px-2.5 text-mono text-fg-code"
							>
								{shortFingerprint(hostKey.fingerprint)}
							</code>
							<span className="rounded-sm bg-chip px-1.5 py-0.5 text-2xs font-medium text-fg-2">{hostKey.algorithm.replace(/^ssh-/, "").toUpperCase()}</span>
							<span className="inline-flex items-center gap-1 rounded-sm bg-success-soft px-1.5 py-0.5 text-2xs font-medium text-success-fg">
								<ShieldCheck size={10} aria-hidden="true" />
								已确认
							</span>
						</>
					) : (
						<span className="rounded-sm bg-warning-strong px-1.5 py-0.5 text-2xs font-medium text-warning-fg">尚未确认</span>
					)}
					<span className="flex-1" />
					<Button size="sm" icon={<Fingerprint size={12} strokeWidth={2} />} onClick={() => setHostKeyOpen(true)}>
						{hostKey ? "重置指纹" : "确认指纹"}
					</Button>
				</div>
				<Hint>首次连接时确认，之后指纹变化会拒绝连接。仅在服务器重装或更换主机密钥后重置。</Hint>
			</SettingRow>
			{hostKeyOpen && <HostKeyModal view={view} open onClose={() => setHostKeyOpen(false)} />}
		</SettingsSection>
	);
}
