import { KeyRound } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate, useNavigation } from "react-router";
import { useSessionsLiveSync } from "../api/archive";
import { errorMessage, isApiError, login } from "../api/client";
import { useMeta } from "../api/hooks";
import { Button } from "../components/ui/Button";
import { Field } from "../components/ui/Field";
import { Input } from "../components/ui/Input";
import { LoadingBlock } from "../components/ui/Spinner";
import { ToastViewport } from "../components/ui/ToastViewport";
import { cn } from "../lib/cn";
import { setAttentionNavigator } from "../stores/attention";
import { useConvsLiveSync } from "../stores/convs";
import { useServersLiveSync } from "../stores/servers";
import { useUiStore } from "../stores/ui";
import { Header, Logo } from "./Header";
import { Sidebar } from "./Sidebar";

/** Starts the app-wide live data (servers, conversations and session archive marks over WS). */
function LiveSync() {
	useServersLiveSync();
	useConvsLiveSync();
	useSessionsLiveSync();
	const navigate = useNavigate();
	useEffect(() => {
		setAttentionNavigator((path) => navigate(path));
		return () => setAttentionNavigator(null);
	}, [navigate]);
	return null;
}

function NavigationProgress() {
	const navigation = useNavigation();
	if (navigation.state === "idle") return null;
	return <div aria-hidden="true" className="fixed top-0 right-0 left-0 z-[70] h-0.5 animate-pulse-dot bg-accent" />;
}

function LoginScreen() {
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await login(token.trim());
			window.location.reload();
		} catch (err) {
			setError(isApiError(err) && err.status === 401 ? "访问令牌不正确" : errorMessage(err));
			setBusy(false);
		}
	};
	return (
		<div className="flex h-dvh items-center justify-center bg-bg p-4">
			<form onSubmit={submit} className="flex w-full max-w-[380px] flex-col gap-4 rounded-xl border border-border-strong bg-panel p-6 shadow-pop">
				<div className="flex items-center gap-2 text-[15px] font-bold text-fg">
					<Logo />
					Pi-Web
				</div>
				<div className="flex flex-col gap-1">
					<h1 className="m-0 text-lg font-semibold">需要访问令牌</h1>
					<p className="m-0 text-sm text-fg-2">此 Pi-Web 已开启访问令牌。请粘贴启动时输出的令牌，或直接打开带 ?token= 的链接。</p>
				</div>
				<Field label="访问令牌" error={error ?? undefined}>
					<Input mono type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
				</Field>
				<Button type="submit" variant="primary" icon={<KeyRound size={14} />} loading={busy} disabled={!token.trim()}>
					登录
				</Button>
			</form>
		</div>
	);
}

/**
 * Root layout: 48px header, 264px sidebar (drawer below the md breakpoint) and the routed page.
 * Also hosts the toast viewport and the app-wide live sync.
 */
export function AppShell() {
	const meta = useMeta();
	const location = useLocation();
	const sidebarOpen = useUiStore((s) => s.sidebarOpen);
	const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);

	useEffect(() => {
		setSidebarOpen(false);
	}, [location.pathname, setSidebarOpen]);

	useEffect(() => {
		if (!sidebarOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setSidebarOpen(false);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [sidebarOpen, setSidebarOpen]);

	const unauthorized = meta.data?.authenticated === false || (isApiError(meta.error) && meta.error.status === 401);
	if (unauthorized) return <LoginScreen />;
	if (meta.isLoading) return <LoadingBlock className="h-dvh" text="正在连接 Pi-Web…" />;

	return (
		<div className="flex h-dvh flex-col bg-bg text-fg">
			<LiveSync />
			<NavigationProgress />
			<Header />
			<div className="relative flex min-h-0 flex-1">
				<Sidebar className="hidden md:flex" />
				{sidebarOpen && (
					<div className="fixed inset-0 z-40 flex md:hidden">
						<div className="absolute inset-0 bg-overlay" aria-hidden="true" onClick={() => setSidebarOpen(false)} />
						<Sidebar className={cn("relative z-10 h-full max-w-[85vw] shadow-pop")} />
					</div>
				)}
				<main className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
					<Outlet />
				</main>
			</div>
			<ToastViewport />
		</div>
	);
}
