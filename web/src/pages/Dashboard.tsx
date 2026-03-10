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

const appQuickActions: QuickAction[] = [
	{
		title: "web service",
		description: "public http and grpc entrypoint with default routing.",
		href: "/projects/new?service_type=web_service",
		label: "new web service",
		type: "web_service",
	},
	{
		title: "private service",
		description: "internal-only service for east-west traffic in a group.",
		href: "/projects/new?service_type=private_service",
		label: "new private service",
		type: "private_service",
	},
	{
		title: "background worker",
		description: "long-running job consumer without public ingress.",
		href: "/projects/new?service_type=background_worker",
		label: "new worker",
		type: "background_worker",
	},
	{
		title: "cron job",
		description: "scheduled container for timed tasks and maintenance.",
		href: "/projects/new?service_type=cron_job",
		label: "new cron job",
		type: "cron_job",
	},
];

const managedQuickActions: QuickAction[] = [
	{
		title: "containr postgres",
		description: "managed postgres with pgdog and optional pitr.",
		href: "/databases?create=1&type=postgresql",
		label: "create postgres",
		type: "postgres",
	},
	{
		title: "containr valkey",
		description: "redis-compatible valkey for cache and queue workloads.",
		href: "/databases?create=1&type=redis",
		label: "create valkey",
		type: "redis",
	},
	{
		title: "containr mariadb",
		description: "mysql-compatible mariadb with direct public port support.",
		href: "/databases?create=1&type=mariadb",
		label: "create mariadb",
		type: "mariadb",
	},
	{
		title: "containr qdrant",
		description: "vector storage with direct http access when exposed.",
		href: "/databases?create=1&type=qdrant",
		label: "create qdrant",
		type: "qdrant",
	},
	{
		title: "rabbitmq",
		description: "managed rabbitmq broker with direct connection details.",
		href: "/queues?create=1&type=rabbitmq",
		label: "create rabbitmq",
		type: "rabbitmq",
	},
];

const fetchServices = async (): Promise<ServiceInventoryItem[]> => {
	const token = localStorage.getItem("containr_token");
	const headers = new Headers();

	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}

	const response = await fetch("/api/services", { headers });
	if (response.status === 401) {
		localStorage.removeItem("containr_token");
		window.location.href = "/login";
		throw new Error("unauthorized");
	}

	if (!response.ok) {
		throw new Error("failed to fetch services");
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

const serviceScopeLabel = (service: ServiceInventoryItem): string => {
	if (service.project_name) {
		return `group ${service.project_name}`;
	}

	return `standalone network ${service.network_name}`;
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
		return `schedule ${service.schedule.trim()}`;
	}

	return "internal only";
};

const serviceActivityLabel = (service: ServiceInventoryItem): string => {
	if (service.schedule?.trim()) {
		return service.schedule.trim();
	}

	if (service.desired_instances <= 1) {
		return service.running_instances > 0 ? "1 instance running" : "not running";
	}

	return `${service.running_instances}/${service.desired_instances} instances running`;
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
	const [services] = createResource(fetchServices);
	const [filter, setFilter] = createSignal<FilterTab>("all");
	const [search, setSearch] = createSignal("");

	const summary = createMemo(() => {
		const rows = services() || [];
		const groupKeys = new Set(
			rows.map(
				(service) =>
					service.project_id || service.group_id || service.network_name,
			),
		);

		return {
			all: rows.length,
			app: rows.filter((service) => service.resource_kind === "app_service")
				.length,
			managed: rows.filter(isManagedService).length,
			public: rows.filter(hasPublicExposure).length,
			networks: groupKeys.size,
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

	return (
		<div class="space-y-8">
			<PageHeader
				eyebrow="control plane"
				title="services"
				description="create new services from the landing page and inspect every
running app, worker, cron job, and managed service without diving into separate
menus first."
				actions={
					<>
						<a href="#quick-create">
							<Button variant="secondary">add service</Button>
						</a>
						<A href="/projects/new">
							<Button>new app service</Button>
						</A>
					</>
				}
			/>

			<Card id="quick-create">
				<CardHeader class="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
					<div>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							launch
						</p>
						<CardTitle class="mt-2">add a service from home</CardTitle>
						<CardDescription>
							start the exact runtime you need without digging through dedicated
							pages first.
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
									deploy from a repository into a grouped network boundary.
								</p>
							</div>
							<Badge variant="secondary">{summary().app}</Badge>
						</div>
						<div class="grid gap-3 md:grid-cols-2">
							<For each={appQuickActions}>
								{(action) => (
									<A href={action.href} class="block">
										<Card variant="hover" class="h-full border-[var(--border)]">
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
												<div class="flex items-center justify-between border-t border-[var(--border)] pt-4">
													<span class="text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
														repository deploy
													</span>
													<span class="text-sm font-medium text-[var(--foreground)]">
														{action.label}
													</span>
												</div>
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
									spin up stateful data services with the existing create flows
									already wired into the backend.
								</p>
							</div>
							<Badge variant="secondary">{summary().managed}</Badge>
						</div>
						<div class="grid gap-3 md:grid-cols-2">
							<For each={managedQuickActions}>
								{(action) => (
									<A href={action.href} class="block">
										<Card variant="hover" class="h-full border-[var(--border)]">
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
												<div class="flex items-center justify-between border-t border-[var(--border)] pt-4">
													<span class="text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
														stateful service
													</span>
													<span class="text-sm font-medium text-[var(--foreground)]">
														{action.label}
													</span>
												</div>
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
							every service inventory item across the instance
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
							public endpoints
						</p>
						<p class="font-serif text-4xl text-[var(--foreground)]">
							{summary().public}
						</p>
						<p class="text-sm text-[var(--muted-foreground)]">
							across {summary().networks} groups or solo networks
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
						<CardTitle class="mt-2">all services on one screen</CardTitle>
						<CardDescription>
							use the unified service inventory instead of jumping between app,
							database, and queue pages just to see what exists.
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
								placeholder="search by service, type, group, or host"
							/>
						</div>
					</div>
				</CardHeader>
				<CardContent class="space-y-6">
					<Show when={services.error}>
						<Alert variant="destructive" title="failed to load services">
							{services.error instanceof Error
								? services.error.message
								: "failed to load service inventory"}
						</Alert>
					</Show>

					<Show when={services.loading}>
						<div class="grid gap-4 xl:grid-cols-2">
							<For each={[1, 2, 3, 4, 5, 6]}>
								{() => <Skeleton class="h-64 w-full" />}
							</For>
						</div>
					</Show>

					<Show when={!services.loading && (services()?.length || 0) === 0}>
						<EmptyState
							title="no services yet"
							description="launch a web service, worker, cron job, or managed
data service directly from the quick-create tiles above."
							action={
								<a href="#quick-create">
									<Button>add your first service</Button>
								</a>
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
						<div class="grid gap-4 xl:grid-cols-2">
							<For each={filteredServices()}>
								{(service) => (
									<A href={serviceDetailHref(service)} class="block">
										<Card variant="hover" class="h-full border-[var(--border)]">
											<CardContent class="flex h-full flex-col justify-between gap-6">
												<div class="space-y-5">
													<div class="flex items-start justify-between gap-4">
														<div class="flex min-w-0 items-start gap-3">
															<ServiceIcon type={service.service_type} />
															<div class="min-w-0">
																<p class="truncate font-serif text-2xl text-[var(--foreground)]">
																	{service.name}
																</p>
																<p class="mt-1 truncate text-[11px] uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
																	{serviceScopeLabel(service)}
																</p>
															</div>
														</div>
														<Badge variant={statusVariant(service.status)}>
															{service.status}
														</Badge>
													</div>

													<div class="flex flex-wrap gap-2">
														<Badge variant="secondary">
															{serviceTypeLabel(service.service_type)}
														</Badge>
														<Badge variant="outline">
															{isManagedService(service)
																? "managed"
																: "application"}
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

													<div class="space-y-3 border-t border-[var(--border)] pt-4 text-sm">
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
																network
															</span>
															<span class="max-w-[65%] truncate text-right font-mono text-[var(--foreground-subtle)]">
																{service.network_name}
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
												</div>

												<div class="flex items-center justify-between border-t border-[var(--border)] pt-4">
													<span class="text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
														{service.resource_kind.replaceAll("_", " ")}
													</span>
													<span class="text-sm font-medium text-[var(--foreground)]">
														open service
													</span>
												</div>
											</CardContent>
										</Card>
									</A>
								)}
							</For>
						</div>

						<Show when={filteredServices().length === 0}>
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
