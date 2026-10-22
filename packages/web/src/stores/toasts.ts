/**
 * Toast notifications. Rendered by <ToastViewport/> (mounted in the AppShell).
 *   import { toast } from "../stores/toasts";
 *   toast.success("已保存");
 *   toast.error(errorMessage(e), { title: "部署失败" });
 *   toast.warning("已拦截 1 条命令", { source: "safe-bash" });   // extension notify
 */
import { create } from "zustand";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface Toast {
	id: string;
	tone: ToastTone;
	message: string;
	title?: string;
	/** Origin shown as a code tag, e.g. an extension name ("[token-meter]"). */
	source?: string;
	/** Auto-dismiss delay; null keeps the toast until dismissed. */
	durationMs: number | null;
	createdAt: number;
	action?: { label: string; onClick: () => void };
}

export type ToastInput = Omit<Toast, "id" | "createdAt" | "durationMs"> & { id?: string; durationMs?: number | null };

const DEFAULT_DURATION: Record<ToastTone, number | null> = {
	info: 4000,
	success: 3000,
	warning: 6000,
	error: 8000,
};
const MAX_TOASTS = 5;

interface ToastsState {
	toasts: Toast[];
	push(input: ToastInput): string;
	dismiss(id: string): void;
	clear(): void;
}

let counter = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastsStore = create<ToastsState>()((set, get) => ({
	toasts: [],
	push: (input) => {
		const id = input.id ?? `toast-${Date.now()}-${++counter}`;
		const durationMs = input.durationMs === undefined ? DEFAULT_DURATION[input.tone] : input.durationMs;
		const toast: Toast = { ...input, id, durationMs, createdAt: Date.now() };
		set((s) => ({ toasts: [...s.toasts.filter((t) => t.id !== id), toast].slice(-MAX_TOASTS) }));
		const old = timers.get(id);
		if (old) clearTimeout(old);
		if (durationMs !== null) {
			timers.set(
				id,
				setTimeout(() => get().dismiss(id), durationMs),
			);
		}
		return id;
	},
	dismiss: (id) => {
		const t = timers.get(id);
		if (t) clearTimeout(t);
		timers.delete(id);
		set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
	},
	clear: () => {
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
		set({ toasts: [] });
	},
}));

type ToastOptions = Partial<Omit<ToastInput, "tone" | "message">>;

const pushTone = (tone: ToastTone) => (message: string, options: ToastOptions = {}) =>
	useToastsStore.getState().push({ ...options, tone, message });

export const toast = {
	info: pushTone("info"),
	success: pushTone("success"),
	warning: pushTone("warning"),
	error: pushTone("error"),
	dismiss: (id: string) => useToastsStore.getState().dismiss(id),
};
