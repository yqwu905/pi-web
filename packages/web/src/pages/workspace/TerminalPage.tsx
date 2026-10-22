import "@xterm/xterm/css/xterm.css";
import type { ServerView, WorkspaceConfig } from "@pi-web/shared";
import { ChevronDown, Eraser, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../../components/ui/Button";
import { EmptyState, StatusDot } from "../../components/ui/Display";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import type { Tone } from "../../lib/status";
import { DEFAULT_TERMINAL_FONT_SIZE, TERMINAL_FONT_SIZES, TERMINAL_STATUS_TEXT, type TerminalStatus } from "./lib/terminal";
import { useWorkspacePrefs } from "./prefs";
import { closeTerminal, getTerminalSession, openTerminal, setActiveTerminal, setTerminalsFontSize, type TerminalTab, useTerminalStore } from "./terminal-sessions";
import { WorkspaceGate } from "./WorkspaceGate";

const STATUS_TONE: Record<TerminalStatus, Tone> = {
	connecting: "accent",
	connected: "success",
	exited: "neutral",
	closed: "warning",
	error: "danger",
};
const STATUS_TEXT_CLASS: Record<TerminalStatus, string> = {
	connecting: "text-link",
	connected: "text-success-fg",
	exited: "text-fg-3",
	closed: "text-warning-fg",
	error: "text-danger",
};

/** Workspaces whose first terminal was opened automatically during this page load. */
const autoOpened = new Set<string>();

const TOOL_BUTTON =
	"inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 text-xs whitespace-nowrap text-fg transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50";

/** Hosts one session's xterm element; hidden (not unmounted) while another tab is active. */
function TerminalHost({ tab, active, panelId }: { tab: TerminalTab; active: boolean; panelId: string }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const session = getTerminalSession(tab.id);
		const host = ref.current;
		if (!session || !host) return;
		session.attach(host);
		const observer = new ResizeObserver(() => session.fit());
		observer.observe(host);
		return () => {
			observer.disconnect();
			session.detach();
		};
	}, [tab.id]);
	useEffect(() => {
		if (!active) return;
		const frame = requestAnimationFrame(() => {
			const session = getTerminalSession(tab.id);
			session?.fit();
			session?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [active, tab.id]);
	return (
		<section
			id={panelId}
			aria-label={`终端输出 ${tab.label}`}
			className={cn("absolute inset-0 overflow-hidden bg-code px-4 py-3.5", !active && "hidden")}
		>
			<div ref={ref} className="h-full w-full" />
		</section>
	);
}

function TerminalView({ workspace, server }: { workspace: WorkspaceConfig; server: ServerView }) {
	const wsId = workspace.id;
	const tabs = useTerminalStore(useShallow((s) => s.tabs.filter((t) => t.workspaceId === wsId)));
	const activeId = useTerminalStore((s) => s.active[wsId]);
	const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
	const fontSize = useWorkspacePrefs((s) => s.terminalFontSize);
	const setPrefs = useWorkspacePrefs((s) => s.set);
	const fontId = useId();
	const panelPrefix = useId();
	const fontSizes = useMemo(
		() => ((TERMINAL_FONT_SIZES as readonly number[]).includes(fontSize) ? TERMINAL_FONT_SIZES : [...TERMINAL_FONT_SIZES, fontSize].sort((a, b) => a - b)),
		[fontSize],
	);

	const open = (cwd: string) => openTerminal({ workspaceId: wsId, serverId: server.config.id, cwd, fontSize });

	// Open the first terminal automatically on the first visit of this workspace.
	useEffect(() => {
		if (autoOpened.has(wsId)) return;
		autoOpened.add(wsId);
		if (!useTerminalStore.getState().tabs.some((t) => t.workspaceId === wsId)) {
			openTerminal({ workspaceId: wsId, serverId: server.config.id, cwd: workspace.path, fontSize: useWorkspacePrefs.getState().terminalFontSize });
		}
	}, [wsId, server.config.id, workspace.path]);

	useEffect(() => setTerminalsFontSize(fontSize), [fontSize]);

	const session = active ? getTerminalSession(active.id) : undefined;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-9 shrink-0 flex-wrap items-stretch bg-panel">
				<div role="group" aria-label="终端标签页" className="flex min-w-0 flex-wrap items-stretch">
					{tabs.map((t) => {
						const on = t.id === active?.id;
						return (
							<div
								key={t.id}
								className={cn("flex h-9 items-center gap-1.5 border-r border-border pr-1.5 pl-3", on ? "bg-code" : "bg-transparent")}
							>
								<button
									type="button"
									aria-current={on ? "true" : undefined}
									aria-controls={`${panelPrefix}-${t.id}`}
									title={t.title ? `${t.title}\n${t.cwd}` : t.cwd}
									onClick={() => setActiveTerminal(wsId, t.id)}
									className={cn(
										"flex h-7 items-center gap-2 border-0 bg-transparent p-0 font-mono text-xs",
										on ? "font-medium text-fg" : "text-fg-2 hover:text-fg",
									)}
								>
									<SquareTerminal size={13} strokeWidth={1.9} aria-hidden="true" className={on ? "text-accent" : undefined} />
									{t.label}
									{t.status !== "connected" && (
										<StatusDot tone={STATUS_TONE[t.status]} pulse={t.status === "connecting"} size={6} srLabel={TERMINAL_STATUS_TEXT[t.status]} />
									)}
								</button>
								<IconButton aria-label={`关闭终端 ${t.label}`} size="xs" variant="ghost" onClick={() => closeTerminal(t.id)}>
									<X size={12} strokeWidth={2} />
								</IconButton>
							</div>
						);
					})}
					<div className="flex items-center gap-0.5 px-1.5">
						<IconButton aria-label="新建终端" size="md" variant="ghost" title="在工作区目录新建终端" onClick={() => open(workspace.path)}>
							<Plus size={14} strokeWidth={2} />
						</IconButton>
						<Menu
							aria-label="新建终端位置"
							align="start"
							items={[
								{ label: "在工作区目录新建终端", hint: workspace.alias, onSelect: () => open(workspace.path) },
								{ label: "在主目录新建终端", hint: "~", onSelect: () => open("~") },
							]}
							trigger={(props) => (
								<IconButton {...props} aria-label="选择新终端的目录" size="xs" variant="subtle">
									<ChevronDown size={12} strokeWidth={2.2} />
								</IconButton>
							)}
						/>
					</div>
				</div>
				<div className="flex-1" />
				<div className="flex flex-wrap items-center gap-2 px-3 py-1">
					<span className="text-xs text-fg-3">每个标签页是一条 SSH shell 通道</span>
					<span aria-hidden="true" className="h-4 w-px bg-border" />
					<div className="flex items-center gap-1.5">
						<label htmlFor={fontId} className="text-xs text-fg-2">
							字号
						</label>
						<select
							id={fontId}
							value={fontSize}
							onChange={(e) => setPrefs({ terminalFontSize: Number(e.target.value) || DEFAULT_TERMINAL_FONT_SIZE })}
							className="h-[26px] rounded-md border border-border bg-raised px-1.5 font-mono text-xs text-fg outline-none [color-scheme:dark] focus:border-accent"
						>
							{fontSizes.map((n) => (
								<option key={n} value={n}>
									{n}px
								</option>
							))}
						</select>
					</div>
					<button type="button" className={TOOL_BUTTON} disabled={!session} onClick={() => session?.clear()}>
						<Eraser size={12} strokeWidth={2} className="text-fg-2" aria-hidden="true" />
						清屏
					</button>
					<button
						type="button"
						className={TOOL_BUTTON}
						disabled={!session}
						onClick={() => {
							session?.connect();
							session?.focus();
						}}
					>
						<RefreshCw size={12} strokeWidth={2} className="text-fg-2" aria-hidden="true" />
						重新连接
					</button>
				</div>
			</div>
			<div className="relative min-h-0 flex-1 bg-code">
				{tabs.map((t) => (
					<TerminalHost key={t.id} tab={t} active={t.id === active?.id} panelId={`${panelPrefix}-${t.id}`} />
				))}
				{tabs.length === 0 && (
					<EmptyState
						icon={<SquareTerminal />}
						title="没有打开的终端"
						description="终端通过 SSH shell 通道连接到服务器，并以工作区目录为起点。"
						actions={
							<Button variant="primary" icon={<Plus size={14} />} onClick={() => open(workspace.path)}>
								新建终端
							</Button>
						}
					/>
				)}
			</div>
			<div className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-panel px-3 text-xs text-fg-2">
				{active ? (
					<>
						<span className="flex items-center gap-1.5" role="status">
							<StatusDot tone={STATUS_TONE[active.status]} pulse={active.status === "connecting"} />
							<span className={STATUS_TEXT_CLASS[active.status]} title={active.error}>
								{TERMINAL_STATUS_TEXT[active.status]}
								{active.status === "exited" && active.exitCode !== undefined && active.exitCode !== null ? `（退出码 ${active.exitCode}）` : ""}
								{active.status === "error" && active.error ? `：${active.error}` : ""}
							</span>
						</span>
						<span>{server.config.name}</span>
						<span className="font-mono">{active.cwd}</span>
						{active.cols > 0 && (
							<span className="font-mono">
								{active.cols}×{active.rows}
							</span>
						)}
						<span>UTF-8</span>
					</>
				) : (
					<span>{server.config.name}</span>
				)}
				<span className="flex-1" />
				<span className="text-fg-3">关闭页面后终端会话结束</span>
			</div>
		</div>
	);
}

/** Route: /w/:workspaceId/terminal — xterm.js terminals over SSH shell channels (/ws/term). */
export default function TerminalPage() {
	return (
		<WorkspaceGate title="Web 终端">
			{({ workspace, server }) => <TerminalView key={workspace.id} workspace={workspace} server={server} />}
		</WorkspaceGate>
	);
}
