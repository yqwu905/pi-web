import type { AgentStatus, ProbeResult } from "@pi-web/shared";
import { useMutation } from "@tanstack/react-query";
import { Info, Plus, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { errorMessage, getAgentStatus, probeServer } from "../../../api/client";
import { Button } from "../../../components/ui/Button";
import { Radio, RadioGroup, Segmented } from "../../../components/ui/Choice";
import { Input, Textarea } from "../../../components/ui/Input";
import { cn } from "../../../lib/cn";
import { formatRelativeTime } from "../../../lib/format";
import { agentAvailable } from "../hooks";
import { Hint, SettingRow, SettingsSection } from "../components/SettingsLayout";
import { normalizeDomain, validateDomain } from "../lib/lists";
import type { SectionProps } from "./types";

interface ProxyTestResult {
	at: number;
	agent?: AgentStatus;
	agentError?: string;
	probe?: ProbeResult;
	probeError?: string;
}

type RowTone = "pass" | "warn" | "fail" | "info";
const TAG: Record<RowTone, { text: string; className: string }> = {
	pass: { text: "通过", className: "bg-success-soft text-success-fg" },
	warn: { text: "注意", className: "bg-warning-strong text-warning-fg" },
	fail: { text: "失败", className: "bg-danger-soft text-danger" },
	info: { text: "信息", className: "bg-selected text-link" },
};

function TestRow({ tone, label, children }: { tone: RowTone; label: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-xs">
			<span className={cn("w-10 shrink-0 rounded-sm py-px text-center text-2xs font-medium", TAG[tone].className)}>{TAG[tone].text}</span>
			<span className="w-24 shrink-0 text-fg-2">{label}</span>
			<span className="min-w-0 flex-[1_1_240px] text-fg-code">{children}</span>
		</div>
	);
}

/**
 * "测试代理连通性": there is no per-domain CONNECT test endpoint yet, so this checks what the
 * existing API can tell — the agent's proxy listener (agent-status) and direct internet access
 * (probe) — and explains the allowlist.
 * TODO(api): replace with a host endpoint that CONNECTs each allowed domain through the tunnel.
 */
function ProxyTest({ view, form, dirty }: Pick<SectionProps, "view" | "form" | "dirty">) {
	const id = view.config.id;
	const test = useMutation({
		mutationFn: async (): Promise<ProxyTestResult> => {
			const [agent, probe] = await Promise.allSettled([getAgentStatus(id), probeServer(id)]);
			return {
				at: Date.now(),
				...(agent.status === "fulfilled" ? { agent: agent.value } : { agentError: errorMessage(agent.reason) }),
				...(probe.status === "fulfilled" ? { probe: probe.value } : { probeError: errorMessage(probe.reason) }),
			};
		},
	});
	const r = test.data;
	const port = view.config.proxy.port;
	const proxyDirty = ["proxyMode", "proxyPort", "proxyScope", "toolsPolicy", "extraDomains", "noProxyText"].some((f) => dirty.has(f as never));
	const listening = r?.agent?.proxy.listening;
	const reachable = r?.probe?.internet.reachable;
	return (
		<div className="flex flex-col gap-2.5 border-t border-border px-4 py-3.5">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<Button icon={<ShieldCheck size={14} strokeWidth={1.8} className="text-accent" />} loading={test.isPending} disabled={!agentAvailable(view)} onClick={() => test.mutate()}>
					{r ? "重新测试" : "测试代理连通性"}
				</Button>
				<Hint>
					{agentAvailable(view)
						? `检查服务器上的代理入口 127.0.0.1:${port} 与外网直连情况${proxyDirty ? "（基于已保存的设置）" : ""}`
						: "服务器未连接或未部署，无法测试"}
				</Hint>
			</div>
			{test.isError && <Hint tone="danger">{errorMessage(test.error)}</Hint>}
			{r && (
				<div role="status" className="flex flex-col gap-1.5 rounded-md border border-border bg-code px-3 py-2.5">
					<span className={cn("text-xs font-semibold", listening ? "text-success-fg" : "text-warning-fg")}>
						{listening ? "代理入口工作正常" : "代理入口未就绪"} · {formatRelativeTime(r.at)}
					</span>
					{r.agentError ? (
						<TestRow tone="fail" label="代理入口">
							无法读取 agent 状态：{r.agentError}
						</TestRow>
					) : (
						<TestRow tone={listening ? "pass" : "fail"} label="代理入口">
							{listening
								? `127.0.0.1:${r.agent?.proxy.port ?? port} 正在监听 · ${r.agent?.proxy.activeConnections ?? 0} 个活动连接`
								: `agent 未在 127.0.0.1:${port} 监听；保存设置后 Host 会重新配置 agent`}
						</TestRow>
					)}
					{r.probeError ? (
						<TestRow tone="fail" label="外网直连">
							探测失败：{r.probeError}
						</TestRow>
					) : (
						<TestRow tone={reachable ? "info" : form.proxyMode === "tunnel" ? "pass" : "warn"} label="外网直连">
							{reachable
								? "服务器可直接访问 api.anthropic.com（关闭代理也能工作）"
								: form.proxyMode === "tunnel"
									? "服务器无法直连外网，LLM 请求经隧道发出，符合预期"
									: "服务器无法直连外网，关闭代理后 pi 将无法访问 LLM"}
						</TestRow>
					)}
					<TestRow tone="info" label="bash 工具">
						{form.proxyScope === "llm"
							? "不继承代理变量（shellCommandPrefix 在下次同步时注入）"
							: form.toolsPolicy === "all"
								? "继承 HTTPS_PROXY，所有域名均放行"
								: "继承 HTTPS_PROXY，非白名单域名返回 403"}
					</TestRow>
					<span className="pt-1 text-2xs text-fg-3">逐个域名的 CONNECT 测试尚未提供接口；被拒绝的请求可在服务器概览的“隧道代理”中查看。</span>
				</div>
			)}
		</div>
	);
}

export function ProxySection({ view, form, set, errors, dirty }: SectionProps) {
	const ids = { mode: useId(), port: useId(), scope: useId(), allow: useId(), domain: useId(), noProxy: useId() };
	const [domainInput, setDomainInput] = useState("");
	const [domainError, setDomainError] = useState<string | null>(null);
	const tunnel = form.proxyMode === "tunnel";
	const saved = view.config.proxy;
	const live = saved.mode === "tunnel";
	const addDomain = () => {
		const d = normalizeDomain(domainInput);
		const err = validateDomain(d, form.extraDomains);
		if (err) {
			setDomainError(err);
			return;
		}
		set({ extraDomains: [...form.extraDomains, d] });
		setDomainInput("");
		setDomainError(null);
	};
	const onDomainKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			addDomain();
		}
	};
	return (
		<SettingsSection
			id="sec-proxy"
			title="LLM 代理"
			description="pi 的请求经 SSH 连接转发到 Host 出口；Host 只看到目标域名，并强制执行白名单。"
			actions={
				<span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-fg-2">
					<span aria-hidden="true" className={cn("size-1.5 rounded-full", live ? "bg-success" : "border-[1.5px] border-fg-4")} />
					当前：{live ? `隧道 · ${view.status.proxy?.active ?? 0} 个连接` : "直连（代理关闭）"}
				</span>
			}
		>
			<SettingRow first label="模式" labelId={ids.mode} dirty={dirty.has("proxyMode")}>
				<Segmented
					aria-labelledby={ids.mode}
					tone="sunken"
					value={form.proxyMode}
					onChange={(proxyMode) => set({ proxyMode })}
					options={[
						{ value: "off", label: "关闭" },
						{ value: "tunnel", label: "隧道" },
					]}
				/>
				{tunnel ? (
					<Hint>pi 的 HTTPS_PROXY 指向服务器本地入口，即使 sshd 禁用了端口转发也可用。</Hint>
				) : (
					<div className="flex items-start gap-2 rounded-md border border-border bg-bg px-3 py-2">
						<Info size={14} className="mt-0.5 shrink-0 text-fg-3" aria-hidden="true" />
						<Hint>服务器需能直接访问各 provider。pi 进程不设置 HTTPS_PROXY，也不注入 shellCommandPrefix。</Hint>
					</div>
				)}
			</SettingRow>
			{tunnel && (
				<>
					<SettingRow label="入口端口" htmlFor={ids.port} dirty={dirty.has("proxyPort")}>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
							<span
								className={cn(
									"flex h-8 items-center overflow-hidden rounded-md border bg-bg focus-within:border-accent",
									errors.proxyPort ? "border-danger-strong" : "border-border",
								)}
							>
								<span className="flex h-full items-center border-r border-border bg-raised px-2 font-mono text-mono text-fg-3">127.0.0.1:</span>
								<input
									id={ids.port}
									inputMode="numeric"
									value={form.proxyPort}
									aria-invalid={Boolean(errors.proxyPort) || undefined}
									onChange={(e) => set({ proxyPort: e.target.value })}
									className="h-full w-[72px] border-0 bg-transparent px-2 font-mono text-mono text-fg outline-none focus-visible:outline-none"
								/>
							</span>
							<Hint className="min-w-0 flex-[1_1_240px]">agent 只监听回环地址并校验令牌；端口固定，SSH 重连后已运行的 pi 进程不受影响。</Hint>
						</div>
						{errors.proxyPort && <Hint tone="danger">{errors.proxyPort}</Hint>}
					</SettingRow>
					<SettingRow label="作用范围" labelId={ids.scope} dirty={dirty.has("proxyScope")} align="text">
						<RadioGroup value={form.proxyScope} onChange={(v) => set({ proxyScope: v as typeof form.proxyScope })} spacing="loose" name={ids.scope}>
							<Radio
								value="llm"
								label="仅 LLM 请求（推荐）"
								description={
									<>
										会向服务器 settings.json 注入 <code className="text-[11.5px] text-fg-code">shellCommandPrefix</code>，让 bash 工具不继承代理变量，访问内网镜像不受影响。
									</>
								}
							/>
							<Radio value="tools" label="工具命令也走代理" description="不注入前缀，bash 等工具继承 HTTPS_PROXY，经 Host 出口访问外网。" />
						</RadioGroup>
					</SettingRow>
					{form.proxyScope === "tools" && (
						<SettingRow label="放行策略" labelId={ids.allow} dirty={dirty.has("toolsPolicy")} align="text">
							<RadioGroup inline value={form.toolsPolicy} onChange={(v) => set({ toolsPolicy: v as typeof form.toolsPolicy })} name={ids.allow}>
								<Radio value="allowlist" label="仅白名单域名" />
								<Radio value="all" label="全部放行" />
							</RadioGroup>
							<div className="flex items-start gap-2">
								<TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
								<Hint tone="warning">
									{form.toolsPolicy === "all"
										? "服务器上的任意命令都能经 Host 访问外网，Host 只记录目标域名；内网 pip/npm 镜像请加入 NO_PROXY。"
										: "pip、curl 等命令访问外网也会经 Host 出口，不在白名单中的域名会被拒绝；内网 pip/npm 镜像请加入 NO_PROXY。"}
								</Hint>
							</div>
						</SettingRow>
					)}
					<SettingRow label="额外放行域名" htmlFor={ids.domain} dirty={dirty.has("extraDomains")} align="text">
						<div className="flex flex-wrap items-center gap-1.5">
							{form.extraDomains.length === 0 ? (
								<span className="text-xs text-fg-3">未追加域名</span>
							) : (
								form.extraDomains.map((d) => (
									<span
										key={d}
										className="inline-flex h-7 items-center gap-0.5 rounded-md border border-border-strong bg-raised pr-1 pl-2.5 font-mono text-xs text-fg-code"
									>
										{d}
										<button
											type="button"
											aria-label={`移除 ${d}`}
											onClick={() => set({ extraDomains: form.extraDomains.filter((x) => x !== d) })}
											className="flex size-5 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-fg-3 hover:bg-chip hover:text-fg"
										>
											<X size={12} strokeWidth={2} />
										</button>
									</span>
								))
							)}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Input
								id={ids.domain}
								mono
								placeholder="例如 pypi.org"
								value={domainInput}
								invalid={Boolean(domainError)}
								className="min-w-0 flex-[0_1_240px]"
								onChange={(e) => {
									setDomainInput(e.target.value);
									setDomainError(null);
								}}
								onKeyDown={onDomainKey}
							/>
							<Button icon={<Plus size={12} strokeWidth={2.2} />} onClick={addDomain} disabled={!domainInput.trim()}>
								添加
							</Button>
						</div>
						{domainError ? <Hint tone="danger">{domainError}</Hint> : <Hint>白名单 = Host 上 pi 已知的 provider 域名（含 models.json 自定义 provider，自动收集）+ 以上域名。支持 *.example.com。</Hint>}
					</SettingRow>
					<SettingRow label="NO_PROXY" htmlFor={ids.noProxy} dirty={dirty.has("noProxyText")} mono>
						<Textarea
							id={ids.noProxy}
							mono
							rows={2}
							spellCheck={false}
							value={form.noProxyText}
							invalid={Boolean(errors.noProxyText)}
							placeholder="10.0.0.0/8,vllm.internal"
							onChange={(e) => set({ noProxyText: e.target.value })}
						/>
						{errors.noProxyText ? (
							<Hint tone="danger">{errors.noProxyText}</Hint>
						) : (
							<Hint>内网 LLM（如自建 vLLM）应加入 NO_PROXY，直连不经过 Host。以逗号或换行分隔；全局默认值（localhost 等）会自动合并。</Hint>
						)}
					</SettingRow>
					<ProxyTest view={view} form={form} dirty={dirty} />
				</>
			)}
		</SettingsSection>
	);
}
