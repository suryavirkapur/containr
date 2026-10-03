import Activity from "lucide-solid/icons/activity";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ApiError, errorMessage } from "../../api/http";
import { getServiceMetrics, type ServiceMetrics as Metrics } from "../../api/platform";
import { Card, EmptyState, Meter, Notice, Skeleton } from "../../components/ui";
import { AreaChart, createRollingSeries } from "../../components/ui/chart";
import { formatBytes, formatPercent } from "../../lib/format";
import { useService } from "./context";

const INTERVAL = 3;
const WINDOW = 60;

const ServiceMetrics = () => {
	const ctx = useService();
	const [latest, setLatest] = createSignal<Metrics | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [unsupported, setUnsupported] = createSignal(false);
	const cpu = createRollingSeries(WINDOW);
	const memory = createRollingSeries(WINDOW);
	const rx = createRollingSeries(WINDOW);
	const tx = createRollingSeries(WINDOW);
	let previous: { at: number; rx: number; tx: number } | null = null;

	const poll = async () => {
		try {
			const next = await getServiceMetrics(ctx.id());
			const containers = next.containers;
			const sum = (pick: (item: Metrics["containers"][number]) => number) =>
				containers.reduce((total, item) => total + pick(item), 0);
			const now = Date.now();
			const totalRx = sum((item) => item.network_rx_bytes);
			const totalTx = sum((item) => item.network_tx_bytes);
			cpu.push(sum((item) => item.cpu_percent));
			memory.push(sum((item) => item.memory_used_bytes));
			if (previous) {
				const seconds = Math.max(1, (now - previous.at) / 1000);
				rx.push(Math.max(0, (totalRx - previous.rx) / seconds));
				tx.push(Math.max(0, (totalTx - previous.tx) / seconds));
			}
			previous = { at: now, rx: totalRx, tx: totalTx };
			setLatest(next);
			setError(null);
		} catch (requestError) {
			if (
				requestError instanceof ApiError &&
				(requestError.status === 404 || requestError.status === 405)
			) {
				setUnsupported(true);
				return;
			}
			setError(errorMessage(requestError));
		}
	};

	onMount(() => {
		void poll();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible" && !unsupported()) void poll();
		}, INTERVAL * 1000);
		onCleanup(() => clearInterval(timer));
	});

	const totalLimit = () =>
		latest()?.containers.reduce((sum, item) => sum + item.memory_limit_bytes, 0) ?? 0;

	return (
		<Show
			when={!unsupported()}
			fallback={
				<EmptyState
					icon={<Activity />}
					title="Metrics need a newer server"
					description="Update containr on this server to collect per-service CPU, memory and network usage."
				/>
			}
		>
			<div class="space-y-6">
				<Show when={error()}>
					<Notice tone="warning">Could not read metrics: {error()}</Notice>
				</Show>
				<Show when={ctx.service()?.status !== "running"}>
					<Notice>This service isn't running, so there is nothing to measure right now.</Notice>
				</Show>
				<div class="grid gap-6 lg:grid-cols-2">
					<Card title="CPU" description={`All instances · sampled every ${INTERVAL}s`}>
						<div class="mb-3 text-[22px] font-semibold tabular-nums">
							{formatPercent(cpu.values().at(-1))}
						</div>
						<AreaChart
							series={[{ label: "CPU", color: "var(--chart-1)", values: cpu.values() }]}
							format={(value) => formatPercent(value)}
							interval={INTERVAL}
						/>
					</Card>
					<Card
						title="Memory"
						description={totalLimit() ? `Limit ${formatBytes(totalLimit())}` : "No limit set"}
					>
						<div class="mb-3 text-[22px] font-semibold tabular-nums">
							{formatBytes(memory.values().at(-1))}
						</div>
						<AreaChart
							series={[{ label: "Memory", color: "var(--chart-2)", values: memory.values() }]}
							max={totalLimit() || undefined}
							format={(value) => formatBytes(value)}
							interval={INTERVAL}
						/>
					</Card>
					<Card title="Network" description="Bytes per second" class="lg:col-span-2">
						<AreaChart
							height={180}
							series={[
								{ label: "Received", color: "var(--chart-3)", values: rx.values() },
								{ label: "Sent", color: "var(--chart-4)", values: tx.values() },
							]}
							format={(value) => `${formatBytes(value)}/s`}
							interval={INTERVAL}
						/>
						<div class="mt-3 flex gap-5 text-[12px] text-fg-subtle">
							<span class="flex items-center gap-1.5">
								<span class="h-2 w-2 rounded-full" style={{ background: "var(--chart-3)" }} />
								Received
							</span>
							<span class="flex items-center gap-1.5">
								<span class="h-2 w-2 rounded-full" style={{ background: "var(--chart-4)" }} />
								Sent
							</span>
						</div>
					</Card>
				</div>

				<Card title="Containers" flush>
					<Show
						when={latest()}
						fallback={
							<div class="p-4">
								<Skeleton class="h-10" />
							</div>
						}
					>
						<div class="overflow-x-auto">
							<table class="table min-w-[720px]">
								<thead>
									<tr>
										<th>Container</th>
										<th>CPU</th>
										<th class="w-[220px]">Memory</th>
										<th>Network in / out</th>
										<th>Disk read / write</th>
										<th>PIDs</th>
									</tr>
								</thead>
								<tbody>
									<For
										each={latest()?.containers}
										fallback={
											<tr>
												<td colSpan={6} class="py-8 text-center text-fg-subtle">
													No running containers
												</td>
											</tr>
										}
									>
										{(item) => (
											<tr>
												<td class="max-w-[240px] truncate font-mono text-[12px]" title={item.name}>
													{item.name}
												</td>
												<td class="tabular-nums">{formatPercent(item.cpu_percent)}</td>
												<td>
													<div class="mb-1 text-[12px] tabular-nums">
														{formatBytes(item.memory_used_bytes)}
														<span class="text-fg-faint">
															{" "}
															/ {formatBytes(item.memory_limit_bytes)}
														</span>
													</div>
													<Meter
														value={
															item.memory_limit_bytes
																? (item.memory_used_bytes / item.memory_limit_bytes) * 100
																: 0
														}
													/>
												</td>
												<td class="text-[12px] tabular-nums text-fg-muted">
													{formatBytes(item.network_rx_bytes)} /{" "}
													{formatBytes(item.network_tx_bytes)}
												</td>
												<td class="text-[12px] tabular-nums text-fg-muted">
													{formatBytes(item.block_read_bytes)} /{" "}
													{formatBytes(item.block_write_bytes)}
												</td>
												<td class="tabular-nums">{item.pids}</td>
											</tr>
										)}
									</For>
								</tbody>
							</table>
						</div>
					</Show>
				</Card>
			</div>
		</Show>
	);
};

export default ServiceMetrics;
