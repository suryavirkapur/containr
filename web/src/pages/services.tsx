import { A } from "@solidjs/router";
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js";

import { listServices, runServiceAction, type Service } from "../api/services";
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

type FilterTab = "all" | "repository" | "template" | "public";

const describeError = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}

	if (
		typeof error === "object" &&
		error !== null &&
		"error" in error &&
		typeof error.error === "string"
	) {
		return error.error;
	}

	return "request failed";
};

const timeAgo = (dateString: string): string => {
	const date = new Date(dateString);
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

	if (seconds < 60) {
		return "just now";
	}

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}

	const days = Math.floor(hours / 24);
	if (days < 30) {
		return `${days}d ago`;
	}

	const months = Math.floor(days / 30);
	if (months < 12) {
		return `${months}mo ago`;
	}

	return `${Math.floor(days / 365)}y ago`;
};

const statusVariant = (status: string): "outline" | "success" | "warning" | "error" => {
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

const serviceCategoryLabel = (service: Service): string => {
	switch (service.resource_kind) {
		case "app_service":
			return "repository";
		case "managed_database":
		case "managed_queue":
			return "template";
		default:
			return service.resource_kind.replaceAll("_", " ");
	}
};

const serviceTypeLabel = (serviceType: string): string => {
	switch (serviceType) {
		case "web_service":
			return "web";
		case "private_service":
			return "private";
		case "background_worker":
			return "worker";
		case "cron_job":
			return "cron";
		case "postgres":
			return "postgres";
		case "redis":
			return "valkey";
		case "mariadb":
			return "mariadb";
		case "qdrant":
			return "qdrant";
		case "rabbitmq":
			return "rabbitmq";
		default:
			return serviceType.replaceAll("_", " ");
	}
};

const hasPublicExposure = (service: Service): boolean =>
	service.public_http ||
	service.default_urls.length > 0 ||
	Boolean(service.external_port) ||
	Boolean(service.proxy_external_port);

const endpointLabel = (service: Service): string => {
	if (service.default_urls.length > 0) {
		return service.default_urls[0];
	}

	if (service.proxy_enabled && service.proxy_connection_string) {
		return service.proxy_connection_string;
	}

	if (service.connection_string) {
		return service.connection_string;
	}

	if (service.public_ip && service.proxy_external_port) {
		return `${service.public_ip}:${service.proxy_external_port}`;
	}

	if (service.public_ip && service.external_port) {
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

const runtimeLabel = (service: Service): string => {
	if (service.schedule?.trim()) {
		return service.schedule.trim();
	}

	if (service.desired_instances > 1) {
		return `${service.running_instances}/${service.desired_instances} running`;
	}

	if (service.desired_instances === 1) {
		return service.running_instances > 0 ? "running" : "stopped";
	}

	return "managed";
};

const networkLabel = (service: Service): string => {
	if (service.project_name?.trim()) {
		return service.project_name.trim();
	}

	return service.network_name;
};

const Services: Component = () => {
	const [services, { refetch }] = createResource(() => true, () => listServices());
	const [filter, setFilter] = createSignal<FilterTab>("all");
	const [search, setSearch] = createSignal("");
	const [pendingServiceId, setPendingServiceId] = createSignal<string | null>(null);
	const [actionError, setActionError] = createSignal("");

	const summary = createMemo(() => {
		const rows = services() ?? [];

		return {
			all: rows.length,
			repository: rows.filter((service) => service.resource_kind === "app_service").length,
			template: rows.filter((service) => service.resource_kind !== "app_service").length,
			public: rows.filter(hasPublicExposure).length,
			networks: new Set(rows.map((service) => service.network_name)).size,
		};
	});

	const filteredServices = createMemo(() => {
		let rows = [...(services() ?? [])].sort(
			(left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime(),
		);
		const query = search().trim().toLowerCase();

		if (filter() === "repository") {
			rows = rows.filter((service) => service.resource_kind === "app_service");
		}

		if (filter() === "template") {
			rows = rows.filter((service) => service.resource_kind !== "app_service");
		}

		if (filter() === "public") {
			rows = rows.filter(hasPublicExposure);
		}

		if (!query) {
			return rows;
		}

		return rows.filter((service) =>
			[
				service.name,
				serviceTypeLabel(service.service_type),
				serviceCategoryLabel(service),
				service.project_name ?? "",
				service.network_name,
				service.internal_host ?? "",
			].some((value) => value.toLowerCase().includes(query)),
		);
	});

	const restartService = async (serviceId: string) => {
		setPendingServiceId(serviceId);
		setActionError("");

		try {
			await runServiceAction(serviceId, "restart");
			await refetch();
		} catch (error) {
			setActionError(describeError(error));
		} finally {
			setPendingServiceId(null);
		}
	};

	return (
		<div class="space-y-8">
			<PageHeader
				eyebrow="control plane"
				title="services"
				description="all repository and template services now live in one
inventory, one create flow, and one detail route."
				actions={
					<A href="/services/new">
						<Button>new service</Button>
					</A>
				}
			/>

			<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
				<Card>
					<CardContent class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
							total services
						</p>
						<p class="font-serif text-4xl text-[var(--foreground)]">{summary().all}</p>
						<p class="text-sm text-[var(--muted-foreground)]">
							across {summary().networks} service networks
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
							repository services
						</p>
						<p class="font-serif text-4xl text-[var(--foreground)]">{summary().repository}</p>
						<p class="text-sm text-[var(--muted-foreground)]">
							web, private, worker, and cron runtimes
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
							template services
						</p>
						<p class="font-serif text-4xl text-[var(--foreground)]">{summary().template}</p>
						<p class="text-sm text-[var(--muted-foreground)]">
							postgres, valkey, mariadb, qdrant, and rabbitmq
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
							public services
						</p>
						<p class="font-serif text-4xl text-[var(--foreground)]">{summary().public}</p>
						<p class="text-sm text-[var(--muted-foreground)]">
							services with a public url or public port
						</p>
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
					<div>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							inventory
						</p>
						<CardTitle class="mt-2">all services</CardTitle>
						<CardDescription>
							every service type is listed together with its service type, category, endpoint, and
							runtime state.
						</CardDescription>
					</div>
					<div class="flex w-full flex-col gap-4 xl:w-auto xl:flex-row xl:items-center">
						<Tabs value={filter()} onValueChange={(value) => setFilter(value as FilterTab)}>
							<TabsList>
								<TabsTrigger value="all">
									all <span class="text-[10px]">({summary().all})</span>
								</TabsTrigger>
								<TabsTrigger value="repository">
									repository <span class="text-[10px]">({summary().repository})</span>
								</TabsTrigger>
								<TabsTrigger value="template">
									template <span class="text-[10px]">({summary().template})</span>
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
								placeholder="search by service, type, network, or host"
							/>
						</div>
					</div>
				</CardHeader>
				<CardContent class="space-y-4">
					<Show when={actionError()}>
						<Alert variant="destructive" title="service action failed">
							{actionError()}
						</Alert>
					</Show>

					<Show when={services.error}>
						<Alert variant="destructive" title="failed to load services">
							{describeError(services.error)}
						</Alert>
					</Show>

					<Show when={services.loading}>
						<div class="grid gap-4">
							<For each={[1, 2, 3, 4]}>{() => <Skeleton class="h-32 w-full" />}</For>
						</div>
					</Show>

					<Show when={!services.loading && (services()?.length ?? 0) === 0}>
						<EmptyState
							title="no services yet"
							description="create a service from a repository or template and
it will appear here immediately."
							action={
								<A href="/services/new">
									<Button>create the first service</Button>
								</A>
							}
						/>
					</Show>

					<Show when={!services.loading && (services()?.length ?? 0) > 0}>
						<div class="overflow-x-auto border border-[var(--border)]">
							<table class="min-w-full divide-y divide-[var(--border)]">
								<thead class="bg-[var(--muted)]">
									<tr class="text-left">
										<th class="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											service
										</th>
										<th class="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											service type
										</th>
										<th class="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											category
										</th>
										<th class="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											service network
										</th>
										<th class="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											endpoint
										</th>
										<th class="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											status
										</th>
										<th class="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											runtime
										</th>
										<th class="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											updated
										</th>
										<th class="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											actions
										</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-[var(--border)] bg-[var(--card)]">
									<For each={filteredServices()}>
										{(service) => (
											<tr class="align-top">
												<td class="px-4 py-4">
													<div class="space-y-2">
														<p class="font-medium text-[var(--foreground)]">{service.name}</p>
														<div class="flex flex-wrap gap-2">
															<Show when={hasPublicExposure(service)}>
																<Badge variant="outline">public</Badge>
															</Show>
															<Show when={service.pitr_enabled}>
																<Badge variant="outline">pitr</Badge>
															</Show>
															<Show when={service.proxy_enabled}>
																<Badge variant="outline">proxy</Badge>
															</Show>
														</div>
													</div>
												</td>
												<td class="px-4 py-4 text-sm text-[var(--foreground-subtle)]">
													{serviceTypeLabel(service.service_type)}
												</td>
												<td class="px-4 py-4 text-sm text-[var(--foreground-subtle)]">
													{serviceCategoryLabel(service)}
												</td>
												<td class="px-4 py-4 text-sm text-[var(--foreground-subtle)]">
													{networkLabel(service)}
												</td>
												<td class="px-4 py-4">
													<p class="max-w-xs break-all font-mono text-xs text-[var(--foreground-subtle)]">
														{endpointLabel(service)}
													</p>
												</td>
												<td class="px-4 py-4">
													<Badge variant={statusVariant(service.status)}>{service.status}</Badge>
												</td>
												<td class="px-4 py-4 text-sm text-[var(--foreground-subtle)]">
													{runtimeLabel(service)}
												</td>
												<td class="px-4 py-4 text-sm text-[var(--foreground-subtle)]">
													{timeAgo(service.updated_at)}
												</td>
												<td class="px-4 py-4">
													<div class="flex justify-end gap-3">
														<Button
															variant="secondary"
															size="sm"
															isLoading={pendingServiceId() === service.id}
															onClick={() => void restartService(service.id)}
														>
															restart
														</Button>
														<A href={`/services/${service.id}`}>
															<Button variant="outline" size="sm">
																open
															</Button>
														</A>
													</div>
												</td>
											</tr>
										)}
									</For>
								</tbody>
							</table>
						</div>

						<Show when={filteredServices().length === 0}>
							<div class="border border-[var(--border)] bg-[var(--muted)] px-6 py-10 text-center text-sm text-[var(--muted-foreground)]">
								no services match the current filter
							</div>
						</Show>
					</Show>
				</CardContent>
			</Card>
		</div>
	);
};

export default Services;
