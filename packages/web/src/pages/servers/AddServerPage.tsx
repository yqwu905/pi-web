import { type ProbeResult, SYNC_ITEM_KEYS, type ServerView, type SyncItemKey, type TestConnectionResult, type UpdateServerRequest } from "@pi-web/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
	cancelDeploy,
	createServer,
	deployServer,
	errorMessage,
	probeServer,
	runSync,
	testConnection,
	testServer,
	trustHostKey,
	updateServer,
} from "../../api/client";
import { invalidateSync } from "../../api/hooks";
import { toast } from "../../components/ui";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Display";
import { LoadingBlock } from "../../components/ui/Spinner";
import { paths } from "../../lib/routes";
import { useServers, useServersStore } from "../../stores/servers";
import { ConnectionStep } from "./add/ConnectionStep";
import { type DeployOptions, DeployStep, toDeployRequest } from "./add/DeployStep";
import { HostKeyStep } from "./add/HostKeyStep";
import { ProbeStep } from "./add/ProbeStep";
import { StepNav } from "./add/StepNav";
import { SyncStep } from "./add/SyncStep";
import { serverQueryKeys, useDeployJob, useServerView } from "./hooks";
import {
	type ConnectionFormValues,
	connectionSignature,
	defaultServerName,
	emptyConnectionForm,
	formFromServerConfig,
	hasErrors,
	jumpChainLabel,
	parsePort,
	toConnectionUpdate,
	toCreateRequest,
	toTestRequest,
	validateConnectionForm,
} from "./lib/connection-form";
import { INITIAL_WIZARD, resumeWizard, wizardReducer } from "./lib/wizard";

interface ProbeState {
	result?: ProbeResult;
	error?: string;
	running: boolean;
	durationMs: number | null;
}

const IDLE_PROBE: ProbeState = { running: false, durationMs: null };

/**
 * Route: /servers/new[?server=<id>] — five-step wizard: 连接信息 → 主机验证 → 环境探测 →
 * 离线部署 → 同步配置. The server is created when leaving step 1; its id is kept in the URL
 * so a reload (or "转到后台" and back) resumes at the right step.
 */
export default function AddServerPage() {
	const [params, setParams] = useSearchParams();
	const serverId = params.get("server");
	const navigate = useNavigate();
	const client = useQueryClient();
	const servers = useServers({ includeJumpOnly: true });
	const { view, loading, notFound } = useServerView(serverId);
	const deployJob = useDeployJob(serverId);

	const [wizard, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD);
	const [form, setForm] = useState<ConnectionFormValues>(emptyConnectionForm);
	const [jumpOnly, setJumpOnly] = useState(false);
	const [showErrors, setShowErrors] = useState(false);
	const [test, setTest] = useState<{ signature: string; result: TestConnectionResult } | null>(null);
	const [testing, setTesting] = useState(false);
	const [stepError, setStepError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [savedSignature, setSavedSignature] = useState<string | null>(null);
	const [hostKeyError, setHostKeyError] = useState<string | null>(null);
	const [hostKeyBusy, setHostKeyBusy] = useState(false);
	const [probe, setProbe] = useState<ProbeState>(IDLE_PROBE);
	const [deployStarting, setDeployStarting] = useState(false);
	const [deployError, setDeployError] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState(false);
	const [finishing, setFinishing] = useState(false);
	const [finishError, setFinishError] = useState<string | null>(null);
	const resumedFor = useRef<string | null>(null);
	const autoProbedFor = useRef<string | null>(null);
	const keyFetchedFor = useRef<string | null>(null);

	const upsert = (v: ServerView) => useServersStore.getState().upsertServer(v);
	const signature = connectionSignature(form);
	const requirePassword = form.authMethod === "password" && !(view?.config.auth.method === "password" && view.config.auth.hasSecret);
	const errors = useMemo(() => validateConnectionForm(form, { requirePassword }), [form, requirePassword]);

	// Resume an existing server (reload, or coming back from the server page).
	useEffect(() => {
		if (!serverId || !view || deployJob.isLoading || resumedFor.current === serverId) return;
		resumedFor.current = serverId;
		autoProbedFor.current = null;
		keyFetchedFor.current = null;
		const values = formFromServerConfig(view);
		const jumpHost = Boolean(view.config.jumpOnly);
		// A jump host only needs its key confirmed (step 2 then offers "完成").
		dispatch({ type: "replace", state: jumpHost ? { step: 2, reached: 2, completed: [1], skipped: [] } : resumeWizard(view, deployJob.data) });
		setForm(values);
		setJumpOnly(jumpHost);
		setSavedSignature(connectionSignature(values));
		setTest(null);
		setProbe(IDLE_PROBE);
		setShowErrors(false);
		setStepError(null);
		setHostKeyError(null);
		setDeployError(null);
		setFinishError(null);
	}, [serverId, view, deployJob.isLoading, deployJob.data]);

	const resetAll = useCallback(() => {
		resumedFor.current = null;
		autoProbedFor.current = null;
		keyFetchedFor.current = null;
		dispatch({ type: "replace", state: INITIAL_WIZARD });
		setForm(emptyConnectionForm());
		setJumpOnly(false);
		setShowErrors(false);
		setTest(null);
		setStepError(null);
		setSavedSignature(null);
		setHostKeyError(null);
		setProbe(IDLE_PROBE);
		setDeployError(null);
		setFinishError(null);
		setParams({}, { replace: true });
	}, [setParams]);

	// The `server` param was dropped by a navigation (e.g. the sidebar's "添加服务器"): start over.
	useEffect(() => {
		if (!serverId && resumedFor.current !== null) resetAll();
	}, [serverId, resetAll]);

	const finishJumpOnly = (saved: ServerView) => {
		toast.success(`已添加跳板机 ${saved.config.name}，现在可以在“跳板机”中选择它`);
		resetAll();
	};

	const changeForm = (patch: Partial<ConnectionFormValues>) => {
		setForm((f) => ({ ...f, ...patch }));
		setStepError(null);
	};

	// ---------- step 1 ----------

	const runTest = async () => {
		if (hasErrors(errors)) {
			setShowErrors(true);
			return;
		}
		setTesting(true);
		setStepError(null);
		try {
			setTest({ signature, result: await testConnection(toTestRequest(form, view?.config.id)) });
		} catch (e) {
			setStepError(errorMessage(e));
		} finally {
			setTesting(false);
		}
	};

	const submitConnection = async () => {
		if (hasErrors(errors)) {
			setShowErrors(true);
			return;
		}
		setSubmitting(true);
		setStepError(null);
		try {
			let result = test?.signature === signature ? test.result : null;
			if (!result) {
				result = await testConnection(toTestRequest(form, view?.config.id));
				setTest({ signature, result });
			}
			if (!result.ok && !result.hostKey) {
				setStepError(result.error ?? "连接失败");
				return;
			}
			const saved = view
				? await updateServer(view.config.id, { ...toConnectionUpdate(form), jumpOnly })
				: await createServer({ ...toCreateRequest(form), ...(jumpOnly ? { jumpOnly: true } : {}) });
			upsert(saved);
			const id = saved.config.id;
			if (!view) {
				resumedFor.current = id;
				setParams({ server: id }, { replace: true });
			}
			const changed = savedSignature !== null && savedSignature !== signature;
			setSavedSignature(signature);
			const trusted = Boolean(result.hostKey && saved.config.hostKey?.fingerprint === result.hostKey.fingerprint);
			if (!trusted) {
				setHostKeyError(null);
				dispatch({ type: "complete", step: 1 });
				dispatch({ type: "restartFrom", step: 2 });
				return;
			}
			// Same endpoint and key as before: verify the login now instead of re-confirming the key.
			const verify = await testServer(id);
			if (!verify.ok) {
				setStepError(verify.error ?? "SSH 认证失败");
				return;
			}
			if (jumpOnly) {
				finishJumpOnly(saved);
				return;
			}
			dispatch({ type: "complete", step: 1, next: 3, skipped: wizard.completed.includes(2) ? [] : [2] });
			if (changed) {
				dispatch({ type: "restartFrom", step: 3 });
				setProbe(IDLE_PROBE);
				autoProbedFor.current = null;
			}
		} catch (e) {
			setStepError(errorMessage(e));
		} finally {
			setSubmitting(false);
		}
	};

	// ---------- step 2 ----------

	const fetchHostKey = useCallback(async (id: string) => {
		setHostKeyBusy(true);
		setHostKeyError(null);
		try {
			const result = await testServer(id);
			setTest((prev) => ({ signature: prev?.signature ?? "", result }));
			if (!result.hostKey) setHostKeyError(result.error ?? "未能读取主机密钥");
		} catch (e) {
			setHostKeyError(errorMessage(e));
		} finally {
			setHostKeyBusy(false);
		}
	}, []);

	// Resumed at step 2 without a test result: read the presented key from the saved server.
	useEffect(() => {
		if (wizard.step !== 2 || !view || view.config.hostKey || test?.result.hostKey) return;
		if (keyFetchedFor.current === view.config.id) return;
		keyFetchedFor.current = view.config.id;
		void fetchHostKey(view.config.id);
	}, [wizard.step, view, test, fetchHostKey]);

	const verifyAndContinue = async (id: string) => {
		const verify = await testServer(id);
		if (!verify.ok) {
			setHostKeyError(verify.error ?? "SSH 认证失败");
			return false;
		}
		return true;
	};

	const trustKey = async () => {
		const key = test?.result.hostKey;
		if (!view || !key) return;
		setHostKeyBusy(true);
		setHostKeyError(null);
		try {
			const updated = await trustHostKey(view.config.id, { algorithm: key.algorithm, fingerprint: key.fingerprint });
			upsert(updated);
			if (!(await verifyAndContinue(view.config.id))) return;
			if (jumpOnly) {
				finishJumpOnly(updated);
				return;
			}
			dispatch({ type: "complete", step: 2 });
		} catch (e) {
			setHostKeyError(errorMessage(e));
		} finally {
			setHostKeyBusy(false);
		}
	};

	const continueTrusted = async () => {
		if (!view) return;
		setHostKeyBusy(true);
		setHostKeyError(null);
		try {
			if (!(await verifyAndContinue(view.config.id))) return;
			if (jumpOnly) {
				finishJumpOnly(view);
				return;
			}
			dispatch({ type: "complete", step: 2 });
		} catch (e) {
			setHostKeyError(errorMessage(e));
		} finally {
			setHostKeyBusy(false);
		}
	};

	// ---------- step 3 ----------

	const runProbe = useCallback(async (id: string) => {
		const started = Date.now();
		setProbe({ running: true, durationMs: null });
		try {
			const result = await probeServer(id);
			setProbe({ result, running: false, durationMs: Date.now() - started });
		} catch (e) {
			setProbe({ error: errorMessage(e), running: false, durationMs: null });
		}
	}, []);

	useEffect(() => {
		if (wizard.step !== 3 || !view || autoProbedFor.current === view.config.id) return;
		autoProbedFor.current = view.config.id;
		void runProbe(view.config.id);
	}, [wizard.step, view, runProbe]);

	// ---------- step 4 ----------

	const startDeploy = async (options: DeployOptions) => {
		if (!view) return;
		setDeployStarting(true);
		setDeployError(null);
		try {
			const c = view.config;
			const patch: UpdateServerRequest = {};
			if (options.agentDirMode !== c.agentDirMode) patch.agentDirMode = options.agentDirMode;
			if (options.proxyMode !== c.proxy.mode || options.proxyScope !== c.proxy.scope) patch.proxy = { mode: options.proxyMode, scope: options.proxyScope };
			if (Object.keys(patch).length) upsert(await updateServer(c.id, patch));
			const job = await deployServer(c.id, toDeployRequest(options));
			client.setQueryData(serverQueryKeys.deployJob(c.id), job);
		} catch (e) {
			setDeployError(errorMessage(e));
		} finally {
			setDeployStarting(false);
		}
	};

	const cancel = async () => {
		if (!view) return;
		setCancelling(true);
		try {
			await cancelDeploy(view.config.id);
		} catch (e) {
			toast.error(errorMessage(e), { title: "取消部署失败" });
		} finally {
			setCancelling(false);
		}
	};

	// ---------- step 5 ----------

	const finish = async (items: Record<SyncItemKey, boolean>, auto: boolean) => {
		if (!view) return;
		setFinishing(true);
		setFinishError(null);
		try {
			const c = view.config;
			const changedItems = SYNC_ITEM_KEYS.filter((k) => Boolean(items[k]) !== Boolean(c.sync.items[k]));
			if (changedItems.length || auto !== c.sync.auto) {
				const updated = await updateServer(c.id, {
					sync: { ...(changedItems.length ? { items: Object.fromEntries(changedItems.map((k) => [k, items[k]])) } : {}), auto },
				});
				upsert(updated);
				if (changedItems.length && updated.status.connection === "connected") {
					runSync({ serverIds: [c.id] })
						.then(() => invalidateSync())
						.catch((e: unknown) => toast.error(errorMessage(e), { title: "同步失败" }));
				}
			}
			dispatch({ type: "complete", step: 5 });
			toast.success(`${c.name} 已就绪`);
			navigate(paths.server(c.id));
		} catch (e) {
			setFinishError(errorMessage(e));
		} finally {
			setFinishing(false);
		}
	};

	// ---------- render ----------

	const title = defaultServerName(form);
	const jumpLabel = jumpChainLabel(form.jumpServerIds, servers);
	const jumps = (view?.config.jumpServerIds ?? []).map((id) => servers.find((s) => s.config.id === id)).filter(Boolean) as ServerView[];

	let body: ReactNode;
	if (serverId && loading) body = <LoadingBlock text="正在读取服务器…" />;
	else if (serverId && notFound)
		body = (
			<EmptyState
				icon={<Server />}
				title="服务器不存在"
				description="该服务器可能已被删除。"
				actions={
					<Button variant="primary" onClick={resetAll}>
						重新添加
					</Button>
				}
			/>
		);
	else if (wizard.step === 1 || !view)
		body = (
			<ConnectionStep
				form={form}
				onChange={changeForm}
				errors={showErrors ? errors : {}}
				servers={servers}
				selfId={view?.config.id}
				hasStoredSecret={Boolean(view?.config.auth.hasSecret && view.config.auth.method === form.authMethod)}
				testing={testing}
				testResult={test?.result ?? null}
				testStale={test?.signature !== signature}
				stepError={stepError}
				submitting={submitting}
				onTest={runTest}
				onNext={submitConnection}
				jumpOnly={jumpOnly}
				onJumpOnlyChange={setJumpOnly}
			/>
		);
	else if (wizard.step === 2)
		body = (
			<HostKeyStep
				view={view}
				hostKey={test?.result.hostKey}
				jumps={jumps}
				busy={hostKeyBusy}
				error={hostKeyError}
				jumpOnly={jumpOnly}
				onTrust={trustKey}
				onContinue={continueTrusted}
				onBack={() => dispatch({ type: "goto", step: 1 })}
				onRetest={() => void fetchHostKey(view.config.id)}
			/>
		);
	else if (wizard.step === 3)
		body = (
			<ProbeStep
				view={view}
				result={probe.result}
				running={probe.running}
				error={probe.error ?? null}
				durationMs={probe.durationMs}
				onProbe={() => void runProbe(view.config.id)}
				onNext={() => dispatch({ type: "complete", step: 3 })}
				onBack={() => dispatch({ type: "goto", step: 1 })}
			/>
		);
	else if (wizard.step === 4)
		body = (
			<DeployStep
				view={view}
				probe={probe.result}
				job={deployJob.data}
				starting={deployStarting}
				startError={deployError}
				cancelling={cancelling}
				onStart={startDeploy}
				onCancel={cancel}
				onNext={() => dispatch({ type: "complete", step: 4 })}
			/>
		);
	else
		body = (
			<SyncStep view={view} saving={finishing} error={finishError} onBack={() => dispatch({ type: "goto", step: 4 })} onFinish={finish} />
		);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto py-6">
			<div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-4 sm:px-6">
				<div className="flex flex-wrap items-end gap-3">
					<div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1.5">
						<h1 className="m-0 text-xl font-semibold">{jumpOnly ? "添加跳板机" : "添加服务器"}</h1>
						<p className="m-0 text-sm text-fg-2">
							{jumpOnly ? "跳板机只用于转发 SSH 连接，不部署 pi。" : "通过 SSH 连接服务器，离线上传 Node 运行时、pi、配置与插件。"}
						</p>
					</div>
					{form.host.trim() && (
						<span className="flex h-7 max-w-full min-w-0 items-center gap-2 rounded-md border border-border bg-panel px-2.5 text-xs text-fg-2">
							<Server size={14} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden="true" />
							<span className="truncate font-semibold text-fg">{title}</span>
							<code className="truncate text-xs text-fg-code">
								{form.username.trim() || "user"}@{form.host.trim()}:{parsePort(form.port) ?? 22}
							</code>
							{jumpLabel && <span className="truncate">经 {jumpLabel}</span>}
						</span>
					)}
				</div>
				{!jumpOnly && <StepNav state={wizard} onPick={(step) => dispatch({ type: "goto", step })} />}
				{body}
			</div>
		</div>
	);
}
