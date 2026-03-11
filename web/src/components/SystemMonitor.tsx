import { type Component, createResource, createSignal, onCleanup, Show } from "solid-js";
import { api, type components } from "../api";
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from "./ui";

type SystemStats = components["schemas"]["SystemStats"];

const fetchStats = async (): Promise<SystemStats | null> => {
	const { data, error, response } = await api.GET("/api/system/stats");
	if (response.status === 403) return null;
	if (error) throw error;
	return data;
};

const formatBytes = (bytes: number) => {
	if (!bytes) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / 1024 ** idx).toFixed(1)} ${units[idx]}`;
};

const formatUptime = (seconds: number) => {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
};

const ProgressBar: Component<{
	value: number;
	max?: number;
	color?: string;
}> = (props) => {
	const percent = () => Math.min((props.value / (props.max || 100)) * 100, 100);
	return (
		<div class="h-1.5 bg-neutral-800 w-full">
			<div
				class={`h-full transition-all duration-300 ${props.color || "bg-purple-500"}`}
				style={{ width: `${percent()}%` }}
			/>
		</div>
	);
};

const SystemMonitor: Component = () => {
	const [stats, { refetch }] = createResource(fetchStats);
	const [prevNetwork, setPrevNetwork] = createSignal<{
		rx: number;
		tx: number;
		time: number;
	} | null>(null);
	const [networkSpeed, setNetworkSpeed] = createSignal({ rx: 0, tx: 0 });

	const interval = setInterval(() => {
		const currentStats = stats();
		if (currentStats === null) return;
		if (currentStats) {
			const prev = prevNetwork();
			const now = Date.now();
			if (prev) {
				const elapsed = (now - prev.time) / 1000;
				if (elapsed > 0) {
					setNetworkSpeed({
						rx: (currentStats.network_rx_bytes - prev.rx) / elapsed,
						tx: (currentStats.network_tx_bytes - prev.tx) / elapsed,
					});
				}
			}
			setPrevNetwork({
				rx: currentStats.network_rx_bytes,
				tx: currentStats.network_tx_bytes,
				time: now,
			});
		}
		refetch();
	}, 2000);

	onCleanup(() => clearInterval(interval));

	if (stats() === null) return null;

	const memPercent = () => {
		const s = stats();
		if (!s || !s.memory_total_bytes) return 0;
		return (s.memory_used_bytes / s.memory_total_bytes) * 100;
	};

	const cpuColor = () => {
		const cpu = stats()?.cpu_percent || 0;
		if (cpu > 80) return "bg-red-500";
		if (cpu > 50) return "bg-yellow-500";
		return "bg-purple-500";
	};

	const memColor = () => {
		const mem = memPercent();
		if (mem > 80) return "bg-red-500";
		if (mem > 50) return "bg-yellow-500";
		return "bg-purple-500";
	};

	return (
		<Card class="mb-8 overflow-hidden">
			<CardHeader class="flex flex-row items-center justify-between gap-4">
				<div>
					<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
						host
					</p>
					<CardTitle class="mt-2">system monitor</CardTitle>
				</div>
				<Show when={stats()}>
					<span class="border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
						up {formatUptime(stats()!.uptime_seconds)}
					</span>
				</Show>
			</CardHeader>

			<CardContent>
				<Show
					when={stats()}
					fallback={
						<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
							<Skeleton class="h-24" />
							<Skeleton class="h-24" />
							<Skeleton class="h-24" />
							<Skeleton class="h-24" />
						</div>
					}
				>
					<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
						<div>
							<div class="mb-4 border border-[var(--border)] bg-[var(--muted)] p-4">
								<div class="mb-1 flex items-center justify-between">
									<span class="text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
										cpu
									</span>
									<span class="text-xs font-mono text-[var(--foreground-subtle)]">
										{stats()!.cpu_percent.toFixed(1)}%
									</span>
								</div>
								<ProgressBar value={stats()!.cpu_percent} color={cpuColor()} />
								<div class="mt-3 text-xs text-[var(--muted-foreground)]">
									load: {stats()!.load_avg[0].toFixed(2)}, {stats()!.load_avg[1].toFixed(2)},{" "}
									{stats()!.load_avg[2].toFixed(2)}
								</div>
							</div>
						</div>

						<div>
							<div class="mb-4 border border-[var(--border)] bg-[var(--muted)] p-4">
								<div class="mb-1 flex items-center justify-between">
									<span class="text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
										memory
									</span>
									<span class="text-xs font-mono text-[var(--foreground-subtle)]">
										{memPercent().toFixed(1)}%
									</span>
								</div>
								<ProgressBar value={memPercent()} color={memColor()} />
								<div class="mt-3 text-xs text-[var(--muted-foreground)]">
									{formatBytes(stats()!.memory_used_bytes)} /{" "}
									{formatBytes(stats()!.memory_total_bytes)}
								</div>
							</div>
						</div>

						<div>
							<div class="mb-4 border border-[var(--border)] bg-[var(--muted)] p-4">
								<div class="mb-1 flex items-center justify-between">
									<span class="text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
										network rx
									</span>
									<span class="text-xs font-mono text-[var(--foreground-subtle)]">
										{formatBytes(networkSpeed().rx)}/s
									</span>
								</div>
								<div class="mt-6 text-xs text-[var(--muted-foreground)]">
									total: {formatBytes(stats()!.network_rx_bytes)}
								</div>
							</div>
						</div>

						<div>
							<div class="mb-4 border border-[var(--border)] bg-[var(--muted)] p-4">
								<div class="mb-1 flex items-center justify-between">
									<span class="text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
										network tx
									</span>
									<span class="text-xs font-mono text-[var(--foreground-subtle)]">
										{formatBytes(networkSpeed().tx)}/s
									</span>
								</div>
								<div class="mt-6 text-xs text-[var(--muted-foreground)]">
									total: {formatBytes(stats()!.network_tx_bytes)}
								</div>
							</div>
						</div>
					</div>
				</Show>
			</CardContent>
		</Card>
	);
};

export default SystemMonitor;
