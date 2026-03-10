import { A } from "@solidjs/router";
import {
	Component,
	createMemo,
	createResource,
	createSignal,
	For,
	Show,
} from "solid-js";

import SystemMonitor from "../components/SystemMonitor";
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
	Input,
	PageHeader,
	Skeleton,
	Tabs,
	TabsList,
	TabsTrigger,
} from "../components/ui";

type FilterTab = "all" | "app" | "managed" | "public";

interface ServiceInventoryItem {
	id: string;
	group_id?: string | null;
	project_id?: string | null;
	project_name?: string | null;
	resource_kind: string;
	service_type: string;
	name: string;
	image?: string | null;
	status: string;
	network_name: string;
	internal_host?: string | null;
	port?: number | null;
	external_port?: number | null;
	proxy_port?: number | null;
	proxy_external_port?: number | null;
	public_ip?: string | null;
	connection_string?: string | null;
	proxy_connection_string?: string | null;
	domains: string[];
	default_urls: string[];
	schedule?: string | null;
	public_http: boolean;
	desired_instances: number;
	running_instances: number;
	deployment_id?: string | null;
	container_ids: string[];
	pitr_enabled: boolean;
	proxy_enabled: boolean;
	created_at: string;
	updated_at: string;
}

interface QuickAction {
	title: string;
	description: string;
	href: string;
	label: string;
	type: string;
}

interface ServiceGroup {
	key: string;
	label: string;
	project_id?: string | null;
	network_name: string;
	services: ServiceInventoryItem[];
	is_standalone: boolean;
	public_count: number;
	updated_at: string;
}

const appQuickActions: QuickAction[] = [
	{
		title: "web service",
		description: "public http and grpc entrypoint with default routing.",
		href: "/projects/new?kind=app&service_type=web_service",
		label: "new web service",
		type: "web_service",
	},
	{
		title: "private service",
		description: "internal-only service for east-west traffic in a group.",
		href: "/projects/new?kind=app&service_type=private_service",
		label: "new private service",
		type: "private_service",
	},
	{
		title: "background worker",
		description: "long-running job consumer without public ingress.",
		href: "/projects/new?kind=app&service_type=background_worker",
		label: "new worker",
		type: "background_worker",
	},
	{
		title: "cron job",
		description: "scheduled container for timed tasks and maintenance.",
		href: "/projects/new?kind=app&service_type=cron_job",
		label: "new cron job",
		type: "cron_job",
	},
];

const managedQuickActions: QuickAction[] = [
	{
		title: "containr postgres",
		description: "managed postgres with pgdog and optional pitr.",
		href: "/projects/new?kind=database&type=postgresql",
		label: "create postgres",
		type: "postgres",
	},
	{
		title: "containr valkey",
		description: "redis-compatible valkey for cache and queue workloads.",
		href: "/projects/new?kind=database&type=redis",
		label: "create valkey",
		type: "redis",
	},
	{
		title: "containr mariadb",
		description: "mysql-compatible mariadb with direct public port support.",
		href: "/projects/new?kind=database&type=mariadb",
		label: "create mariadb",
		type: "mariadb",
	},
	{
		title: "containr qdrant",
		description: "vector storage with direct http access when exposed.",
		href: "/projects/new?kind=database&type=qdrant",
		label: "create qdrant",
		type: "qdrant",
	},
	{
		title: "rabbitmq",
		description: "managed rabbitmq broker with direct connection details.",
		href: "/projects/new?kind=queue&type=rabbitmq",
		label: "create rabbitmq",
		type: "rabbitmq",
	},
];

const buildAuthHeaders = (): Headers => {
	const headers = new Headers();
	const token = localStorage.getItem("containr_token");

	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}

	return headers;
};

const handleUnauthorized = (response: Response) => {
	if (response.status !== 401) {
		return;
	}

	localStorage.removeItem("containr_token");
	window.location.href = "/login";
};

const readErrorMessage = async (response: Response): Promise<string> => {
	try {
		const data = (await response.json()) as { error?: string };
		if (typeof data.error === "string" && data.error.trim()) {
			return data.error;
		}
	} catch {
		// ignore malformed json and use the fallback message below
	}

	return `request failed with status ${response.status}`;
};

const fetchServices = async (): Promise<ServiceInventoryItem[]> => {
	const response = await fetch("/api/services", {
		headers: buildAuthHeaders(),
	});

	handleUnauthorized(response);
	if (!response.ok) {
		throw new Error(await readErrorMessage(response));
	}

	return (await response.json()) as ServiceInventoryItem[];
};

const timeAgo = (dateStr: string): string => {
	const date = new Date(dateStr);
	const now = new Date();
	const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	const years = Math.floor(days / 365);
	return `${years}y ago`;
};

const isManagedService = (service: ServiceInventoryItem): boolean =>
	service.resource_kind !== "app_service";

const hasPublicExposure = (service: ServiceInventoryItem): boolean =>
	service.public_http ||
	service.default_urls.length > 0 ||
	(service.external_port !== null && service.external_port !== undefined) ||
	(service.proxy_external_port !== null &&
		service.proxy_external_port !== undefined);

const serviceTypeLabel = (serviceType: string): string => {
	switch (serviceType) {
		case "web_service":
			return "web service";
		case "private_service":
			return "private service";
		case "background_worker":
			return "background worker";
		case "cron_job":
			return "cron job";
		case "postgres":
			return "containr postgres";
		case "redis":
			return "containr valkey";
		case "mariadb":
			return "containr mariadb";
		case "qdrant":
			return "containr qdrant";
		case "rabbitmq":
			return "rabbitmq";
		default:
			return serviceType.replaceAll("_", " ");
	}
};

const serviceDetailHref = (service: ServiceInventoryItem): string => {
	if (service.resource_kind === "managed_database") {
		return `/databases/${service.id}`;
	}

	if (service.resource_kind === "managed_queue") {
		return `/queues/${service.id}`;
	}

	if (service.project_id) {
		return `/projects/${service.project_id}`;
	}

	return "/projects";
};

const serviceEndpointLabel = (service: ServiceInventoryItem): string => {
	if (service.default_urls.length > 0) {
		return service.default_urls[0];
	}

	if (
		service.proxy_external_port &&
		service.public_ip &&
		service.proxy_enabled
	) {
		return `${service.public_ip}:${service.proxy_external_port}`;
	}

	if (service.external_port && service.public_ip) {
		return `${service.public_ip}:${service.external_port}`;
	}

	if (service.internal_host && service.port) {
		return `${service.internal_host}:${service.port}`;
	}

	if (service.schedule?.trim()) {
		return service.schedule.trim();
	}

	return "internal only";
};

const serviceActivityLabel = (service: ServiceInventoryItem): string => {
	if (service.schedule?.trim()) {
		return `schedule ${service.schedule.trim()}`;
	}

	if (service.desired_instances <= 1) {
		return service.running_instances > 0 ? "1 instance running" : "not running";
	}

	return `${service.running_instances}/${service.desired_instances} instances`;
};

const statusVariant = (
	status: string,
): "success" | "warning" | "error" | "outline" => {
	switch (status) {
		case "running":
			return "success";
		case "starting":
		case "partial":
			return "warning";
		case "failed":
			return "error";
		default:
			return "outline";
	}
};

const groupLabel = (service: ServiceInventoryItem): string => {
	if (service.project_name?.trim()) {
		return service.project_name.trim();
	}

	return `standalone ${service.name}`;
};

const groupKey = (service: ServiceInventoryItem): string =>
	service.project_id ||
	service.group_id ||
	`standalone:${service.network_name}:${service.id}`;

const ServiceIcon: Component<{ type: string }> = (props) => {
	const iconPath = () => {
		switch (props.type) {
			case "web_service":
				return "M4 5h16v14H4zm3 3v8h10V8zm11 0h2v8h-2z";
			case "private_service":
				return "M17 10V7a5 5 0 10-10 0v3H5v11h14V10zm-8 0V7a3 3 0 116 0v3z";
			case "background_worker":
				return "M10 4h4l1 2h3v4l2 2-2 2v4h-3l-1 2h-4l-1-2H6v-4l-2-2 2-2V6h3z";
			case "cron_job":
				return "M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z";
			case "postgres":
				return "M12 3C7 3 4 5 4 8v8c0 3 3 5 8 5s8-2 8-5V8c0-3-3-5-8-5zm0 2c3.9 0 6 1.5 6 3s-2.1 3-6 3-6-1.5-6-3 2.1-3 6-3zm0 14c-3.9 0-6-1.5-6-3v-2c1.5 1.3 3.9 2 6 2s4.5-.7 6-2v2c0 1.5-2.1 3-6 3z";
			case "redis":
				return "M5 7l7-3 7 3-7 3zm0 5l7 3 7-3m-14 5l7 3 7-3";
			case "mariadb":
				return "M4 6h16v12H4zm3 3h10m-10 3h7";
			case "qdrant":
				return "M12 3l7 4v10l-7 4-7-4V7zm0 5.5A2.5 2.5 0 109.5 11 2.5 2.5 0 0012 8.5z";
			case "rabbitmq":
				return "M6 8h12v8H6zm2-3h8v3H8zm2 6h4v2h-4z";
			default:
				return "M12 3l8 4v10l-8 4-8-4V7z";
		}
	};

	return (
		<div class="flex h-11 w-11 items-center justify-center border border-[var(--border)] bg-[var(--muted)]">
			<svg
				class="h-5 w-5 text-[var(--muted-foreground)]"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d={iconPath()} />
			</svg>
		</div>
	);
};

const Dashboard: Component = () => {
	const [services, { refetch }] = createResource(fetchServices);
	const [filter, setFilter] = createSignal<FilterTab>("all");
	const [search, setSearch] = createSignal("");
	const [pendingServiceId, setPendingServiceId] = createSignal<string | null>(
		null,
	);
	const [actionError, setActionError] = createSignal("");

	const summary = createMemo(() => {
		const rows = services() || [];
		const groupKeys = new Set(rows.map(groupKey));

		return {
			all: rows.length,
			app: rows.filter((service) => service.resource_kind === "app_service")
				.length,
			managed: rows.filter(isManagedService).length,
			public: rows.filter(hasPublicExposure).length,
			groups: groupKeys.size,
		};
	});

	const filteredServices = createMemo(() => {
		let rows = [...(services() || [])].sort(
			(left, right) =>
				new Date(right.updated_at).getTime() -
				new Date(left.updated_at).getTime(),
		);
		const query = search().toLowerCase().trim();

		if (filter() === "app") {
			rows = rows.filter((service) => service.resource_kind === "app_service");
		}

		if (filter() === "managed") {
			rows = rows.filter(isManagedService);
		}

		if (filter() === "public") {
			rows = rows.filter(hasPublicExposure);
		}

		if (!query) {
			return rows;
		}

		return rows.filter((service) => {
			const haystacks = [
				service.name,
				service.project_name || "",
				service.service_type,
				service.network_name,
				service.internal_host || "",
			];

			return haystacks.some((value) => value.toLowerCase().includes(query));
		});
	});

	const groupedServices = createMemo(() => {
		const groups = new Map<string, ServiceGroup>();

		for (const service of filteredServices()) {
			const key = groupKey(service);
			const existing = groups.get(key);
			if (existing) {
				existing.services.push(service);
				existing.public_count += hasPublicExposure(service) ? 1 : 0;
				if (
					new Date(service.updated_at).getTime() >
					new Date(existing.updated_at).getTime()
				) {
					existing.updated_at = service.updated_at;
				}
				continue;
			}

			groups.set(key, {
				key,
				label: groupLabel(service),
				project_id: service.project_id,
				network_name: service.network_name,
				services: [service],
				is_standalone: !service.project_id && !service.group_id,
				public_count: hasPublicExposure(service) ? 1 : 0,
				updated_at: service.updated_at,
			});
		}

		return Array.from(groups.values())
			.map((group) => ({
				...group,
				services: [...group.services].sort(
					(left, right) =>
						new Date(right.updated_at).getTime() -
						new Date(left.updated_at).getTime(),
				),
			}))
			.sort((left, right) => {
				if (left.is_standalone !== right.is_standalone) {
					return left.is_standalone ? 1 : -1;
				}

				return (
					new Date(right.updated_at).getTime() -
					new Date(left.updated_at).getTime()
				);
			});
	});

	const restartService = async (service: ServiceInventoryItem) => {
		setPendingServiceId(service.id);
		setActionError("");

		try {
			const response = await fetch(`/api/services/${service.id}/restart`, {
				method: "POST",
				headers: buildAuthHeaders(),
			});

			handleUnauthorized(response);
			if (!response.ok) {
				throw new Error(await readErrorMessage(response));
			}

			await refetch();
		} catch (error) {
			if (error instanceof Error) {
				setActionError(error.message);
			} else {
				setActionError("failed to restart service");
			}
		} finally {
			setPendingServiceId(null);
		}
	};

	return (
		<div class="space-y-8">
			<PageHeader
				eyebrow="control plane"
				title="services"
				description="create services from one screen, see them grouped by
their network boundary, and restart any service directly from the inventory."
				actions={
					<A href="/projects/new">
						<Button>new service</Button>
					</A>
				}
			/>

			<Card>
				<CardHeader class="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
					<div>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							launch
						</p>
						<CardTitle class="mt-2">create a service</CardTitle>
						<CardDescription>
							every service type now starts from the same full-page creation
							flow instead of separate modal screens.
						</CardDescription>
					</div>
					<Badge variant="outline">{summary().all} services tracked</Badge>
				</CardHeader>
				<CardContent class="grid gap-6 xl:grid-cols-2">
					<div class="space-y-4">
						<div class="flex items-center justify-between gap-4">
							<div>
								<p class="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--muted-foreground)]">
									application services
								</p>
								<p class="mt-2 text-sm text-[var(--muted-foreground)]">
									create a new group and its first runtime container.
								</p>
							</div>
							<Badge variant="secondary">{summary().app}</Badge>
						</div>
						<div class="grid gap-3 md:grid-cols-2">
							<For each={appQuickActions}>
								{(action) => (
									<A href={action.href} class="block">
										<Card variant="hover" class="h-full">
											<CardContent class="flex h-full flex-col justify-between gap-5">
												<div class="space-y-4">
													<div class="flex items-start justify-between gap-3">
														<ServiceIcon type={action.type} />
														<Badge variant="outline">app</Badge>
													</div>
													<div class="space-y-2">
														<p class="font-serif text-xl text-[var(--foreground)]">
															{action.title}
														</p>
														<p class="text-sm leading-6 text-[var(--muted-foreground)]">
															{action.description}
														</p>
													</div>
												</div>
												<p class="text-sm font-medium text-[var(--foreground)]">
													{action.label}
												</p>
											</CardContent>
										</Card>
									</A>
								)}
							</For>
						</div>
					</div>

					<div class="space-y-4">
						<div class="flex items-center justify-between gap-4">
							<div>
								<p class="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--muted-foreground)]">
									managed services
								</p>
								<p class="mt-2 text-sm text-[var(--muted-foreground)]">
									use the same creation page and attach the service to an
									existing group or keep it standalone.
								</p>
							</div>
							<Badge variant="secondary">{summary().managed}</Badge>
						</div>
						<div class="grid gap-3 md:grid-cols-2">
							<For each={managedQuickActions}>
								{(action) => (
									<A href={action.href} class="block">
										<Card variant="hover" class="h-full">
											<CardContent class="flex h-full flex-col justify-between gap-5">
												<div class="space-y-4">
													<div class="flex items-start justify-between gap-3">
														<ServiceIcon type={action.type} />
														<Badge variant="outline">managed</Badge>
													</div>
													<div class="space-y-2">
														<p class="font-serif text-xl text-[var(--foreground)]">
															{action.title}
														</p>
														<p class="text-sm leading-6 text-[var(--muted-foreground)]">
															{action.description}
														</p>
													</div>
												</div>
												<p class="text-sm font-medium text-[var(--foreground)]">
													{action.label}
												</p>
											</CardContent>
										</Card>
									</A>
								)}
							</For>
						</div>
					</div>
				</CardContent>
			</Card>

			<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
				<Card>
					<CardContent class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
							total services
						</p>
						<p class="font-serif text-4xl text-[var(--foreground)]">
							{summary().all}
						</p>
						<p class="text-sm text-[var(--muted-foreground)]">
							across {summary().groups} groups or standalone networks
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
							application services
						</p>
						<p class="font-serif text-4xl text-[var(--foreground)]">
							{summary().app}
						</p>
						<p class="text-sm text-[var(--muted-foreground)]">
							web, private, worker, and cron containers
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
							managed services
						</p>
						<p class="font-serif text-4xl text-[var(--foreground)]">
							{summary().managed}
						</p>
						<p class="text-sm text-[var(--muted-foreground)]">
							postgres, valkey, mariadb, qdrant, and rabbitmq
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
							public exposure
						</p>
						<p class="font-serif text-4xl text-[var(--foreground)]">
							{summary().public}
						</p>
						<p class="text-sm text-[var(--muted-foreground)]">
							services with a public url or public port
						</p>
					</CardContent>
				</Card>
			</div>

			<SystemMonitor />

			<Card>
				<CardHeader class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
					<div>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							inventory
						</p>
						<CardTitle class="mt-2">services grouped by group</CardTitle>
						<CardDescription>
							each section matches the group network boundary. standalone
							services stay isolated in their own section.
						</CardDescription>
					</div>
					<div class="flex w-full flex-col gap-4 xl:w-auto xl:flex-row xl:items-center">
						<Tabs
							value={filter()}
							onValueChange={(value) => setFilter(value as FilterTab)}
						>
							<TabsList>
								<TabsTrigger value="all">
									all <span class="text-[10px]">({summary().all})</span>
								</TabsTrigger>
								<TabsTrigger value="app">
									app <span class="text-[10px]">({summary().app})</span>
								</TabsTrigger>
								<TabsTrigger value="managed">
									managed <span class="text-[10px]">({summary().managed})</span>
								</TabsTrigger>
								<TabsTrigger value="public">
									public <span class="text-[10px]">({summary().public})</span>
								</TabsTrigger>
							</TabsList>
						</Tabs>
						<div class="w-full xl:min-w-80">
							<Input
								value={search()}
								onInput={(event) => setSearch(event.currentTarget.value)}
								placeholder="search by service, group, host, or type"
							/>
						</div>
					</div>
				</CardHeader>
				<CardContent class="space-y-6">
					<Show when={actionError()}>
						<Alert variant="destructive" title="service action failed">
							{actionError()}
						</Alert>
					</Show>

					<Show when={services.error}>
						<Alert variant="destructive" title="failed to load services">
							{services.error instanceof Error
								? services.error.message
								: "failed to load service inventory"}
						</Alert>
					</Show>

					<Show when={services.loading}>
						<div class="grid gap-4">
							<For each={[1, 2, 3, 4]}>
								{() => <Skeleton class="h-64 w-full" />}
							</For>
						</div>
					</Show>

					<Show when={!services.loading && (services()?.length || 0) === 0}>
						<EmptyState
							title="no services yet"
							description="create a service from the launch section above and
it will appear here under its group automatically."
							action={
								<A href="/projects/new">
									<Button>add your first service</Button>
								</A>
							}
							icon={
								<svg
									class="h-6 w-6"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="1.5"
										d="M12 4v16m8-8H4"
									/>
								</svg>
							}
						/>
					</Show>

					<Show when={!services.loading && (services()?.length || 0) > 0}>
						<div class="space-y-4">
							<For each={groupedServices()}>
								{(group) => (
									<Card>
										<CardHeader class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
											<div>
												<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
													{group.is_standalone
														? "standalone service"
														: "service group"}
												</p>
												<CardTitle class="mt-2">{group.label}</CardTitle>
												<CardDescription>
													network {group.network_name} · {group.services.length}{" "}
													service{group.services.length === 1 ? "" : "s"} ·{" "}
													updated {timeAgo(group.updated_at)}
												</CardDescription>
											</div>
											<div class="flex flex-wrap items-center gap-2">
												<Badge variant="secondary">
													{group.services.length} services
												</Badge>
												<Show when={group.public_count > 0}>
													<Badge variant="outline">
														{group.public_count} public
													</Badge>
												</Show>
												<Show when={group.project_id}>
													<A href={`/projects/${group.project_id}`}>
														<Button variant="outline" size="sm">
															open group
														</Button>
													</A>
												</Show>
											</div>
										</CardHeader>
										<CardContent class="p-0">
											<div class="divide-y divide-[var(--border)]">
												<For each={group.services}>
													{(service) => (
														<div class="flex flex-col gap-5 px-6 py-5 xl:flex-row xl:items-center xl:justify-between">
															<div class="flex min-w-0 items-start gap-4">
																<ServiceIcon type={service.service_type} />
																<div class="min-w-0 space-y-3">
																	<div>
																		<p class="truncate font-serif text-2xl text-[var(--foreground)]">
																			{service.name}
																		</p>
																		<p class="mt-1 text-sm text-[var(--muted-foreground)]">
																			{serviceTypeLabel(service.service_type)}
																		</p>
																	</div>
																	<div class="flex flex-wrap gap-2">
																		<Badge
																			variant={statusVariant(service.status)}
																		>
																			{service.status}
																		</Badge>
																		<Badge variant="outline">
																			{service.resource_kind.replaceAll(
																				"_",
																				" ",
																			)}
																		</Badge>
																		<Show when={hasPublicExposure(service)}>
																			<Badge variant="outline">public</Badge>
																		</Show>
																		<Show when={service.pitr_enabled}>
																			<Badge variant="outline">pitr</Badge>
																		</Show>
																		<Show when={service.proxy_enabled}>
																			<Badge variant="outline">pgdog</Badge>
																		</Show>
																	</div>
																</div>
															</div>

															<div class="grid gap-3 text-sm xl:min-w-[340px]">
																<div class="flex items-start justify-between gap-4">
																	<span class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
																		endpoint
																	</span>
																	<span class="max-w-[65%] truncate text-right font-mono text-[var(--foreground-subtle)]">
																		{serviceEndpointLabel(service)}
																	</span>
																</div>
																<div class="flex items-start justify-between gap-4">
																	<span class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
																		activity
																	</span>
																	<span class="text-right text-[var(--foreground-subtle)]">
																		{serviceActivityLabel(service)}
																	</span>
																</div>
																<div class="flex items-start justify-between gap-4">
																	<span class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
																		updated
																	</span>
																	<span class="text-right text-[var(--foreground-subtle)]">
																		{timeAgo(service.updated_at)}
																	</span>
																</div>
															</div>

															<div class="flex flex-wrap items-center gap-3">
																<Button
																	variant="secondary"
																	size="sm"
																	isLoading={pendingServiceId() === service.id}
																	onClick={() => void restartService(service)}
																>
																	restart
																</Button>
																<A href={serviceDetailHref(service)}>
																	<Button variant="outline" size="sm">
																		open
																	</Button>
																</A>
															</div>
														</div>
													)}
												</For>
											</div>
										</CardContent>
									</Card>
								)}
							</For>
						</div>

						<Show when={groupedServices().length === 0}>
							<div class="border border-[var(--border)] bg-[var(--muted)] px-6 py-10 text-center text-sm text-[var(--muted-foreground)]">
								no services match the current search or filter
							</div>
						</Show>
					</Show>
				</CardContent>
			</Card>
		</div>
	);
};

export default Dashboard;
