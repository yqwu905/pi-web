import type { DeployProgress, DeployRequest, ProbeResult, ServerView } from "@pi-web/shared";
import { CircleStop, Rocket, TriangleAlert } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link } from "react-router";
import { useMeta, useSettings } from "../../../api/hooks";
import { Button, ButtonLink } from "../../../components/ui/Button";
import { Callout } from "../../../components/ui/Display";
import { Input } from "../../../components/ui/Input";
import { cn } from "../../../lib/cn";
import { paths } from "../../../lib/routes";
import { DeployProgressPanel } from "../components/DeployProgressPanel";
import { serverTarget } from "../lib/connection-form";

export interface DeployOptions {
	agentDirMode: "isolated" | "shared";
	piPolicy: "host" | "pinned";
	piVersion: string;
	proxyMode: "off" | "tunnel";
	proxyScope: "llm" | "tools";
}

const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function toDeployRequest(o: DeployOptions): DeployRequest {
	return {
		agentDirMode: o.agentDirMode,
		proxyMode: o.proxyMode,
		proxyScope: o.proxyScope,
		...(o.piPolicy === "pinned" ? { piVersion: o.piVersion.trim().replace(/^v/, "") } : {}),
		sync: true,
	};
}

/** "x86_64" → "x64", "aarch64" → "arm64". */
export function nodeArch(arch: string | undefined): string | undefined {
	if (!arch) return undefined;
	if (/^(x86_64|amd64|x64)$/i.test(arch)) return "x64";
	if (/^(aarch64|arm64)$/i.test(arch)) return "arm64";
	return arch;
}

const NODE_SOURCE_LABELS = { official: "nodejs.org", npmmirror: "npmmirror", custom: "自定义源" } as const;

function OptionRow({ label, labelId, children, last }: { label: string; labelId: string; children: ReactNode; last?: boolean }) {
	return (
		<div role="radiogroup" aria-labelledby={labelId} className={cn("flex flex-wrap gap-x-3 gap-y-2 px-4 py-3.5", !last && "border-b border-border")}>
			<span id={labelId} className="shrink-0 basis-[88px] text-xs leading-5 font-medium text-fg-2">
				{label}
			</span>
			<div className="flex min-w-0 flex-[1_1_240px] flex-col gap-2.5">{children}</div>
		</div>
	);
}

function RadioOption({
	name,
	checked,
	onSelect,
	disabled,
	title,
	description,
}: {
	name: string;
	checked: boolean;
	onSelect: () => void;
	disabled?: boolean;
	title: ReactNode;
	description?: ReactNode;
}) {
	return (
		<label className={cn("flex gap-2", description ? "items-start" : "items-center", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
			<input type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} className={cn("m-0 size-3.5 shrink-0 accent-primary", description && "mt-[3px]")} />
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="flex flex-wrap items-center gap-1.5 text-sm leading-5 text-fg">{title}</span>
				{description && <span className="text-xs leading-[18px] text-fg-3">{description}</span>}
			</span>
		</label>
	);
}

export interface DeployStepProps {
	view: ServerView;
	probe: ProbeResult | undefined;
	job: DeployProgress | null | undefined;
	starting: boolean;
	startError: string | null;
	cancelling: boolean;
	onStart: (options: DeployOptions) => void;
	onCancel: () => void;
	onNext: () => void;
}

export function DeployStep({ view, probe, job, starting, startError, cancelling, onStart, onCancel, onNext }: DeployStepProps) {
	const settings = useSettings();
	const meta = useMeta();
	const c = view.config;
	const [options, setOptions] = useState<DeployOptions>(() => ({
		agentDirMode: c.agentDirMode,
		piPolicy: settings.data?.piVersionPolicy ?? "host",
		piVersion: settings.data?.piPinnedVersion ?? "",
		proxyMode: probe && !probe.internet.reachable ? "tunnel" : c.proxy.mode,
		proxyScope: c.proxy.scope,
	}));
	const set = (patch: Partial<DeployOptions>) => setOptions((o) => ({ ...o, ...patch }));
	const ids = { dir: useId(), ver: useId(), node: useId(), proxy: useId(), scope: useId(), verInput: useId() };
	const running = job?.state === "running";
	const locked = running || starting;
	const versionInvalid = options.piPolicy === "pinned" && !VERSION.test(options.piVersion.trim());
	const arch = nodeArch(probe?.arch ?? c.deployed?.arch);
	const nodeVersion = settings.data?.nodeVersion;
	const hostPi = meta.data?.hostPiVersion;
	const offlineServer = probe && !probe.internet.reachable;

	const idleAction = (
		<Button variant="primary" icon={<Rocket size={14} strokeWidth={1.8} />} loading={starting} disabled={versionInvalid} onClick={() => onStart(options)}>
			开始部署
		</Button>
	);
	const retryAction = (
		<Button icon={<Rocket size={14} strokeWidth={1.8} />} loading={starting} disabled={versionInvalid} onClick={() => onStart(options)}>
			重新部署
		</Button>
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-start gap-4">
				<section aria-labelledby="as-opt-t" className="flex max-w-full min-w-0 flex-[1_1_400px] flex-col rounded-xl border border-border bg-panel">
					<div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3.5">
						<h2 id="as-opt-t" className="m-0 flex-1 text-base font-semibold">
							部署选项
						</h2>
						<Link to={paths.serverSettings(c.id)} className="text-xs">
							部署后可在服务器设置中修改
						</Link>
					</div>
					<div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 text-xs text-fg-2">
						目标 <code className="text-xs text-fg-code">{serverTarget(c)}</code> · 安装到 <code className="text-xs text-fg-code">{c.remoteRoot}</code>
					</div>
					<OptionRow label="Agent 目录" labelId={ids.dir}>
						<RadioOption
							name={ids.dir}
							checked={options.agentDirMode === "isolated"}
							disabled={locked}
							onSelect={() => set({ agentDirMode: "isolated" })}
							title={
								<>
									独立 <code className="text-xs text-fg-code">{c.remoteRoot}/agent</code>
									<span className="rounded-sm bg-success-soft px-1.5 text-2xs leading-4 text-success-fg">推荐</span>
								</>
							}
							description="与服务器上已有的 pi 配置互不影响"
						/>
						<RadioOption
							name={ids.dir}
							checked={options.agentDirMode === "shared"}
							disabled={locked}
							onSelect={() => set({ agentDirMode: "shared" })}
							title={
								<>
									共用 <code className="text-xs text-fg-code">~/.pi/agent</code>
								</>
							}
							description={
								<span className="flex items-center gap-1.5">
									<TriangleAlert size={12} className="shrink-0 text-warning" aria-hidden="true" />
									注意：会覆盖服务器上已有的 pi 配置
								</span>
							}
						/>
					</OptionRow>
					<OptionRow label="pi 版本" labelId={ids.ver}>
						<RadioOption
							name={ids.ver}
							checked={options.piPolicy === "host"}
							disabled={locked}
							onSelect={() => set({ piPolicy: "host" })}
							title={
								<span>
									跟随 Host{hostPi ? <> · <code className="text-xs text-fg-code">{hostPi}</code></> : <span className="text-fg-3">（未检测到 Host 上的 pi，将使用内置版本）</span>}
								</span>
							}
						/>
						<div className="flex flex-wrap items-center gap-2">
							<RadioOption name={ids.ver} checked={options.piPolicy === "pinned"} disabled={locked} onSelect={() => set({ piPolicy: "pinned" })} title="指定版本" />
							<label htmlFor={ids.verInput} className="sr-only">
								指定 pi 版本号
							</label>
							<Input
								id={ids.verInput}
								mono
								size="sm"
								placeholder="例如 1.3.2"
								className="max-w-[120px]"
								value={options.piVersion}
								disabled={locked}
								invalid={options.piPolicy === "pinned" && options.piVersion.trim() !== "" && versionInvalid}
								onFocus={() => set({ piPolicy: "pinned" })}
								onChange={(e) => set({ piVersion: e.target.value, piPolicy: "pinned" })}
							/>
						</div>
					</OptionRow>
					<div className="flex flex-wrap gap-x-3 gap-y-2 border-b border-border px-4 py-3.5">
						<span id={ids.node} className="shrink-0 basis-[88px] text-xs leading-5 font-medium text-fg-2">
							Node 运行时
						</span>
						<span aria-labelledby={ids.node} className="flex min-w-0 flex-[1_1_240px] flex-wrap items-center gap-1.5 text-sm leading-5 text-fg">
							<code className="text-mono">
								{nodeVersion === "latest-22" || !nodeVersion ? "最新 22.x" : nodeVersion}
								{arch ? ` · linux-${arch}` : ""}
							</code>
							{settings.data && <span className="text-fg-2">（来源 {NODE_SOURCE_LABELS[settings.data.nodeSource]}）</span>}
							<span className="rounded-sm border border-border bg-chip px-1.5 text-2xs leading-4 text-fg-3">只读</span>
						</span>
					</div>
					<OptionRow label="LLM 代理" labelId={ids.proxy}>
						<RadioOption
							name={ids.proxy}
							checked={options.proxyMode === "tunnel"}
							disabled={locked}
							onSelect={() => set({ proxyMode: "tunnel" })}
							title={<>隧道{offlineServer && <span className="rounded-sm bg-success-soft px-1.5 text-2xs leading-4 text-success-fg">推荐</span>}</>}
							description={
								<>
									入口 <code className="text-[11.5px] text-fg-2">127.0.0.1:{c.proxy.port}</code>，经 SSH Link 回到 Host 发出
								</>
							}
						/>
						<RadioOption
							name={ids.proxy}
							checked={options.proxyMode === "off"}
							disabled={locked}
							onSelect={() => set({ proxyMode: "off" })}
							title="关闭（服务器可直连）"
							description={offlineServer ? <span className="text-warning-fg">探测显示服务器无法访问外网，关闭后 pi 将无法调用 LLM</span> : undefined}
						/>
					</OptionRow>
					<OptionRow label="代理范围" labelId={ids.scope} last>
						<RadioOption
							name={ids.scope}
							checked={options.proxyScope === "llm"}
							disabled={locked || options.proxyMode === "off"}
							onSelect={() => set({ proxyScope: "llm" })}
							title="仅 LLM"
							description="bash 工具不继承代理变量，内网镜像照常访问"
						/>
						<RadioOption
							name={ids.scope}
							checked={options.proxyScope === "tools"}
							disabled={locked || options.proxyMode === "off"}
							onSelect={() => set({ proxyScope: "tools" })}
							title="工具命令也走代理"
							description="按 Host 白名单放行"
						/>
					</OptionRow>
				</section>
				<div className="flex max-w-full min-w-0 flex-[1.4_1_480px] flex-col gap-3">
					<DeployProgressPanel
						job={job}
						idleText="确认左侧选项后开始部署；命中 Host 缓存时跳过下载与打包。"
						idleAction={idleAction}
					/>
					{startError && (
						<Callout tone="danger" title="无法开始部署">
							{startError}
						</Callout>
					)}
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<span className="min-w-0 flex-[1_1_280px] text-xs text-fg-3">
					{running
						? "转到后台后，可在服务器详情中继续查看部署进度"
						: job?.state === "done"
							? "部署完成。下一步确认需要同步的配置。"
							: job && job.state !== "running"
								? "可调整选项后重新部署"
								: "部署通常需要 1–3 分钟，取决于上传带宽"}
				</span>
				{running && (
					<>
						<ButtonLink to={paths.server(c.id)}>转到后台</ButtonLink>
						<Button variant="warning" icon={<CircleStop size={12} strokeWidth={2.2} />} loading={cancelling} onClick={onCancel}>
							取消部署
						</Button>
					</>
				)}
				{job && (job.state === "error" || job.state === "cancelled") && retryAction}
				{job?.state === "done" && (
					<Button variant="primary" onClick={onNext}>
						下一步
					</Button>
				)}
			</div>
		</div>
	);
}
