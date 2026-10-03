import RefreshCw from "lucide-solid/icons/refresh-cw";
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { getServiceHttpLogs } from "../../api/services";
import { Badge, Button, Card, EmptyState, Input, Segmented, Skeleton } from "../../components/ui";
import { LogConsole } from "../../components/ui/LogConsole";
import { formatDateTime } from "../../lib/format";
import { useServiceLogStream } from "../../lib/logs";
import type { Tone } from "../../lib/status";
import { useService } from "./context";

type View = "runtime" | "http";

const statusTone = (status: number): Tone =>
	status >= 500 ? "danger" : status >= 400 ? "warning" : status >= 300 ? "info" : "success";

const ServiceLogs = () => {
	const ctx = useService();
	const [view, setView] = createSignal<View>("runtime");
	const [filter, setFilter] = createSignal("");
	const stream = useServiceLogStream(
		() => ctx.id(),
		() => view() === "runtime",
	);
	const [httpLogs, { refetch }] = createResource(
		() => (view() === "http" ? ctx.id() : null),
		(id) => getServiceHttpLogs(id, 200),
	);

	const filtered = createMemo(() => {
		const needle = filter().trim().toLowerCase();
		const rows = httpLogs() ?? [];
		if (!needle) return rows;
		return rows.filter((row) =>
			`${row.method} ${row.path} ${row.status} ${row.domain}`.toLowerCase().includes(needle),
		);
	});

	return (
		<div class="space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<Segmented<View>
					value={view()}
					onChange={setView}
					options={[
						{ value: "runtime", label: "Application logs" },
						...(ctx.isApp() ? [{ value: "http" as View, label: "HTTP requests" }] : []),
					]}
				/>
				<Show when={view() === "http"}>
					<div class="flex items-center gap-2">
						<Input
							class="w-56"
							placeholder="Filter path, status, method"
							value={filter()}
							onInput={(event) => setFilter(event.currentTarget.value)}
						/>
						<Button variant="secondary" icon onClick={() => void refetch()} aria-label="Refresh">
							<RefreshCw />
						</Button>
					</div>
				</Show>
			</div>

			<Switch>
				<Match when={view() === "runtime"}>
					<LogConsole
						stream={stream}
						height="calc(100vh - 330px)"
						filename={`${ctx.service()?.name ?? "service"}-logs.txt`}
						emptyText="No output yet. Logs appear here as soon as the container writes to stdout or stderr."
					/>
				</Match>
				<Match when={view() === "http"}>
					<Card flush>
						<Switch>
							<Match when={httpLogs.loading && !httpLogs()}>
								<div class="space-y-2 p-4">
									<Skeleton class="h-8" />
									<Skeleton class="h-8" />
								</div>
							</Match>
							<Match when={!filtered().length}>
								<div class="p-4">
									<EmptyState
										title="No requests recorded"
										description="Requests routed through the containr proxy show up here."
									/>
								</div>
							</Match>
							<Match when={true}>
								<div class="max-h-[calc(100vh-330px)] overflow-auto">
									<table class="table">
										<thead class="sticky top-0">
											<tr>
												<th>Time</th>
												<th>Status</th>
												<th>Method</th>
												<th>Path</th>
												<th>Host</th>
												<th>Upstream</th>
											</tr>
										</thead>
										<tbody>
											<For each={filtered()}>
												{(row) => (
													<tr>
														<td class="whitespace-nowrap text-fg-subtle">
															{formatDateTime(row.created_at)}
														</td>
														<td>
															<Badge tone={statusTone(row.status)}>{row.status}</Badge>
														</td>
														<td class="font-mono text-[12px]">{row.method}</td>
														<td
															class="max-w-[360px] truncate font-mono text-[12px]"
															title={row.path}
														>
															{row.path}
														</td>
														<td class="text-fg-muted">{row.domain}</td>
														<td class="font-mono text-[12px] text-fg-subtle">
															{row.upstream}
															<Show when={row.protocol !== "http"}>
																<span class="ml-1.5 text-fg-faint">{row.protocol}</span>
															</Show>
														</td>
													</tr>
												)}
											</For>
										</tbody>
									</table>
								</div>
							</Match>
						</Switch>
					</Card>
				</Match>
			</Switch>
		</div>
	);
};

export default ServiceLogs;
