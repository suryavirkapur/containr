import { For, Show, type Component } from "solid-js";

import type { HttpRequestLog } from "../../api/services";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	EmptyState,
	Skeleton,
} from "../ui";
import {
	describeError,
	formatDate,
	httpStatusVariant,
	requestLabel,
} from "./formatters";

interface ServiceHttpLogsPanelProps {
	logs?: HttpRequestLog[];
	loading: boolean;
	error: unknown;
	onRefresh: () => void | Promise<void>;
}

export const ServiceHttpLogsPanel: Component<ServiceHttpLogsPanelProps> = (
	props,
) => (
	<Card>
		<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
			<div>
				<CardTitle>http request logs</CardTitle>
				<CardDescription>
					Recent request-level access logs captured by the proxy for this
					public service.
				</CardDescription>
			</div>
			<Button variant="outline" onClick={() => void props.onRefresh()}>
				refresh http logs
			</Button>
		</CardHeader>
		<CardContent>
			<Show when={props.error}>
				<Alert variant="destructive" title="failed to load http logs">
					{describeError(props.error)}
				</Alert>
			</Show>
			<Show when={props.loading}>
				<Skeleton class="h-64 w-full" />
			</Show>
			<Show
				when={!props.loading && (props.logs?.length ?? 0) > 0}
				fallback={
					<EmptyState
						title="no http requests yet"
						description="request logs will appear here after traffic reaches the service."
					/>
				}
			>
				<div class="overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
					<div class="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-3 border-b border-[var(--border)] bg-[var(--muted)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)] md:grid">
						<p>request</p>
						<p>status</p>
						<p>upstream</p>
						<p>time</p>
					</div>
					<div class="divide-y divide-[var(--border)]">
						<For each={props.logs ?? []}>
							{(request) => (
								<div class="grid gap-3 bg-[var(--card)] px-4 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] md:items-center">
									<div class="space-y-2">
										<div class="flex flex-wrap items-center gap-2">
											<Badge variant="outline">{request.method}</Badge>
											<Badge variant={httpStatusVariant(request.status)}>
												{request.status}
											</Badge>
											<p class="text-xs text-[var(--muted-foreground)]">
												{request.domain}
											</p>
										</div>
										<p class="font-mono text-sm text-[var(--foreground)]">
											{requestLabel(request)}
										</p>
									</div>
									<p class="text-sm text-[var(--muted-foreground)]">
										{request.status >= 500
											? "upstream timeout / failure"
											: "served"}
									</p>
									<p class="font-mono text-xs text-[var(--muted-foreground)]">
										{request.protocol} {"->"} {request.upstream}
									</p>
									<p class="text-xs text-[var(--muted-foreground)]">
										{formatDate(request.created_at)}
									</p>
								</div>
							)}
						</For>
					</div>
				</div>
			</Show>
		</CardContent>
	</Card>
);
