import type { ServerView, SshConfigHost, TestConnectionResult } from "@pi-web/shared";
import { CircleAlert, CircleCheck, FileInput, KeyRound } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { errorMessage } from "../../../api/client";
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Choice";
import { Callout } from "../../../components/ui/Display";
import { Field } from "../../../components/ui/Field";
import { Input } from "../../../components/ui/Input";
import { Spinner } from "../../../components/ui/Spinner";
import { cn } from "../../../lib/cn";
import { JumpHostsField } from "../components/JumpHostsField";
import { useSshConfigHosts } from "../hooks";
import {
	AUTH_METHOD_LABELS,
	type ConnectionFormErrors,
	type ConnectionFormValues,
	formFromSshHost,
	jumpChainLabel,
	sshHostExtra,
	sshHostTarget,
} from "../lib/connection-form";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-x-4 gap-y-3.5";

/** Outcome line next to the 测试连接 button. */
function TestStatus({
	testing,
	result,
	stale,
	jumpLabel,
	error,
}: {
	testing: boolean;
	result: TestConnectionResult | null;
	stale: boolean;
	jumpLabel: string;
	error: string | null;
}) {
	const via = jumpLabel ? `经 ${jumpLabel}，` : "";
	const base = "flex min-w-0 flex-[1_1_240px] items-center gap-1.5 text-xs";
	if (testing)
		return (
			<span role="status" className={cn(base, "text-fg-2")}>
				<Spinner size={12} /> 正在连接…
			</span>
		);
	if (error)
		return (
			<span role="alert" className={cn(base, "text-danger")}>
				<CircleAlert size={14} className="shrink-0" aria-hidden="true" />
				<span className="min-w-0 break-words">{error}</span>
			</span>
		);
	if (result && !stale) {
		if (result.ok)
			return (
				<span role="status" className={cn(base, "text-success-fg")}>
					<CircleCheck size={14} className="shrink-0 text-success" aria-hidden="true" />
					握手成功（{via}
					{result.latencyMs !== undefined ? `${Math.round(result.latencyMs)}ms` : "已认证"}）
					{result.hostKeyStatus !== "trusted" ? " · 下一步核对主机指纹" : ""}
				</span>
			);
		if (result.hostKey && result.hostKeyStatus === "unknown")
			return (
				<span role="status" className={cn(base, "text-success-fg")}>
					<CircleCheck size={14} className="shrink-0 text-success" aria-hidden="true" />
					已连接到 SSH 服务{jumpLabel ? `（经 ${jumpLabel}）` : ""} · 下一步核对主机指纹
				</span>
			);
		return (
			<span role="alert" className={cn(base, "text-danger")}>
				<CircleAlert size={14} className="shrink-0" aria-hidden="true" />
				<span className="min-w-0 break-words">{result.error ?? "连接失败"}</span>
			</span>
		);
	}
	return <span className={cn(base, "text-fg-3")}>测试连接只建立 SSH 会话，不写入任何文件</span>;
}

function SshImportPanel({ servers, form, onImport }: { servers: readonly ServerView[]; form: ConnectionFormValues; onImport: (values: ConnectionFormValues, entry: SshConfigHost, unresolved: string[]) => void }) {
	const [open, setOpen] = useState(false);
	const [imported, setImported] = useState<string | null>(null);
	const [unresolved, setUnresolved] = useState<string[]>([]);
	const hosts = useSshConfigHosts(open);
	const listId = useId();
	return (
		<section aria-label="从 SSH 配置导入" className="box-border flex max-w-full min-w-0 flex-[1_1_280px] flex-col gap-3 rounded-xl border border-border bg-panel p-4">
			<Button icon={<FileInput size={14} strokeWidth={1.8} />} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
				从 ~/.ssh/config 导入
			</Button>
			{open && (
				<div id={listId} className="flex flex-col gap-2">
					{hosts.isLoading ? (
						<span className="flex items-center gap-2 text-xs text-fg-3">
							<Spinner size={12} /> 正在读取…
						</span>
					) : hosts.isError ? (
						<Callout tone="danger">{errorMessage(hosts.error)}</Callout>
					) : !hosts.data?.length ? (
						<span className="text-xs text-fg-3">~/.ssh/config 中没有可导入的 Host 条目。</span>
					) : (
						<>
							<span className="section-label">HOST 条目 · {hosts.data.length}</span>
							<ul className="m-0 flex max-h-[360px] list-none flex-col overflow-y-auto rounded-lg border border-border p-0">
								{hosts.data.map((h, i) => {
									const extra = sshHostExtra(h);
									const isImported = imported === h.alias;
									return (
										<li key={h.alias} className={cn("flex items-center gap-2 px-2.5 py-2", i > 0 && "border-t border-border")}>
											<span className="flex min-w-0 flex-1 flex-col gap-0.5">
												<code className="text-mono text-fg">{h.alias}</code>
												<span className="truncate font-mono text-[11.5px] text-fg-3">{sshHostTarget(h)}</span>
												{extra && <span className="truncate text-[11.5px] text-fg-3">{extra}</span>}
											</span>
											{isImported ? (
												<span className="shrink-0 text-xs text-success-fg">已填入</span>
											) : (
												<button
													type="button"
													aria-label={`导入 ${h.alias}`}
													onClick={() => {
														const result = formFromSshHost(h, servers, form);
														setImported(h.alias);
														setUnresolved(result.unresolvedJumps);
														onImport(result.values, h, result.unresolvedJumps);
													}}
													className="h-6 shrink-0 border-0 bg-transparent px-1 text-xs text-link hover:text-link-hover"
												>
													导入
												</button>
											)}
										</li>
									);
								})}
							</ul>
							{unresolved.length > 0 && (
								<Callout tone="warning" title="跳板机未添加">
									{`ProxyJump ${unresolved.join("、")} 没有对应的服务器。请先添加跳板机（可勾选“仅作为跳板机”），再回来选择。`}
								</Callout>
							)}
						</>
					)}
					<span className="text-xs leading-[18px] text-fg-3">导入会读取 HostName、User、Port、IdentityFile 与 ProxyJump。</span>
				</div>
			)}
		</section>
	);
}

export interface ConnectionStepProps {
	form: ConnectionFormValues;
	onChange: (patch: Partial<ConnectionFormValues>) => void;
	errors: ConnectionFormErrors;
	servers: readonly ServerView[];
	selfId?: string;
	/** A password/passphrase is already stored for this (resumed) server. */
	hasStoredSecret: boolean;
	testing: boolean;
	testResult: TestConnectionResult | null;
	testStale: boolean;
	stepError: string | null;
	submitting: boolean;
	onTest: () => void;
	onNext: () => void;
	jumpOnly: boolean;
	onJumpOnlyChange: (value: boolean) => void;
}

export function ConnectionStep({
	form,
	onChange,
	errors,
	servers,
	selfId,
	hasStoredSecret,
	testing,
	testResult,
	testStale,
	stepError,
	submitting,
	onTest,
	onNext,
	jumpOnly,
	onJumpOnlyChange,
}: ConnectionStepProps) {
	const authLabelId = useId();
	const groupsId = useId();
	const groups = useMemo(() => [...new Set(servers.map((s) => s.config.group).filter(Boolean))] as string[], [servers]);
	const jumpLabel = jumpChainLabel(form.jumpServerIds, servers);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		onNext();
	};
	return (
		<div className="flex flex-wrap items-start gap-4">
			<form onSubmit={submit} noValidate aria-labelledby="as-conn-t" className="flex min-w-0 flex-[999_1_520px] flex-col rounded-xl border border-border bg-panel">
				<div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
					<h2 id="as-conn-t" className="m-0 flex-1 text-base font-semibold">
						SSH 连接
					</h2>
					<span className="text-xs text-fg-3">凭据用 Host 主密钥加密保存</span>
				</div>
				<div className="flex flex-col gap-4 p-4">
					<div className={GRID}>
						<Field label="名称" error={errors.name} hint={!form.name.trim() && form.host.trim() ? `留空则使用 ${form.username.trim() || "user"}@${form.host.trim()}` : undefined}>
							<Input invalid={Boolean(errors.name)} value={form.name} placeholder="例如 gpu-01" autoComplete="off" onChange={(e) => onChange({ name: e.target.value })} />
						</Field>
						<Field label="分组" error={errors.group}>
							<Input invalid={Boolean(errors.group)} value={form.group} placeholder="可选，例如 训练集群" list={groupsId} autoComplete="off" onChange={(e) => onChange({ group: e.target.value })} />
						</Field>
						<datalist id={groupsId}>
							{groups.map((g) => (
								<option key={g} value={g} />
							))}
						</datalist>
						<Field label="主机" required error={errors.host}>
							<Input mono invalid={Boolean(errors.host)} value={form.host} placeholder="10.0.3.21 或 gpu-01.internal" autoComplete="off" spellCheck={false} onChange={(e) => onChange({ host: e.target.value })} />
						</Field>
						<Field label="端口" error={errors.port}>
							<Input mono invalid={Boolean(errors.port)} inputMode="numeric" value={form.port} onChange={(e) => onChange({ port: e.target.value })} />
						</Field>
						<Field label="用户名" required error={errors.username}>
							<Input mono invalid={Boolean(errors.username)} value={form.username} placeholder="dev" autoComplete="off" spellCheck={false} onChange={(e) => onChange({ username: e.target.value })} />
						</Field>
						<Field label="跳板机" error={errors.jumpServerIds} hint={servers.filter((s) => s.config.id !== selfId).length === 0 ? "暂无其他服务器可作为跳板机" : undefined}>
							<JumpHostsField servers={servers} selfId={selfId} value={form.jumpServerIds} onChange={(ids) => onChange({ jumpServerIds: ids })} />
						</Field>
					</div>
					<div className="flex flex-col gap-2.5 border-t border-border pt-3.5">
						<span id={authLabelId} className="text-xs font-medium text-fg-2">
							认证方式
						</span>
						<Segmented
							aria-labelledby={authLabelId}
							size="md"
							tone="sunken"
							value={form.authMethod}
							onChange={(m) => onChange({ authMethod: m, secret: "" })}
							options={(["key", "password", "agent"] as const).map((m) => ({ value: m, label: AUTH_METHOD_LABELS[m] }))}
						/>
						{form.authMethod === "key" && (
							<div className={GRID}>
								<Field label="私钥路径" required error={errors.keyPath} hint="从 Host 读取，不会上传到服务器">
									<Input mono invalid={Boolean(errors.keyPath)} value={form.keyPath} spellCheck={false} onChange={(e) => onChange({ keyPath: e.target.value })} />
								</Field>
								<Field label="口令" error={errors.secret} hint={hasStoredSecret ? "已保存，留空保持不变" : "私钥未加密时留空"}>
									<Input type="password" invalid={Boolean(errors.secret)} autoComplete="new-password" value={form.secret} onChange={(e) => onChange({ secret: e.target.value })} />
								</Field>
							</div>
						)}
						{form.authMethod === "password" && (
							<div className={GRID}>
								<Field label="密码" required={!hasStoredSecret} error={errors.secret} hint={hasStoredSecret ? "已保存，留空保持不变" : "用 Host 主密钥加密保存"}>
									<Input type="password" invalid={Boolean(errors.secret)} autoComplete="new-password" value={form.secret} onChange={(e) => onChange({ secret: e.target.value })} />
								</Field>
							</div>
						)}
						{form.authMethod === "agent" && (
							<div className="flex min-h-8 items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-fg-code">
								<KeyRound size={14} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden="true" />
								<span>
									使用 Host 上 <code className="text-xs text-fg">SSH_AUTH_SOCK</code> 中的密钥
								</span>
							</div>
						)}
					</div>
					<label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-fg-2">
						<input type="checkbox" checked={jumpOnly} onChange={(e) => onJumpOnlyChange(e.target.checked)} className="m-0 size-3.5 accent-primary" />
						仅作为跳板机（不部署 pi，不在侧栏显示）
					</label>
				</div>
				<div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
					<TestStatus testing={testing} result={testResult} stale={testStale} jumpLabel={jumpLabel} error={stepError} />
					<Button onClick={onTest} disabled={testing || submitting}>
						测试连接
					</Button>
					<Button type="submit" variant="primary" loading={submitting}>
						{jumpOnly ? "保存跳板机" : "下一步"}
					</Button>
				</div>
			</form>
			<SshImportPanel servers={servers} form={form} onImport={(values) => onChange(values)} />
		</div>
	);
}
