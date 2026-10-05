import { A } from "@solidjs/router";
import ArrowUpRight from "lucide-solid/icons/arrow-up-right";
import Boxes from "lucide-solid/icons/boxes";
import Check from "lucide-solid/icons/check";
import Cpu from "lucide-solid/icons/cpu";
import Database from "lucide-solid/icons/database";
import GitBranch from "lucide-solid/icons/git-branch";
import HardDrive from "lucide-solid/icons/hard-drive";
import MemoryStick from "lucide-solid/icons/memory-stick";
import Package from "lucide-solid/icons/package";
import Plus from "lucide-solid/icons/plus";
import Store from "lucide-solid/icons/store";
import {
	type Component,
	createMemo,
	createResource,
	createSignal,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { getHostStats, getSystemInfo, type HostStats } from "../api/platform";
import { getGithubAppStatus, getSettings } from "../api/settings";
import { useBreadcrumbs } from "../components/layout/breadcrumbs";
import {
	Card,
	cx,
	EmptyState,
	LinkButton,
	Meter,
	PageHeader,
	Skeleton,
	StatusBadge,
} from "../components/ui";
import { createRollingSeries, Sparkline } from "../components/ui/chart";
import { useAppStore } from "../context/AppStore";
import { useAuth } from "../context/AuthContext";
import { formatBytes, formatPercent, formatUptime, timeAgo } from "../lib/format";
import { displayHost, primaryUrl, publicPorts, ServiceIcon, typeLabel } from "../lib/services";

const StatCard: Component<{
	label: string;
	icon: JSX.Element;
	value: JSX.Element;
	sub?: JSX.Element;
	children?: JSX.Element;
}> = (props) => (
	<div class="card flex flex-col p-4">
		<div class="flex items-center justify-between text-[12.5px] text-fg-subtle">
			<span>{props.label}</span>
			<span class="[&>svg]:h-4 [&>svg]:w-4">{props.icon}</span>
		</div>
		<div class="mt-2 text-[24px] font-semibold tracking-[-0.02em] tabular-nums">{props.value}</div>
		<Show when={props.sub}>
			<div class="mt-0.5 text-[12px] text-fg-subtle">{props.sub}</div>
		</Show>
		<Show when={props.children}>
			<div class="mt-auto pt-3">{props.children}</div>
		</Show>
	</div>
);

const QuickAction: Component<{
	href: string;
	icon: JSX.Element;
	title: string;
	description: string;
}> = (props) => (
	<A href={props.href} class="card card-interactive group flex items-start gap-3 p-4">
		<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-muted [&>svg]:h-[18px] [&>svg]:w-[18px]">
			{props.icon}
		</span>
		<span class="min-w-0">
			<span class="flex items-center gap-1 text-[13.5px] font-medium">
				{props.title}
				<ArrowUpRight
					width={14}
					height={14}
					class="text-fg-faint opacity-0 transition-opacity group-hover:opacity-100"
				/>
			</span>
			<span class="mt-0.5 block text-[12.5px] text-fg-subtle">{props.description}</span>
		</span>
	</A>
);

const Overview = () => {
	useBreadcrumbs(() => [{ label: "Overview" }]);
	const auth = useAuth();
	const store = useAppStore();
	const [stats, setStats] = createSignal<HostStats | null>(null);
	const cpu = createRollingSeries(40);
	const memory = createRollingSeries(40);

	const [settings] = createResource(() => getSettings().catch(() => null));
	const [github] = createResource(() =>
		auth.user()?.is_admin ? getGithubAppStatus().catch(() => null) : null,
	);
	const [info] = createResource(() => getSystemInfo().catch(() => null));

	onMount(() => {
		const poll = async () => {
			try {
				const next = await getHostStats();
				setStats(next);
				cpu.push(next.cpu_percent);
				memory.push(
					next.memory_total_bytes ? (next.memory_used_bytes / next.memory_total_bytes) * 100 : 0,
				);
			} catch {
				// keep the last sample; the card shows a placeholder until data arrives
			}
		};
		void poll();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void poll();
		}, 3000);
		onCleanup(() => clearInterval(timer));
	});

	const services = () => store.state.services;
	const running = createMemo(
		() => services().filter((service) => service.status === "running").length,
	);
	const failing = createMemo(
		() => services().filter((service) => service.status === "failed").length,
	);
	const recent = createMemo(() =>
		[...services()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 7),
	);

	const memPercent = () => {
		const value = stats();
		return value?.memory_total_bytes
			? (value.memory_used_bytes / value.memory_total_bytes) * 100
			: 0;
	};
	const diskPercent = () => {
		const value = stats();
		return value?.disk_total_bytes
			? ((value.disk_used_bytes ?? 0) / value.disk_total_bytes) * 100
			: 0;
	};

	const checklist = createMemo(() => {
		const current = settings();
		const domain = current?.base_domain ?? "";
		return [
			{
				done: Boolean(domain) && domain !== "localhost" && !domain.endsWith(".local"),
				title: "Set a root domain",
				description: "Every service gets a subdomain of it automatically.",
				href: "/settings",
			},
			{
				done: Boolean(current?.dashboard_url?.startsWith("https://")),
				title: "Secure the dashboard with HTTPS",
				description: "Issue a Let's Encrypt certificate for this control panel.",
				href: "/settings",
			},
			{
				done: auth.user()?.is_admin ? Boolean(github()?.configured) : true,
				title: "Connect GitHub",
				description: "Deploy from private repositories and on every push.",
				href: "/settings/github",
			},
			{
				done: services().length > 0,
				title: "Deploy your first service",
				description: "From a Git repository, a Docker image or a one-click app.",
				href: "/new",
			},
		];
	});
	const remaining = () => checklist().filter((item) => !item.done).length;

	return (
		<div class="animate-fade-in">
			<PageHeader
				title="Overview"
				description={
					<Show when={info()} fallback="Everything running on this server at a glance.">
						{(value) => (
							<>
								{value().hostname ?? "This server"}
								<Show
									when={value().docker_version}
									fallback={<span class="text-warning"> · Docker is not responding</span>}
								>
									{" "}
									· Docker {value().docker_version}
								</Show>
								<Show when={stats()?.uptime_seconds}>
									{" "}
									· up {formatUptime(stats()?.uptime_seconds)}
								</Show>
							</>
						)}
					</Show>
				}
				actions={
					<LinkButton href="/new" variant="primary">
						<Plus />
						New service
					</LinkButton>
				}
			/>

			<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<StatCard
					label="Services"
					icon={<Boxes />}
					value={
						<Show when={store.loaded()} fallback={<Skeleton class="h-7 w-16" />}>
							{running()}
							<span class="text-[15px] font-normal text-fg-subtle">
								{" "}
								/ {services().length} running
							</span>
						</Show>
					}
					sub={
						<Show when={failing() > 0} fallback="All healthy">
							<span class="text-danger">{failing()} failing</span>
						</Show>
					}
				/>
				<StatCard
					label="CPU"
					icon={<Cpu />}
					value={
						<Show when={stats()} fallback={<Skeleton class="h-7 w-20" />}>
							{formatPercent(stats()?.cpu_percent)}
						</Show>
					}
					sub={
						<Show when={stats()}>
							load{" "}
							{stats()
								?.load_avg.map((value) => value.toFixed(2))
								.join(" · ")}
						</Show>
					}
				>
					<Sparkline values={cpu.values()} max={100} color="var(--chart-1)" />
				</StatCard>
				<StatCard
					label="Memory"
					icon={<MemoryStick />}
					value={
						<Show when={stats()} fallback={<Skeleton class="h-7 w-20" />}>
							<Show
								when={stats()?.memory_total_bytes}
								fallback={<span class="text-fg-faint">–</span>}
							>
								{formatPercent(memPercent(), 0)}
							</Show>
						</Show>
					}
					sub={
						<Show
							when={stats()?.memory_total_bytes}
							fallback={stats() ? "Unavailable on this OS" : undefined}
						>
							{formatBytes(stats()?.memory_used_bytes)} of{" "}
							{formatBytes(stats()?.memory_total_bytes)}
						</Show>
					}
				>
					<Sparkline values={memory.values()} max={100} color="var(--chart-2)" />
				</StatCard>
				<StatCard
					label="Disk"
					icon={<HardDrive />}
					value={
						<Show when={stats()?.disk_total_bytes} fallback={<span class="text-fg-faint">–</span>}>
							{formatPercent(diskPercent(), 0)}
						</Show>
					}
					sub={
						<Show when={stats()?.disk_total_bytes} fallback="Disk usage unavailable">
							{formatBytes(stats()?.disk_used_bytes)} of {formatBytes(stats()?.disk_total_bytes)}
						</Show>
					}
				>
					<Meter value={diskPercent()} />
				</StatCard>
			</div>

			<div class="mt-6 grid gap-6 xl:grid-cols-[1fr_360px]">
				<Card
					title="Services"
					description="Recently updated across all projects"
					flush
					actions={
						<LinkButton href="/services" variant="ghost" size="sm">
							View all
						</LinkButton>
					}
				>
					<Show
						when={store.loaded()}
						fallback={
							<div class="space-y-3 p-4">
								<Skeleton class="h-10" />
								<Skeleton class="h-10" />
								<Skeleton class="h-10" />
							</div>
						}
					>
						<Show
							when={recent().length > 0}
							fallback={
								<div class="p-4">
									<EmptyState
										icon={<Boxes />}
										title="No services yet"
										description="Deploy from Git, a Docker image, or pick a one-click app."
									>
										<LinkButton href="/new" variant="primary">
											<Plus />
											New service
										</LinkButton>
										<LinkButton href="/apps">Browse apps</LinkButton>
									</EmptyState>
								</div>
							}
						>
							<ul class="divide-y divide-border">
								<For each={recent()}>
									{(service) => (
										<li>
											<A
												href={`/services/${service.id}`}
												class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover"
											>
												<ServiceIcon type={service.service_type} />
												<div class="min-w-0 flex-1">
													<div class="truncate text-[13.5px] font-medium">{service.name}</div>
													<div class="truncate text-[12px] text-fg-subtle">
														{service.project_name ? `${service.project_name} · ` : ""}
														{typeLabel(service.service_type)}
														<Show when={primaryUrl(service)}>
															{(url) => <> · {displayHost(url())}</>}
														</Show>
														<Show when={!primaryUrl(service) && publicPorts(service).length > 0}>
															<span class="text-warning">
																{" "}
																· public TCP {publicPorts(service).join(", ")}
															</span>
														</Show>
													</div>
												</div>
												<span class="hidden text-[12px] text-fg-faint sm:block">
													{timeAgo(service.updated_at)}
												</span>
												<StatusBadge status={service.status} />
											</A>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</Show>
				</Card>

				<div class="space-y-6">
					<Show when={remaining() > 0}>
						<Card
							title="Get set up"
							description={`${checklist().length - remaining()} of ${checklist().length} done`}
						>
							<ol class="-my-1 space-y-1">
								<For each={checklist()}>
									{(item) => (
										<li>
											<A
												href={item.href}
												class={cx(
													"flex items-start gap-3 rounded-md p-2 transition-colors hover:bg-surface-hover",
													item.done && "opacity-60",
												)}
											>
												<span
													class={cx(
														"mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border",
														item.done
															? "border-success bg-success text-white"
															: "border-border-strong",
													)}
												>
													<Show when={item.done}>
														<Check width={11} height={11} stroke-width={3} />
													</Show>
												</span>
												<span>
													<span
														class={cx("block text-[13px] font-medium", item.done && "line-through")}
													>
														{item.title}
													</span>
													<span class="block text-[12px] text-fg-subtle">{item.description}</span>
												</span>
											</A>
										</li>
									)}
								</For>
							</ol>
						</Card>
					</Show>

					<div>
						<h2 class="mb-3 text-[13px] font-medium text-fg-subtle">Quick start</h2>
						<div class="grid gap-3">
							<QuickAction
								href="/new/git"
								icon={<GitBranch />}
								title="Deploy from Git"
								description="Build any repository with a Dockerfile."
							/>
							<QuickAction
								href="/new/image"
								icon={<Package />}
								title="Run a Docker image"
								description="Deploy straight from Docker Hub or a private registry."
							/>
							<QuickAction
								href="/apps"
								icon={<Store />}
								title="One-click apps"
								description="WordPress, Ghost, n8n, Uptime Kuma and more."
							/>
							<QuickAction
								href="/new/database"
								icon={<Database />}
								title="Create a database"
								description="PostgreSQL, MariaDB, Redis, Qdrant or RabbitMQ."
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

export default Overview;
