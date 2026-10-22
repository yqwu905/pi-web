/** Status → display text/tone mapping for servers and conversations (pure, shared by sidebar & pages). */
import type { ConvStatus, ServerView } from "@pi-web/shared";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface StatusDisplay {
	tone: Tone;
	text: string;
	/** Hollow dot (offline / idle). */
	hollow?: boolean;
	/** Pulsing dot (running). */
	pulse?: boolean;
}

/** Sidebar/server header status: "在线 · 12ms", "在线 · 1 个待同步", "连接中…", "离线". */
export function serverStatusDisplay(view: ServerView): StatusDisplay {
	const s = view.status;
	switch (s.connection) {
		case "connected": {
			if (s.deployState === "deploying") return { tone: "accent", text: "部署中…", pulse: true };
			if (s.deployState === "not_deployed") return { tone: "warning", text: "在线 · 未部署" };
			if (s.deployState === "outdated") return { tone: "warning", text: "在线 · 需要升级" };
			if (s.pendingSync > 0) return { tone: "success", text: `在线 · ${s.pendingSync} 个待同步` };
			if (s.latencyMs !== undefined) return { tone: "success", text: `在线 · ${Math.round(s.latencyMs)}ms` };
			return { tone: "success", text: "在线" };
		}
		case "connecting":
			return { tone: "accent", text: "连接中…", pulse: true };
		case "error":
			return { tone: "danger", text: "连接失败" };
		default:
			return { tone: "neutral", text: "离线", hollow: true };
	}
}

/** Badge for a conversation process state; undefined for "no live process". */
export function convStatusDisplay(status: ConvStatus | undefined): StatusDisplay | undefined {
	switch (status) {
		case "running":
			return { tone: "accent", text: "运行中", pulse: true };
		case "waiting_ui":
			return { tone: "warning", text: "等待确认 · 扩展对话框" };
		case "starting":
			return { tone: "accent", text: "启动中…", pulse: true };
		case "idle":
			return { tone: "success", text: "已就绪" };
		default:
			return undefined;
	}
}

export const DEPLOY_STATE_LABELS: Record<ServerView["status"]["deployState"], string> = {
	unknown: "未知",
	not_deployed: "未部署",
	deployed: "已部署",
	outdated: "需要升级",
	deploying: "部署中",
};

export const CONNECTION_LABELS: Record<ServerView["status"]["connection"], string> = {
	disconnected: "离线",
	connecting: "连接中",
	connected: "在线",
	error: "连接失败",
};
