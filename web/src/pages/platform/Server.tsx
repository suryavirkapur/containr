import DatabaseBackup from "lucide-solid/icons/database-backup";
import Eraser from "lucide-solid/icons/eraser";
import Server from "lucide-solid/icons/server";
import { createResource, createSignal, For, Show } from "solid-js";
import { errorMessage } from "../../api/http";
import {
	downloadBackup,
	getDiskUsage,
	getHostStats,
	getSystemInfo,
	runCleanup,
} from "../../api/platform";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Badge,
	Button,
	Card,
	DescriptionList,
	Meter,
	Notice,
	PageHeader,
	SettingRow,
	Skeleton,
	Switch,
} from "../../components/ui";
import { confirm, toast } from "../../components/ui/overlay";
import { useAuth } from "../../context/AuthContext";
import { formatBytes, formatNumber, formatUptime } from "../../lib/format";

const ServerPage = () => {
	useBreadcrumbs(() => [{ label: "Server" }]);
	const auth = useAuth();
	const isAdmin = () => Boolean(auth.user()?.is_admin);
	const [info] = createResource(getSystemInfo);
	const [stats] = createResource(() => getHostStats().catch(() => null));
	const [disk, { refetch: refetchDisk }] = createResource(
		() => (isAdmin() ? true : null),
		() => getDiskUsage(),
	);
	const [images, setImages] = createSignal(true);
	const [buildCache, setBuildCache] = createSignal(true);
	const [containers, setContainers] = createSignal(true);
	const [cleaning, setCleaning] = createSignal(false);
	const [backingUp, setBackingUp] = createSignal(false);

	const reclaimable = () => {
		const value = disk();
		if (!value) return 0;
		return (
			(images() ? value.images.reclaimable_bytes : 0) +
			(buildCache() ? value.build_cache.reclaimable_bytes : 0) +
			(containers() ? value.containers.reclaimable_bytes : 0)
		);
	};

	const cleanup = async () => {
		const ok = await confirm({
			title: "Clean up disk space?",
			description:
				"Unused images, build cache and stopped containers created by containr are removed. Volumes and running services are never touched. The next build of each service may be slower.",
			confirmLabel: "Clean up",
		});
		if (!ok) return;
		setCleaning(true);
		try {
			const result = await runCleanup({
				images: images(),
				build_cache: buildCache(),
				containers: containers(),
			});
			toast.success(
				`Freed ${formatBytes(result.reclaimed_bytes)}`,
				`${result.images_deleted} images removed`,
			);
			void refetchDisk();
		} catch (error) {
			toast.error("Cleanup failed", error);
		} finally {
			setCleaning(false);
		}
	};

	const backup = async () => {
		setBackingUp(true);
		try {
			await downloadBackup();
			toast.success("Backup downloaded");
		} catch (error) {
			toast.error("Backup failed", error);
		} finally {
			setBackingUp(false);
		}
	};

	const diskRows = () => {
		const value = disk();
		if (!value) return [];
		return [
			{ label: "Images", bucket: value.images },
			{ label: "Containers", bucket: value.containers },
			{ label: "Volumes", bucket: value.volumes },
			{ label: "Build cache", bucket: value.build_cache },
		];
	};

	return (
		<div class="animate-fade-in">
			<PageHeader
				title="Server"
				description="The machine running containr, its Docker engine and maintenance tools."
			/>
			<div class="grid gap-6 lg:grid-cols-[1fr_360px]">
				<div class="space-y-6">
					<Card
						title={
							<span class="flex items-center gap-2">
								<Server width={15} height={15} class="text-fg-subtle" />
								{info()?.hostname ?? "This server"}
							</span>
						}
						actions={<Badge tone="success">Online</Badge>}
					>
						<Show
							when={info()}
							fallback={
								info.error ? (
									<Notice tone="danger">{errorMessage(info.error)}</Notice>
								) : (
									<Skeleton class="h-40" />
								)
							}
						>
							{(value) => (
								<DescriptionList
									class="-my-2.5"
									items={[
										{ label: "containr", value: value().version, mono: true },
										{ label: "Operating system", value: value().os },
										{ label: "Kernel", value: value().kernel, mono: true },
										{ label: "Docker", value: value().docker_version, mono: true },
										{ label: "CPU cores", value: formatNumber(stats()?.cpu_count) },
										{ label: "Memory", value: formatBytes(stats()?.memory_total_bytes) },
										{ label: "Uptime", value: formatUptime(stats()?.uptime_seconds) },
										{
											label: "Containers",
											value: `${value().containers_running} running · ${value().containers_total} total`,
										},
										{ label: "Images", value: formatNumber(value().images) },
										{
											label: "Root domain",
											value: value().base_domain || "Not set",
											mono: Boolean(value().base_domain),
										},
										{
											label: "Public IP",
											value: value().public_ip ?? "Not set",
											mono: Boolean(value().public_ip),
										},
									]}
								/>
							)}
						</Show>
					</Card>

					<Show when={isAdmin()}>
						<Card
							title="Disk usage"
							description="Space used by Docker on this server."
							actions={
								<Button variant="ghost" size="sm" onClick={() => void refetchDisk()}>
									Refresh
								</Button>
							}
							flush
						>
							<Show
								when={disk()}
								fallback={
									<div class="p-4">
										{disk.error ? (
											<Notice tone="danger">{errorMessage(disk.error)}</Notice>
										) : (
											<Skeleton class="h-32" />
										)}
									</div>
								}
							>
								<table class="table">
									<thead>
										<tr>
											<th>Type</th>
											<th>Count</th>
											<th>Size</th>
											<th class="w-[240px]">Reclaimable</th>
										</tr>
									</thead>
									<tbody>
										<For each={diskRows()}>
											{(row) => (
												<tr>
													<td class="font-medium">{row.label}</td>
													<td class="tabular-nums text-fg-muted">
														{formatNumber(row.bucket.count)}
													</td>
													<td class="tabular-nums">{formatBytes(row.bucket.size_bytes)}</td>
													<td>
														<div class="mb-1 text-[12px] tabular-nums text-fg-muted">
															{formatBytes(row.bucket.reclaimable_bytes)}
														</div>
														<Meter
															tone="warning"
															value={
																row.bucket.size_bytes
																	? (row.bucket.reclaimable_bytes / row.bucket.size_bytes) * 100
																	: 0
															}
														/>
													</td>
												</tr>
											)}
										</For>
									</tbody>
								</table>
							</Show>
						</Card>
					</Show>
				</div>

				<div class="space-y-6">
					<Show
						when={isAdmin()}
						fallback={<Notice>Maintenance tools are available to administrators.</Notice>}
					>
						<Card
							title="Disk cleanup"
							description="Free space taken by things no service uses anymore."
						>
							<div class="-my-4 divide-y divide-border">
								<SettingRow
									title="Unused images"
									description="Old builds and pulled images no container uses."
								>
									<Switch checked={images()} onChange={setImages} label="Unused images" />
								</SettingRow>
								<SettingRow
									title="Build cache"
									description="Docker layer cache from previous builds."
								>
									<Switch checked={buildCache()} onChange={setBuildCache} label="Build cache" />
								</SettingRow>
								<SettingRow
									title="Stopped containers"
									description="Leftovers from finished cron runs and old deploys."
								>
									<Switch
										checked={containers()}
										onChange={setContainers}
										label="Stopped containers"
									/>
								</SettingRow>
							</div>
							<div class="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
								<span class="text-[12.5px] text-fg-subtle">
									<Show when={disk()} fallback="Estimating…">
										About <span class="font-medium text-fg">{formatBytes(reclaimable())}</span> can
										be freed
									</Show>
								</span>
								<Button
									variant="primary"
									loading={cleaning()}
									disabled={!images() && !buildCache() && !containers()}
									onClick={() => void cleanup()}
								>
									<Eraser />
									Clean up
								</Button>
							</div>
						</Card>

						<Card
							title="Backup"
							description="Download a consistent snapshot of containr's database: services, settings, deployments and users."
						>
							<Notice class="mb-4">
								Volume data (databases, uploads) lives on disk under the storage directory. Back it
								up with your usual server backups.
							</Notice>
							<Button
								variant="secondary"
								class="w-full"
								loading={backingUp()}
								onClick={() => void backup()}
							>
								<DatabaseBackup />
								Download backup
							</Button>
						</Card>

						<Card title="Cluster">
							<p class="text-[13px] text-fg-subtle">
								containr runs everything on this single server. To scale out, run another containr
								server and point a domain at each one.
							</p>
						</Card>
					</Show>
				</div>
			</div>
		</div>
	);
};

export default ServerPage;
