import { CircleX } from "lucide-react";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { errorMessage } from "../api/client";
import { Button, ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/Display";
import { paths } from "../lib/routes";

/** errorElement for the route tree: render errors and failed lazy page loads. */
export default function RouteErrorPage() {
	const error = useRouteError();
	const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : errorMessage(error);
	return (
		<div className="flex min-h-full flex-1 items-center justify-center bg-bg">
			<EmptyState
				icon={<CircleX />}
				title="页面出错了"
				description={<span className="font-mono text-xs break-all">{message}</span>}
				actions={
					<>
						<Button variant="primary" onClick={() => window.location.reload()}>
							重新加载
						</Button>
						<ButtonLink to={paths.home()}>返回首页</ButtonLink>
					</>
				}
			/>
		</div>
	);
}
