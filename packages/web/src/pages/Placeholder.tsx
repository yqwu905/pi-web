import type { ReactNode } from "react";
import { EmptyState } from "../components/ui/Display";

/** Temporary page body used by placeholder modules until the feature pages land. */
export function Placeholder({ icon, title, description }: { icon: ReactNode; title: string; description?: string }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<EmptyState icon={icon} title={title} description={description ?? "此页面正在建设中。"} />
		</div>
	);
}
