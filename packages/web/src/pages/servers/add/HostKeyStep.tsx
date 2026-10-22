import type { HostKeyInfo, ServerView } from "@pi-web/shared";
import { CircleCheck, ShieldAlert, TriangleAlert } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Callout } from "../../../components/ui/Display";
import { serverTarget } from "../lib/connection-form";

export interface HostKeyStepProps {
	view: ServerView;
	hostKey: HostKeyInfo | undefined;
	jumps: readonly ServerView[];
	busy: boolean;
	error: string | null;
	jumpOnly: boolean;
	onTrust: () => void;
	onBack: () => void;
	onRetest: () => void;
	/** The key is already trusted: verify the login and move on. */
	onContinue: () => void;
}

/** Algorithm display: "ssh-ed25519" → "ED25519". */
function algorithmLabel(alg: string): string {
	const m = /^(?:ssh-|ecdsa-sha2-)?(.+)$/.exec(alg);
	return (m ? m[1] : alg).toUpperCase();
}

function keygenCommand(alg: string): string {
	const a = alg.toLowerCase();
	const type = a.includes("ed25519") ? "ed25519" : a.includes("ecdsa") ? "ecdsa" : a.includes("rsa") ? "rsa" : "ed25519";
	return `ssh-keygen -lf /etc/ssh/ssh_host_${type}_key.pub`;
}

export function HostKeyStep({ view, hostKey, jumps, busy, error, jumpOnly, onTrust, onBack, onRetest, onContinue }: HostKeyStepProps) {
	const c = view.config;
	const via = jumps.length ? `（经 ${jumps.map((j) => j.config.name).join(" → ")}）` : "";
	const trusted = c.hostKey && (!hostKey || hostKey.fingerprint === c.hostKey.fingerprint) ? c.hostKey : undefined;
	if (trusted) {
		return (
			<section aria-labelledby="as-hk-t" className="flex max-w-[760px] flex-col gap-4 rounded-xl border border-success/30 bg-success-faint p-5">
				<div className="flex items-start gap-3">
					<CircleCheck size={20} strokeWidth={1.8} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
					<div className="flex min-w-0 flex-col gap-1">
						<span className="text-xs font-semibold text-success-fg">已信任</span>
						<h2 id="as-hk-t" className="m-0 text-lg font-semibold text-fg">
							{c.host}:{c.port} 的主机指纹已确认
						</h2>
					</div>
				</div>
				<dl className="m-0 grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-sm">
					<dt className="text-fg-2">密钥类型</dt>
					<dd className="m-0">
						<code className="text-mono text-fg">{algorithmLabel(trusted.algorithm)}</code>
					</dd>
					<dt className="text-fg-2">指纹</dt>
					<dd className="m-0 min-w-0">
						<code className="block rounded-md border border-border bg-code px-2.5 py-2 text-sm leading-5 break-all text-fg">{trusted.fingerprint}</code>
					</dd>
				</dl>
				{error && (
					<Callout tone="danger" title="连接未通过" actions={<Button size="sm" onClick={onBack}>返回修改连接信息</Button>}>
						{error}
					</Callout>
				)}
				<div className="flex justify-end gap-2">
					<Button onClick={onBack}>上一步</Button>
					<Button variant="primary" loading={busy} onClick={onContinue}>
						{jumpOnly ? "完成" : "下一步"}
					</Button>
				</div>
			</section>
		);
	}
	if (!hostKey) {
		return (
			<section aria-labelledby="as-hk-t" className="flex max-w-[760px] flex-col gap-4 rounded-xl border border-border bg-panel p-5">
				<h2 id="as-hk-t" className="m-0 text-lg font-semibold">
					未获取到主机指纹
				</h2>
				<Callout tone="danger" title="连接失败">
					{error ?? "测试连接未返回主机密钥，请检查主机地址、端口和跳板机。"}
				</Callout>
				<div className="flex justify-end gap-2">
					<Button onClick={onBack}>返回修改</Button>
					<Button variant="primary" loading={busy} onClick={onRetest}>
						重新测试
					</Button>
				</div>
			</section>
		);
	}
	return (
		<section aria-labelledby="as-hk-t" className="flex max-w-[760px] flex-col gap-4 rounded-xl border border-warning-border bg-warning-soft p-5">
			<div className="flex items-start gap-3">
				<ShieldAlert size={20} strokeWidth={1.8} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
				<div className="flex min-w-0 flex-col gap-1">
					<span className="text-xs font-semibold text-warning-fg">需要确认 · 未知主机</span>
					<h2 id="as-hk-t" className="m-0 text-lg font-semibold text-fg">
						首次连接 {c.host}:{c.port}
						{via}
					</h2>
				</div>
			</div>
			<dl className="m-0 grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-sm">
				<dt className="text-fg-2">主机</dt>
				<dd className="m-0 text-fg">
					{c.name} · <code className="text-mono text-fg-code">{serverTarget(c)}</code>
				</dd>
				<dt className="text-fg-2">密钥类型</dt>
				<dd className="m-0">
					<code className="text-mono text-fg" title={hostKey.algorithm}>
						{algorithmLabel(hostKey.algorithm)}
					</code>
				</dd>
				<dt className="text-fg-2">指纹</dt>
				<dd className="m-0 min-w-0">
					<code className="block rounded-md border border-warning-border bg-code px-2.5 py-2 text-sm leading-5 break-all text-fg select-all">{hostKey.fingerprint}</code>
				</dd>
				{jumps.length > 0 && (
					<>
						<dt className="text-fg-2">跳板机</dt>
						<dd className="m-0 flex flex-col gap-1">
							{jumps.map((j) => (
								<span key={j.config.id} className="flex flex-wrap items-center gap-1.5 text-fg">
									{j.config.name} <code className="text-mono text-fg-code">{serverTarget(j.config)}</code>
									{j.config.hostKey ? (
										<span className="flex items-center gap-1 text-xs text-success-fg">
											<CircleCheck size={12} className="text-success" aria-hidden="true" />
											指纹已信任
										</span>
									) : (
										<span className="flex items-center gap-1 text-xs text-warning-fg">
											<TriangleAlert size={12} className="text-warning" aria-hidden="true" />
											指纹未信任，请先在该服务器的设置中确认
										</span>
									)}
								</span>
							))}
						</dd>
					</>
				)}
			</dl>
			<p className="m-0 text-sm leading-[21px] text-fg">请与服务器管理员核对指纹。信任后会保存到 Pi-Web，指纹变化时将拒绝连接。</p>
			<p className="m-0 text-xs leading-[18px] text-fg-2">
				在服务器上运行 <code className="text-xs text-fg-code">{keygenCommand(hostKey.algorithm)}</code> 可查看本机指纹。
			</p>
			{error && (
				<Callout tone="danger" title="连接未通过" actions={<Button size="sm" onClick={onBack}>返回修改连接信息</Button>}>
					{error}
				</Callout>
			)}
			<div className="flex justify-end gap-2 pt-1">
				<Button onClick={onBack}>取消</Button>
				<Button variant="primary" loading={busy} onClick={onTrust}>
					{jumpOnly ? "信任并完成" : "信任并继续"}
				</Button>
			</div>
		</section>
	);
}
