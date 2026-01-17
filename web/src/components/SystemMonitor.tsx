import { Component, createResource, createSignal, onCleanup, Show } from "solid-js";

interface SystemStats {
  cpu_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  load_avg: [number, number, number];
  uptime_seconds: number;
}

const fetchStats = async (): Promise<SystemStats> => {
  const token = localStorage.getItem("znskr_token");
  const res = await fetch("/api/system/stats", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("failed to fetch stats");
  }
  return res.json();
};

const formatBytes = (bytes: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / Math.pow(1024, idx)).toFixed(1)} ${units[idx]}`;
};

const formatUptime = (seconds: number) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

const ProgressBar: Component<{ value: number; max?: number; color?: string }> = (
  props,
) => {
  const percent = () => Math.min((props.value / (props.max || 100)) * 100, 100);
  return (
    <div class="h-1.5 bg-neutral-200 w-full">
      <div
        class={`h-full transition-all duration-300 ${props.color || "bg-black"}`}
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

  const memPercent = () => {
    const s = stats();
    if (!s || !s.memory_total_bytes) return 0;
    return (s.memory_used_bytes / s.memory_total_bytes) * 100;
  };

  const cpuColor = () => {
    const cpu = stats()?.cpu_percent || 0;
    if (cpu > 80) return "bg-red-500";
    if (cpu > 50) return "bg-yellow-500";
    return "bg-black";
  };

  const memColor = () => {
    const mem = memPercent();
    if (mem > 80) return "bg-red-500";
    if (mem > 50) return "bg-yellow-500";
    return "bg-black";
  };

  return (
    <div class="border border-neutral-200 p-5 mb-8">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-medium text-black">system</h2>
        <Show when={stats()}>
          <span class="text-xs text-neutral-400">
            up {formatUptime(stats()!.uptime_seconds)}
          </span>
        </Show>
      </div>

      <Show
        when={stats()}
        fallback={
          <div class="animate-pulse space-y-3">
            <div class="h-8 bg-neutral-100" />
            <div class="h-8 bg-neutral-100" />
          </div>
        }
      >
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-neutral-500">cpu</span>
              <span class="text-xs font-mono text-neutral-800">
                {stats()!.cpu_percent.toFixed(1)}%
              </span>
            </div>
            <ProgressBar value={stats()!.cpu_percent} color={cpuColor()} />
            <div class="text-xs text-neutral-400 mt-1">
              load: {stats()!.load_avg[0].toFixed(2)},{" "}
              {stats()!.load_avg[1].toFixed(2)}, {stats()!.load_avg[2].toFixed(2)}
            </div>
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-neutral-500">memory</span>
              <span class="text-xs font-mono text-neutral-800">
                {memPercent().toFixed(1)}%
              </span>
            </div>
            <ProgressBar value={memPercent()} color={memColor()} />
            <div class="text-xs text-neutral-400 mt-1">
              {formatBytes(stats()!.memory_used_bytes)} /{" "}
              {formatBytes(stats()!.memory_total_bytes)}
            </div>
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-neutral-500">network rx</span>
              <span class="text-xs font-mono text-neutral-800">
                {formatBytes(networkSpeed().rx)}/s
              </span>
            </div>
            <div class="text-xs text-neutral-400 mt-1">
              total: {formatBytes(stats()!.network_rx_bytes)}
            </div>
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-neutral-500">network tx</span>
              <span class="text-xs font-mono text-neutral-800">
                {formatBytes(networkSpeed().tx)}/s
              </span>
            </div>
            <div class="text-xs text-neutral-400 mt-1">
              total: {formatBytes(stats()!.network_tx_bytes)}
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default SystemMonitor;
