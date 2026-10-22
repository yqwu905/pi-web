import type { ServerView } from "@pi-web/shared";
import { ArrowLeft, Folder, Plug, RefreshCw, Server, Shield, Timer, TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useBlocker, useLocation, useParams } from "react-router";
import { errorMessage, runSync, updateServer } from "../../api/client";
import { invalidateSync } from "../../api/hooks";
import { toast } from "../../components/ui";
import { Button, ButtonLink } from "../../components/ui/Button";
import { Badge, EmptyState } from "../../components/ui/Display";
import { Modal } from "../../components/ui/Modal";
import { LoadingBlock } from "../../components/ui/Spinner";
import { cn } from "../../lib/cn";
import { paths } from "../../lib/routes";
import { serverStatusDisplay } from "../../lib/status";
import { useServers, useServersStore } from "../../stores/servers";
import { SectionNav, type SectionNavItem } from "./components/SettingsLayout";
import { useServerView } from "./hooks";
import { hasErrors, jumpChainLabel, serverTarget } from "./lib/connection-form";
import {
	affectsConnection,
	affectsSync,
	buildServerUpdate,
	dirtyCount,
	dirtyFields,
	dirtySections,
	formFromServer,
	type ServerSettingsForm,
	SECTION_FIELDS,
	type SettingsSection,
	validateServerSettings,
} from "./lib/server-settings-form";
import { ConnectionSection } from "./settings/ConnectionSection";
import { DeploySection } from "./settings/DeploySection";
import { ProxySection } from "./settings/ProxySection";
import { DangerSection, SessionSection } from "./settings/SessionDangerSections";
import { SyncSection } from "./settings/SyncSection";

const NAV: ReadonlyArray<{ id: SettingsSection; label: string; icon: ReactNode }> = [
	{ id: "conn", label: "连接", icon: <Plug /> },
	{ id: "deploy", label: "部署与目录", icon: <Folder /> },
	{ id: "proxy", label: "LLM 代理", icon: <Shield /> },
	{ id: "sync", label: "配置同步", icon: <RefreshCw /> },
	{ id: "session", label: "会话", icon: <Timer /> },
	{ id: "danger", label: "危险操作", icon: <TriangleAlert /> },
];

/** Route: /servers/:serverId/settings — 服务器设置. */
export default function ServerSettingsPage() {
	const { serverId = "" } = useParams();
	const { view, loading } = useServerView(serverId);
	if (loading) return <LoadingBlock className="flex-1" text="正在读取服务器…" />;
	if (!view)
		return (
			<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
				<EmptyState
					icon={<Server />}
					title="服务器不存在"
					description="该服务器可能已被删除。"
					actions={
						<ButtonLink to={paths.home()} variant="primary">
							返回首页
						</ButtonLink>
					}
				/>
			</div>
		);
	return <ServerSettings key={view.config.id} view={view} />;
}

function ServerSettings({ view }: { view: ServerView }) {
	const c = view.config;
	const location = useLocation();
	const servers = useServers({ includeJumpOnly: true });
	const [base, setBase] = useState<ServerSettingsForm>(() => formFromServer(c));
	const [form, setForm] = useState<ServerSettingsForm>(base);
	const [savedAt, setSavedAt] = useState(c.updatedAt);
	const [saving, setSaving] = useState(false);
	const [showErrors, setShowErrors] = useState(false);
	const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);

	const fields = useMemo(() => dirtyFields(base, form), [base, form]);
	const dirty = useMemo(() => new Set(fields), [fields]);
	const count = useMemo(() => dirtyCount(base, form), [base, form]);
	const sections = useMemo(() => dirtySections(fields), [fields]);
	const errors = useMemo(() => validateServerSettings(form, base, { hasSecret: Boolean(c.auth.hasSecret) }), [form, base, c.auth.hasSecret]);
	const isDirty = count > 0;

	// Adopt config changes made elsewhere (e.g. "加入白名单") while nothing is being edited.
	useEffect(() => {
		if (c.updatedAt === savedAt || isDirty) return;
		const next = formFromServer(c);
		setBase(next);
		setForm(next);
		setSavedAt(c.updatedAt);
	}, [c, savedAt, isDirty]);

	// Deep links such as #sec-session.
	useEffect(() => {
		if (!location.hash || !scrollRoot) return;
		document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
	}, [location.hash, scrollRoot]);

	useEffect(() => {
		if (!isDirty) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [isDirty]);

	const blocker = useBlocker(({ currentLocation, nextLocation }) => isDirty && !saving && currentLocation.pathname !== nextLocation.pathname);

	const set = useCallback((patch: Partial<ServerSettingsForm>) => setForm((f) => ({ ...f, ...patch })), []);
	const discard = () => {
		setForm(base);
		setShowErrors(false);
	};

	const save = async () => {
		if (!isDirty) return;
		if (hasErrors(errors)) {
			setShowErrors(true);
			const field = Object.keys(errors).find((k) => errors[k as keyof typeof errors]);
			const section = (Object.entries(SECTION_FIELDS) as Array<[SettingsSection, readonly string[]]>).find(([, list]) => field && list.includes(field))?.[0];
			if (section) document.getElementById(`sec-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
			toast.error("请先修正标红的字段", { title: "无法保存" });
			return;
		}
		setSaving(true);
		try {
			const request = buildServerUpdate(base, form);
			const updated = await updateServer(c.id, request);
			useServersStore.getState().upsertServer(updated);
			const next = formFromServer(updated.config);
			setBase(next);
			setForm(next);
			setSavedAt(updated.config.updatedAt);
			setShowErrors(false);
			toast.success(`已保存 ${updated.config.name} 的设置`);
			if (affectsConnection(fields) && updated.status.connection === "connected") {
				// The server re-opens the session itself when the saved connection settings (or the
				// stored secret) changed; pi processes live in the remote daemon and keep running.
				toast.info("正在使用新的连接参数重新连接…");
			}
			if (affectsSync(fields) && updated.status.connection === "connected" && !updated.config.jumpOnly) {
				runSync({ serverIds: [c.id] })
					.then(() => invalidateSync())
					.catch((e: unknown) => toast.error(errorMessage(e), { title: "同步失败" }));
			}
		} catch (e) {
			toast.error(errorMessage(e), { title: "保存失败" });
		} finally {
			setSaving(false);
		}
	};

	const status = serverStatusDisplay(view);
	const jumpLabel = jumpChainLabel(c.jumpServerIds, servers);
	const d = c.deployed;
	const subtitle = [serverTarget(c), jumpLabel && `经 ${jumpLabel}`, d && `Linux ${d.arch}${d.glibc ? ` · glibc ${d.glibc}` : ""}`].filter(Boolean).join(" · ");
	const navItems: SectionNavItem[] = NAV.filter((n) => !c.jumpOnly || n.id === "conn" || n.id === "danger").map((n) => ({
		id: `sec-${n.id}`,
		label: n.label,
		icon: n.icon,
		dirty: sections.has(n.id),
		danger: n.id === "danger",
	}));
	const sectionProps = { view, form, base, set, errors: showErrors ? errors : {}, dirty };
	const online = view.status.connection === "connected";

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3.5 sm:px-6">
				<div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2.5">
						<h1 className="m-0 text-[18px] font-semibold">服务器设置</h1>
						<Badge shape="pill" dot tone={status.tone}>
							{c.name} · {status.text}
						</Badge>
					</div>
					<code className="text-xs break-all text-fg-2">{subtitle}</code>
				</div>
				<ButtonLink to={paths.server(c.id)} variant="outline" icon={<ArrowLeft size={14} strokeWidth={1.8} />}>
					服务器概览
				</ButtonLink>
			</div>
			<div className="flex min-h-0 flex-1">
				<SectionNav
					items={navItems}
					scrollRoot={scrollRoot}
					className="hidden w-[200px] shrink-0 overflow-y-auto border-r border-border px-3 py-4 md:flex"
				/>
				<div ref={setScrollRoot} className="relative min-w-0 flex-1 overflow-y-auto px-4 pt-5 pb-8 sm:px-6">
					<form className="flex max-w-[880px] flex-col gap-4" noValidate aria-label="服务器设置" onSubmit={(e) => e.preventDefault()}>
						<ConnectionSection {...sectionProps} />
						{!c.jumpOnly && (
							<>
								<DeploySection {...sectionProps} />
								<ProxySection {...sectionProps} />
								<SyncSection {...sectionProps} />
								<SessionSection {...sectionProps} />
							</>
						)}
						<DangerSection view={view} />
					</form>
				</div>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-panel px-4 py-2.5 sm:px-6">
				<span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", isDirty ? "bg-warning" : "bg-success")} />
				<span role="status" className="text-sm font-medium text-fg">
					{isDirty ? `有 ${count} 项未保存的更改` : "所有更改已保存"}
				</span>
				<span className="min-w-0 flex-[1_1_240px] text-xs leading-[18px] text-fg-3">
					{isDirty
						? showErrors && hasErrors(errors)
							? "请先修正标红的字段。"
							: `保存后立即同步到 ${c.name}；运行中的对话需重启会话才会生效。`
						: online
							? `配置已同步到 ${c.name}。`
							: `${c.name} 当前离线，保存的设置将在连接后生效。`}
				</span>
				<div className="flex items-center gap-2">
					<Button disabled={!isDirty || saving} onClick={discard}>
						放弃
					</Button>
					<Button variant={isDirty ? "primary" : "secondary"} disabled={!isDirty} loading={saving} onClick={() => void save()}>
						保存更改
					</Button>
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
					<p className="m-0 text-sm text-fg-2">{`${c.name} 的设置有 ${count} 项更改尚未保存，离开后将丢失。`}</p>
				</Modal>
			)}
		</div>
	);
}
