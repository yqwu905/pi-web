import type { HostSettings } from "@pi-web/shared";
import { useMutation } from "@tanstack/react-query";
import { Box, Cpu, Database, Globe, Info, Lock, TriangleAlert, Upload } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useBlocker, useLocation } from "react-router";
import { errorMessage, importNodeArchive, rotateAccessToken, updateSettings } from "../../api/client";
import { useMeta, useSettings } from "../../api/hooks";
import { queryClient, queryKeys } from "../../api/queryClient";
import { toast } from "../../components/ui";
import { Button } from "../../components/ui/Button";
import { copyText } from "../../components/CodeBlock";
import { Checkbox } from "../../components/ui/Choice";
import { Callout } from "../../components/ui/Display";
import { Input } from "../../components/ui/Input";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { LoadingBlock } from "../../components/ui/Spinner";
import { cn } from "../../lib/cn";
import { Hint, SectionNav, type SectionNavItem, SettingRow, SettingsSection } from "../servers/components/SettingsLayout";
import { AboutSection, CacheSection, useCacheQuery } from "./CacheAboutSections";
import {
	buildSettingsPatch,
	compareVersions,
	DEFAULT_NPM_REGISTRY,
	defaultForm,
	formFromSettings,
	isLoopback,
	LATEST_NODE,
	MIN_NODE_VERSION,
	needsRestart,
	nodeVersionOptions,
	type SettingsForm,
	type SettingsFormErrors,
	type SettingsFormField,
	validateSettingsForm,
} from "./lib/settings-form";

const LABEL_WIDTH = 168;
const CUSTOM = "__custom";
const NODE_TARBALL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.tar\.(xz|gz)$/;

const SECTIONS: ReadonlyArray<{ id: string; label: string; icon: ReactNode; fields: SettingsFormField[] }> = [
	{ id: "set-runtime", label: "运行时", icon: <Cpu />, fields: ["nodeSource", "nodeCustomBaseUrl", "nodeVersion", "archX64", "archArm64"] },
	{ id: "set-pi", label: "pi", icon: <Box />, fields: ["piVersionPolicy", "piPinnedVersion", "npmRegistry", "prunePrebuilds", "hostAgentDir"] },
	{ id: "set-network", label: "网络", icon: <Globe />, fields: ["upstreamProxy", "portFrom", "portTo", "defaultNoProxyText"] },
	{ id: "set-access", label: "访问控制", icon: <Lock />, fields: ["listenHost", "listenPort", "accessTokenEnabled"] },
	{ id: "set-cache", label: "缓存", icon: <Database />, fields: [] },
	{ id: "set-about", label: "关于", icon: <Info />, fields: [] },
];

interface SectionProps {
	form: SettingsForm;
	set: (patch: Partial<SettingsForm>) => void;
	errors: SettingsFormErrors;
	dirty: ReadonlySet<SettingsFormField>;
}

function FieldError({ error }: { error?: string }) {
	return error ? <Hint tone="danger">{error}</Hint> : null;
}

function NodeImport() {
	const inputRef = useRef<HTMLInputElement>(null);
	const importer = useMutation({
		mutationFn: (file: File) => importNodeArchive(file, file.name),
		onSuccess: (entry) => {
			toast.success(`已导入 Node.js ${entry.version}${entry.arch ? ` · linux-${entry.arch}` : ""}`);
			void queryClient.invalidateQueries({ queryKey: queryKeys.cache });
		},
		onError: (e) => toast.error(errorMessage(e), { title: "导入失败" }),
	});
	return (
		<div className="flex min-h-8 flex-wrap items-center gap-2">
			<span className="w-[136px] pl-6 text-sm text-fg-2">从本地文件导入</span>
			<input
				ref={inputRef}
				type="file"
				accept=".xz,.gz,application/x-xz,application/gzip"
				className="hidden"
				tabIndex={-1}
				aria-hidden="true"
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (!file) return;
					if (!NODE_TARBALL.test(file.name)) {
						toast.error("请选择 Node.js 官方发行包，例如 node-v22.20.0-linux-x64.tar.xz", { title: "文件名不符合要求" });
						return;
					}
					importer.mutate(file);
				}}
			/>
			<Button size="sm" icon={<Upload size={13} strokeWidth={1.8} />} loading={importer.isPending} onClick={() => inputRef.current?.click()}>
				{importer.isPending ? "正在上传…" : "选择 tar.xz…"}
			</Button>
			<Hint>导入后作为离线包缓存，适用于 Host 也无法访问下载源的情况。</Hint>
		</div>
	);
}

function RuntimeSection({ form, set, errors, dirty }: SectionProps) {
	const ids = { src: useId(), url: useId(), ver: useId(), verInput: useId(), arch: useId() };
	const cache = useCacheQuery();
	const cachedNode = useMemo(() => (cache.data?.entries ?? []).filter((e) => e.kind === "node").map((e) => e.version.replace(/^v/, "")), [cache.data]);
	const options = nodeVersionOptions(form.nodeVersion, cachedNode);
	const [custom, setCustom] = useState(false);
	// "恢复默认" (or picking latest) leaves the free-form input.
	useEffect(() => {
		if (form.nodeVersion === LATEST_NODE) setCustom(false);
	}, [form.nodeVersion]);
	const selectValue = custom ? CUSTOM : form.nodeVersion.trim().replace(/^v/, "");
	const sources: Array<{ value: HostSettings["nodeSource"]; label: string; host: string }> = [
		{ value: "official", label: "官方", host: "nodejs.org" },
		{ value: "npmmirror", label: "镜像", host: "npmmirror.com" },
	];
	return (
		<SettingsSection id="set-runtime" plainHeader title="运行时" description="部署到服务器的 Node.js。下载后统一转成 tar.gz，缓存在 Host。">
			<SettingRow label="Node.js 下载源" labelId={ids.src} labelWidth={LABEL_WIDTH} dirty={dirty.has("nodeSource") || dirty.has("nodeCustomBaseUrl")}>
				<div role="radiogroup" aria-labelledby={ids.src} className="flex flex-col gap-1">
					{sources.map((s) => (
						<label key={s.value} className={cn("flex min-h-8 cursor-pointer items-center gap-2 text-sm", form.nodeSource === s.value ? "text-fg" : "text-fg-2")}>
							<input type="radio" name={ids.src} checked={form.nodeSource === s.value} onChange={() => set({ nodeSource: s.value })} className="m-0 size-4 accent-primary" />
							<span className="w-28">{s.label}</span>
							<code className={cn("text-mono", form.nodeSource === s.value ? "text-fg-code" : "text-fg-2")}>{s.host}</code>
						</label>
					))}
					<div className="flex min-h-8 flex-wrap items-center gap-2">
						<label className={cn("flex cursor-pointer items-center gap-2 text-sm", form.nodeSource === "custom" ? "text-fg" : "text-fg-2")}>
							<input type="radio" name={ids.src} checked={form.nodeSource === "custom"} onChange={() => set({ nodeSource: "custom" })} className="m-0 size-4 accent-primary" />
							<span className="w-28">自定义 URL</span>
						</label>
						<label htmlFor={ids.url} className="sr-only">
							自定义 Node.js 下载地址
						</label>
						<Input
							id={ids.url}
							mono
							placeholder="https://mirror.internal/nodejs/dist/"
							disabled={form.nodeSource !== "custom"}
							value={form.nodeCustomBaseUrl}
							invalid={Boolean(errors.nodeCustomBaseUrl)}
							className="max-w-[340px] min-w-0 flex-[1_1_220px]"
							onChange={(e) => set({ nodeCustomBaseUrl: e.target.value })}
						/>
					</div>
					<NodeImport />
				</div>
				<FieldError error={errors.nodeCustomBaseUrl} />
			</SettingRow>
			<SettingRow label="Node 版本" htmlFor={ids.ver} labelWidth={LABEL_WIDTH} dirty={dirty.has("nodeVersion")}>
				<div className="flex flex-wrap items-center gap-2">
					<Select
						id={ids.ver}
						wrapperClassName="max-w-[280px]"
						value={selectValue}
						invalid={Boolean(errors.nodeVersion) && !custom}
						onChange={(e) => {
							if (e.target.value === CUSTOM) {
								setCustom(true);
								set({ nodeVersion: "" });
								return;
							}
							setCustom(false);
							set({ nodeVersion: e.target.value });
						}}
					>
						{options.map((v) => (
							<option key={v} value={v}>
								{v === LATEST_NODE
									? "最新 22.x（自动选择 ≥ 22.19）"
									: `${v}${compareVersions(v, MIN_NODE_VERSION) >= 0 ? "（满足 pi ≥ 22.19）" : "（低于 pi 要求）"}`}
							</option>
						))}
						<option value={CUSTOM}>指定其他版本…</option>
					</Select>
					{custom && (
						<>
							<label htmlFor={ids.verInput} className="sr-only">
								Node 版本号
							</label>
							<Input
								id={ids.verInput}
								mono
								autoFocus
								placeholder="22.21.0"
								className="max-w-32"
								value={form.nodeVersion}
								invalid={Boolean(errors.nodeVersion)}
								onChange={(e) => set({ nodeVersion: e.target.value })}
							/>
						</>
					)}
				</div>
				{errors.nodeVersion ? <Hint tone="danger">{errors.nodeVersion}</Hint> : <Hint>各版本在服务器上按目录并存，已部署的服务器在下次升级时切换。</Hint>}
			</SettingRow>
			<SettingRow label="目标平台" labelId={ids.arch} labelWidth={LABEL_WIDTH} align="text" dirty={dirty.has("archX64") || dirty.has("archArm64")}>
				<div role="group" aria-labelledby={ids.arch} className="flex flex-wrap gap-x-6 gap-y-2">
					<Checkbox checked={form.archX64} onChange={(archX64) => set({ archX64 })} label={<code className="text-mono">linux-x64</code>} />
					<Checkbox checked={form.archArm64} onChange={(archArm64) => set({ archArm64 })} label={<code className="text-mono">linux-arm64</code>} />
				</div>
				{errors.archX64 ? <Hint tone="danger">{errors.archX64}</Hint> : <Hint>预先缓存这些平台的离线包。服务器要求 glibc ≥ 2.28。</Hint>}
			</SettingRow>
		</SettingsSection>
	);
}

function PiSection({ form, set, errors, dirty }: SectionProps) {
	const meta = useMeta();
	const ids = { policy: useId(), pinned: useId(), registry: useId(), agentDir: useId() };
	return (
		<SettingsSection
			id="set-pi"
			plainHeader
			title="pi"
			description={
				<>
					包名 <code className="text-xs text-fg-2">@earendil-works/pi-coding-agent</code>
				</>
			}
		>
			<SettingRow label="版本策略" labelId={ids.policy} labelWidth={LABEL_WIDTH} dirty={dirty.has("piVersionPolicy") || dirty.has("piPinnedVersion")}>
				<div role="radiogroup" aria-labelledby={ids.policy} className="flex flex-col gap-1">
					<label className={cn("flex min-h-8 cursor-pointer items-center gap-2 text-sm", form.piVersionPolicy === "host" ? "text-fg" : "text-fg-2")}>
						<input type="radio" name={ids.policy} checked={form.piVersionPolicy === "host"} onChange={() => set({ piVersionPolicy: "host" })} className="m-0 size-4 accent-primary" />
						跟随 Host 已安装版本{meta.data ? `（当前 ${meta.data.hostPiVersion ?? "未安装"}）` : ""}
					</label>
					<div className="flex min-h-8 flex-wrap items-center gap-2">
						<label className={cn("flex cursor-pointer items-center gap-2 text-sm", form.piVersionPolicy === "pinned" ? "text-fg" : "text-fg-2")}>
							<input
								type="radio"
								name={ids.policy}
								checked={form.piVersionPolicy === "pinned"}
								onChange={() => set({ piVersionPolicy: "pinned" })}
								className="m-0 size-4 accent-primary"
							/>
							<span className="w-28">指定版本</span>
						</label>
						<label htmlFor={ids.pinned} className="sr-only">
							指定 pi 版本
						</label>
						<Input
							id={ids.pinned}
							mono
							placeholder={meta.data?.hostPiVersion ?? "1.4.0"}
							className="max-w-[120px]"
							disabled={form.piVersionPolicy !== "pinned"}
							value={form.piPinnedVersion}
							invalid={Boolean(errors.piPinnedVersion)}
							onChange={(e) => set({ piPinnedVersion: e.target.value })}
						/>
					</div>
				</div>
				{errors.piPinnedVersion ? <Hint tone="danger">{errors.piPinnedVersion}</Hint> : <Hint>pi 按版本目录并存，升级或回滚只切换 current 软链接。</Hint>}
			</SettingRow>
			<SettingRow label="npm registry" htmlFor={ids.registry} labelWidth={LABEL_WIDTH} dirty={dirty.has("npmRegistry")}>
				<Input
					id={ids.registry}
					mono
					placeholder={DEFAULT_NPM_REGISTRY}
					className="max-w-[420px]"
					value={form.npmRegistry}
					invalid={Boolean(errors.npmRegistry)}
					onChange={(e) => set({ npmRegistry: e.target.value })}
				/>
				{errors.npmRegistry ? <Hint tone="danger">{errors.npmRegistry}</Hint> : <Hint>Host 在缓存目录执行 npm install 时使用；留空使用 {DEFAULT_NPM_REGISTRY}。</Hint>}
			</SettingRow>
			<SettingRow label="打包" labelWidth={LABEL_WIDTH} align="text" dirty={dirty.has("prunePrebuilds")}>
				<Checkbox checked={form.prunePrebuilds} onChange={(prunePrebuilds) => set({ prunePrebuilds })} label="打包时移除 darwin/win32 预编译文件" />
				<Hint>pi-tui 自带 linux-x64/arm64 预编译，与 Host 平台无关。</Hint>
			</SettingRow>
			<SettingRow label="Host agent 目录" htmlFor={ids.agentDir} labelWidth={LABEL_WIDTH} dirty={dirty.has("hostAgentDir")}>
				<Input
					id={ids.agentDir}
					mono
					placeholder={meta.data?.hostAgentDir ?? "~/.pi/agent"}
					className="max-w-[420px]"
					value={form.hostAgentDir}
					invalid={Boolean(errors.hostAgentDir)}
					onChange={(e) => set({ hostAgentDir: e.target.value })}
				/>
				{errors.hostAgentDir ? (
					<Hint tone="danger">{errors.hostAgentDir}</Hint>
				) : (
					<Hint>同步与 OAuth 托管读取的 Host pi 配置目录；留空使用 $PI_CODING_AGENT_DIR 或 ~/.pi/agent。</Hint>
				)}
			</SettingRow>
		</SettingsSection>
	);
}

function NetworkSection({ form, set, errors, dirty }: SectionProps) {
	const ids = { upstream: useId(), range: useId(), from: useId(), to: useId(), noProxy: useId() };
	return (
		<SettingsSection id="set-network" plainHeader title="网络" description="服务器上的 LLM 请求经 SSH Link 回到 Host 的 TunnelProxy 再发出。">
			<SettingRow label="Host 上游代理" htmlFor={ids.upstream} labelWidth={LABEL_WIDTH} dirty={dirty.has("upstreamProxy")}>
				<Input
					id={ids.upstream}
					mono
					placeholder="http://proxy.corp.local:3128"
					className="max-w-[420px]"
					value={form.upstreamProxy}
					invalid={Boolean(errors.upstreamProxy)}
					onChange={(e) => set({ upstreamProxy: e.target.value })}
				/>
				{errors.upstreamProxy ? (
					<Hint tone="danger">{errors.upstreamProxy}</Hint>
				) : (
					<Hint>隧道代理的出站连接会经过此代理。留空则遵循 Host 的 HTTPS_PROXY 环境变量，未设置时直连上游。</Hint>
				)}
			</SettingRow>
			<SettingRow label="新服务器的代理端口范围" labelId={ids.range} labelWidth={LABEL_WIDTH} dirty={dirty.has("portFrom") || dirty.has("portTo")}>
				<div role="group" aria-labelledby={ids.range} className="flex items-center gap-2">
					<label htmlFor={ids.from} className="sr-only">
						起始端口
					</label>
					<Input id={ids.from} mono inputMode="numeric" className="max-w-24" value={form.portFrom} invalid={Boolean(errors.portFrom)} onChange={(e) => set({ portFrom: e.target.value })} />
					<span aria-hidden="true" className="text-fg-3">
						–
					</span>
					<label htmlFor={ids.to} className="sr-only">
						结束端口
					</label>
					<Input id={ids.to} mono inputMode="numeric" className="max-w-24" value={form.portTo} invalid={Boolean(errors.portTo)} onChange={(e) => set({ portTo: e.target.value })} />
				</div>
				{errors.portFrom || errors.portTo ? (
					<Hint tone="danger">{errors.portFrom ?? errors.portTo}</Hint>
				) : (
					<Hint>添加服务器时从中分配一个固定端口，SSH 重连后不变；已有服务器的端口在服务器设置中修改。</Hint>
				)}
			</SettingRow>
			<SettingRow label="默认 NO_PROXY" htmlFor={ids.noProxy} labelWidth={LABEL_WIDTH} dirty={dirty.has("defaultNoProxyText")}>
				<Input id={ids.noProxy} mono className="max-w-[420px]" value={form.defaultNoProxyText} onChange={(e) => set({ defaultNoProxyText: e.target.value })} />
				<Hint>以逗号分隔。内网地址（如 vLLM）在各服务器的设置中按服务器追加。</Hint>
			</SettingRow>
		</SettingsSection>
	);
}

function AccessSection({ form, set, errors, dirty }: SectionProps) {
	const ids = { host: useId(), port: useId(), token: useId() };
	const exposed = form.listenHost.trim() !== "" && !isLoopback(form.listenHost);
	return (
		<SettingsSection id="set-access" plainHeader title="访问控制" description="Pi-Web 界面与接口。所有接口都校验 Origin。">
			<SettingRow label="监听地址" htmlFor={ids.host} labelWidth={LABEL_WIDTH} dirty={dirty.has("listenHost")}>
				<Input id={ids.host} mono className="max-w-[200px]" value={form.listenHost} invalid={Boolean(errors.listenHost)} onChange={(e) => set({ listenHost: e.target.value })} />
				{errors.listenHost ? (
					<Hint tone="danger">{errors.listenHost}</Hint>
				) : exposed ? (
					<Hint tone="warning">监听非回环地址时，同一网络中的其他机器也能访问 Pi-Web，请务必启用访问令牌。</Hint>
				) : (
					<Hint>仅本机访问；单用户模式</Hint>
				)}
			</SettingRow>
			<SettingRow label="端口" htmlFor={ids.port} labelWidth={LABEL_WIDTH} dirty={dirty.has("listenPort")}>
				<Input id={ids.port} mono inputMode="numeric" className="max-w-24" value={form.listenPort} invalid={Boolean(errors.listenPort)} onChange={(e) => set({ listenPort: e.target.value })} />
				{errors.listenPort ? <Hint tone="danger">{errors.listenPort}</Hint> : <Hint>修改监听地址或端口后需重启 Pi-Web。</Hint>}
			</SettingRow>
			<SettingRow label="访问令牌" labelId={ids.token} labelWidth={LABEL_WIDTH} align="text" dirty={dirty.has("accessTokenEnabled")}>
				<div role="group" aria-labelledby={ids.token} className="flex flex-col gap-2">
					<Checkbox checked={form.accessTokenEnabled} onChange={(accessTokenEnabled) => set({ accessTokenEnabled })} label="启用访问令牌" />
					{exposed && !form.accessTokenEnabled && (
						<span className="flex items-center gap-1.5 text-xs text-warning-fg">
							<TriangleAlert size={12} aria-hidden="true" />
							当前监听地址对外可见，但未启用访问令牌
						</span>
					)}
				</div>
				<Hint>
					防止同一台机器上的其他用户访问 Pi-Web。令牌只保存在本页面所在源（含端口）的浏览器存储中，不使用 Cookie。启用后，当前浏览器保持登录；令牌保存在 Host
					数据目录中，启动 Pi-Web 时会打印带 ?token= 的访问链接。
				</Hint>
				{form.accessTokenEnabled && !dirty.has("accessTokenEnabled") && <RotateToken />}
			</SettingRow>
		</SettingsSection>
	);
}

/** Replaces the access token: other browsers must sign in again with the new one. */
function RotateToken() {
	const [token, setToken] = useState<string | null>(null);
	const rotate = useMutation({
		mutationFn: rotateAccessToken,
		onSuccess: (result) => {
			setToken(result.token);
			toast.success("已生成新令牌，其他浏览器需要使用新令牌重新登录");
		},
		onError: (e) => toast.error(errorMessage(e), { title: "无法更换令牌" }),
	});
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button size="sm" loading={rotate.isPending} onClick={() => rotate.mutate()}>
				更换令牌
			</Button>
			{token && (
				<span className="flex min-w-0 items-center gap-1.5">
					<code className="truncate font-mono text-xs text-fg">{token}</code>
					<Button size="sm" variant="ghost" onClick={() => void copyText(token).then((ok) => ok && toast.success("令牌已复制"))}>
						复制
					</Button>
				</span>
			)}
		</div>
	);
}

/** Route: /settings — 全局设置. */
export default function SettingsPage() {
	const settings = useSettings();
	if (settings.isLoading) return <LoadingBlock className="flex-1" text="正在读取设置…" />;
	if (settings.isError || !settings.data)
		return (
			<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
				<Callout tone="danger" title="无法读取设置" actions={<Button size="sm" onClick={() => void settings.refetch()}>重试</Button>}>
					{errorMessage(settings.error)}
				</Callout>
			</div>
		);
	return <SettingsEditor settings={settings.data} />;
}

function SettingsEditor({ settings }: { settings: HostSettings }) {
	const location = useLocation();
	const [base, setBase] = useState(() => formFromSettings(settings));
	const [form, setForm] = useState(base);
	const [showErrors, setShowErrors] = useState(false);
	const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
	const patch = useMemo(() => buildSettingsPatch(base, form), [base, form]);
	const changed = Object.keys(patch).length;
	const errors = useMemo(() => validateSettingsForm(form), [form]);
	const hasErrors = Object.keys(errors).length > 0;
	const dirty = useMemo(() => {
		const set = new Set<SettingsFormField>();
		for (const s of SECTIONS) for (const f of s.fields) if (JSON.stringify(form[f]) !== JSON.stringify(base[f])) set.add(f);
		return set;
	}, [base, form]);

	// Settings saved elsewhere (another tab) while nothing is being edited.
	useEffect(() => {
		if (changed > 0) return;
		const next = formFromSettings(settings);
		if (JSON.stringify(next) !== JSON.stringify(base)) {
			setBase(next);
			setForm(next);
		}
	}, [settings]);

	useEffect(() => {
		if (!location.hash || !scrollRoot) return;
		document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
	}, [location.hash, scrollRoot]);

	const save = useMutation({
		mutationFn: () => updateSettings(patch),
		onSuccess: (updated) => {
			queryClient.setQueryData(queryKeys.settings, updated);
			const next = formFromSettings(updated);
			setBase(next);
			setForm(next);
			setShowErrors(false);
			toast.success("全局设置已保存");
			if (needsRestart(patch)) toast.warning("监听地址或端口已修改，重启 Pi-Web 后生效");
			if (patch.accessTokenEnabled === true) toast.info("访问令牌已启用，当前浏览器保持登录");
		},
		onError: (e) => toast.error(errorMessage(e), { title: "保存失败" }),
	});

	const blocker = useBlocker(({ currentLocation, nextLocation }) => changed > 0 && !save.isPending && currentLocation.pathname !== nextLocation.pathname);
	// Reloading or closing the tab: useBlocker only covers in-app navigation.
	useEffect(() => {
		if (changed === 0) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [changed]);

	const set = (p: Partial<SettingsForm>) => setForm((f) => ({ ...f, ...p }));
	const sectionProps: SectionProps = { form, set, errors: showErrors ? errors : {}, dirty };
	const onSave = () => {
		if (hasErrors) {
			setShowErrors(true);
			const first = SECTIONS.find((s) => s.fields.some((f) => errors[f]));
			if (first) document.getElementById(first.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
			toast.error("请先修正标红的字段", { title: "无法保存" });
			return;
		}
		save.mutate();
	};
	const navItems: SectionNavItem[] = SECTIONS.map((s) => ({ id: s.id, label: s.label, icon: s.icon, dirty: s.fields.some((f) => dirty.has(f)) }));

	return (
		<div ref={setScrollRoot} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="mx-auto flex w-full max-w-[1064px] flex-col gap-5 px-4 pt-6 sm:px-6">
				<div className="flex flex-col gap-1.5">
					<h1 className="m-0 text-xl font-semibold">全局设置</h1>
					<p className="m-0 text-sm leading-[1.6] text-fg-2">作用于 Host 和所有服务器的默认值。单台服务器的代理、同步和 agent 目录在服务器设置中修改。</p>
				</div>
				<div className="flex flex-wrap items-start gap-6">
					<SectionNav items={navItems} scrollRoot={scrollRoot} title="分类" className="sticky top-4 hidden max-w-full flex-[1_1_200px] md:flex" />
					<div className="flex max-w-[820px] min-w-0 flex-[999_1_560px] flex-col gap-4">
						<RuntimeSection {...sectionProps} />
						<PiSection {...sectionProps} />
						<NetworkSection {...sectionProps} />
						<AccessSection {...sectionProps} />
						<CacheSection />
						<AboutSection />
						<div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-bg px-1 py-3">
							<span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", changed ? "bg-warning" : "bg-success")} />
							<span role="status" className="min-w-0 flex-1 text-sm text-fg-2">
								{changed ? (showErrors && hasErrors ? "请先修正标红的字段" : `有 ${changed} 项未保存的更改`) : "所有更改已保存"}
							</span>
							<Button
								variant="outline"
								size="lg"
								onClick={() => {
									setForm(defaultForm(form));
									toast.info("已恢复默认值，点击“保存”后生效");
								}}
							>
								恢复默认
							</Button>
							{changed > 0 && (
								<Button size="lg" onClick={() => setForm(base)} disabled={save.isPending}>
									放弃
								</Button>
							)}
							<Button variant="primary" size="lg" className="px-[18px]" disabled={!changed} loading={save.isPending} onClick={onSave}>
								保存
							</Button>
						</div>
					</div>
				</div>
			</div>
			{blocker.state === "blocked" && (
				<Modal
					open
					role="alertdialog"
					size="sm"
					icon={<TriangleAlert className="text-warning" />}
					title="有未保存的更改"
					onClose={() => blocker.reset()}
					footer={
						<>
							<Button onClick={() => blocker.reset()}>留在此页</Button>
							<Button variant="warning" onClick={() => blocker.proceed()}>
								放弃更改并离开
							</Button>
						</>
					}
				>
					<p className="m-0 text-sm text-fg-2">{`全局设置有 ${changed} 项更改尚未保存，离开后将丢失。`}</p>
				</Modal>
			)}
		</div>
	);
}
