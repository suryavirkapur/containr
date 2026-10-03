import { A } from "@solidjs/router";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getHostStats, getServiceMetrics, type HostStats } from "../../api/platform";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import { Card, Meter, PageHeader, Skeleton, StatusDot } from "../../components/ui";
import { AreaChart, createRollingSeries } from "../../components/ui/chart";
import { useAppStore } from "../../context/AppStore";
import { formatBytes, formatPercent, formatUptime } from "../../lib/format";
import { ServiceIcon } from "../../lib/services";

const INTERVAL = 3;
const WINDOW = 100;

type Usage = { id: string; cpu: number; memory: number; limit: number };

const Monitoring = () => {
	useBreadcrumbs(() => [{ label: "Monitoring" }]);
	const store = useAppStore();
	const [stats, setStats] = createSignal<HostStats | null>(null);
	const [usage, setUsage] = createSignal<Record<string, Usage>>({});
	const cpu = createRollingSeries(WINDOW);
	const memory = createRollingSeries(WINDOW);
	const rx = createRollingSeries(WINDOW);
	const tx = createRollingSeries(WINDOW);
	const load = createRollingSeries(WINDOW);
	let previous: { at: number; rx: number; tx: number } | null = null;

	const pollHost = async () => {
		try {
			const next = await getHostStats();
			const now = Date.now();
			cpu.push(next.cpu_percent);
			memory.push(
				next.memory_total_bytes ? (next.memory_used_bytes / next.memory_total_bytes) * 100 : 0,
			);
			load.push(next.load_avg[0]);
			if (previous) {
				const seconds = Math.max(1, (now - previous.at) / 1000);
				rx.push(Math.max(0, (next.network_rx_bytes - previous.rx) / seconds));
				tx.push(Math.max(0, (next.network_tx_bytes - previous.tx) / seconds));
			}
			previous = { at: now, rx: next.network_rx_bytes, tx: next.network_tx_bytes };
			setStats(next);
		} catch {
			// keep the last sample
		}
	};

	// per-service usage is slower to collect, so poll it less often
	const pollServices = async () => {
		const running = store.state.services.filter((service) => service.status === "running");
		const results = await Promise.allSettled(
			running.map((service) => getServiceMetrics(service.id)),
		);
		const next: Record<string, Usage> = {};
		results.forEach((result, index) => {
			if (result.status !== "fulfilled") return;
			const containers = result.value.containers;
			next[running[index].id] = {
				id: running[index].id,
				cpu: containers.reduce((sum, item) => sum + item.cpu_percent, 0),
				memory: containers.reduce((sum, item) => sum + item.memory_used_bytes, 0),
				limit: containers.reduce((sum, item) => sum + item.memory_limit_bytes, 0),
			};
		});
		setUsage(next);
	};

	onMount(() => {
		void pollHost();
		void pollServices();
		const host = setInterval(
			() => document.visibilityState === "visible" && void pollHost(),
			INTERVAL * 1000,
		);
		const services = setInterval(
			() => document.visibilityState === "visible" && void pollServices(),
			15000,
		);
		onCleanup(() => {
			clearInterval(host);
			clearInterval(services);
		});
	});

	const ranked = createMemo(() =>
		store.state.services
			.filter((service) => usage()[service.id])
			.sort((a, b) => (usage()[b.id]?.memory ?? 0) - (usage()[a.id]?.memory ?? 0)),
	);

	const diskPercent = () => {
		const value = stats();
		return value?.disk_total_bytes
			? ((value.disk_used_bytes ?? 0) / value.disk_total_bytes) * 100
			: 0;
	};
	const memoryPercent = () => {
		const value = stats();
		return value?.memory_total_bytes
			? (value.memory_used_bytes / value.memory_total_bytes) * 100
			: 0;
	};

	return (
		<div class="animate-fade-in">
			<PageHeader
				title="Monitoring"
				description={`Live server metrics, sampled every ${INTERVAL} seconds while this page is open.`}
			/>
			<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<Card>
					<div class="text-[12.5px] text-fg-subtle">CPU</div>
					<div class="mt-1 text-[22px] font-semibold tabular-nums">
						{stats() ? formatPercent(stats()?.cpu_percent) : "–"}
					</div>
					<div class="text-[12px] text-fg-subtle">
						<Show when={stats()?.cpu_count}>{stats()?.cpu_count} cores · </Show>load{" "}
						{stats()?.load_avg[0].toFixed(2) ?? "–"}
					</div>
				</Card>
				<Card>
					<div class="text-[12.5px] text-fg-subtle">Memory</div>
					<div class="mt-1 text-[22px] font-semibold tabular-nums">
						{stats() ? formatPercent(memoryPercent(), 0) : "–"}
					</div>
					<div class="mb-2 text-[12px] text-fg-subtle">
						{formatBytes(stats()?.memory_used_bytes)} of {formatBytes(stats()?.memory_total_bytes)}
					</div>
					<Meter value={memoryPercent()} />
				</Card>
				<Card>
					<div class="text-[12.5px] text-fg-subtle">Disk</div>
					<div class="mt-1 text-[22px] font-semibold tabular-nums">
						{stats()?.disk_total_bytes ? formatPercent(diskPercent(), 0) : "–"}
					</div>
					<div class="mb-2 text-[12px] text-fg-subtle">
						{formatBytes(stats()?.disk_used_bytes)} of {formatBytes(stats()?.disk_total_bytes)}
					</div>
					<Meter value={diskPercent()} />
				</Card>
				<Card>
					<div class="text-[12.5px] text-fg-subtle">Uptime</div>
					<div class="mt-1 text-[22px] font-semibold tabular-nums">
						{formatUptime(stats()?.uptime_seconds)}
					</div>
					<div class="text-[12px] text-fg-subtle">since last boot</div>
				</Card>
			</div>

			<div class="mt-6 grid gap-6 lg:grid-cols-2">
				<Card title="CPU usage">
					<AreaChart
						series={[{ label: "CPU", color: "var(--chart-1)", values: cpu.values() }]}
						max={100}
						format={(v) => formatPercent(v)}
						interval={INTERVAL}
					/>
				</Card>
				<Card title="Memory usage">
					<AreaChart
						series={[{ label: "Memory", color: "var(--chart-2)", values: memory.values() }]}
						max={100}
						format={(v) => formatPercent(v)}
						interval={INTERVAL}
					/>
				</Card>
				<Card title="Network" description="Bytes per second across all interfaces">
					<AreaChart
						series={[
							{ label: "In", color: "var(--chart-3)", values: rx.values() },
							{ label: "Out", color: "var(--chart-4)", values: tx.values() },
						]}
						format={(v) => `${formatBytes(v)}/s`}
						interval={INTERVAL}
					/>
				</Card>
				<Card title="Load average" description="1-minute">
					<AreaChart
						series={[{ label: "Load", color: "var(--chart-1)", values: load.values() }]}
						format={(v) => v.toFixed(2)}
						interval={INTERVAL}
					/>
				</Card>
			</div>

			<Card
				class="mt-6"
				title="Services by resource use"
				description="Refreshed every 15 seconds"
				flush
			>
				<Show
					when={ranked().length > 0}
					fallback={
						<div class="p-4">
							<Show
								when={store.state.services.some((service) => service.status === "running")}
								fallback={<p class="text-[13px] text-fg-subtle">Nothing is running.</p>}
							>
								<Skeleton class="h-10" />
							</Show>
						</div>
					}
				>
					<div class="overflow-x-auto">
						<table class="table min-w-[640px]">
							<thead>
								<tr>
									<th>Service</th>
									<th class="w-28">CPU</th>
									<th class="w-[260px]">Memory</th>
								</tr>
							</thead>
							<tbody>
								<For each={ranked()}>
									{(service) => {
										const item = () => usage()[service.id];
										return (
											<tr>
												<td>
													<A
														href={`/services/${service.id}/metrics`}
														class="flex items-center gap-2.5 hover:underline"
													>
														<ServiceIcon type={service.service_type} size="sm" />
														<span class="font-medium">{service.name}</span>
														<StatusDot status={service.status} />
													</A>
												</td>
												<td class="tabular-nums">{formatPercent(item()?.cpu)}</td>
												<td>
													<div class="mb-1 text-[12px] tabular-nums">
														{formatBytes(item()?.memory)}
														<Show when={item()?.limit}>
															<span class="text-fg-faint"> / {formatBytes(item()?.limit)}</span>
														</Show>
													</div>
													<Meter
														value={
															item()?.limit
																? ((item()?.memory ?? 0) / (item()?.limit ?? 1)) * 100
																: 0
														}
													/>
												</td>
											</tr>
										);
									}}
								</For>
							</tbody>
						</table>
					</div>
				</Show>
			</Card>
		</div>
	);
};

export default Monitoring;
