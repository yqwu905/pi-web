import { CircleAlert } from "lucide-react";
import { ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/Display";
import { paths } from "../lib/routes";

export default function NotFoundPage() {
	return (
		<EmptyState
			icon={<CircleAlert />}
			title="页面不存在"
			description="链接可能已失效，或者对应的资源已被删除。"
			actions={<ButtonLink to={paths.home()}>返回首页</ButtonLink>}
		/>
	);
}
