import { A, useNavigate, useParams } from "@solidjs/router";
import {
	Component,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";

import { api, type components } from "../api";
import ContainerMonitor from "../components/ContainerMonitor";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	PageHeader,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../components/ui";
import { parseAnsi } from "../utils/ansi";

type Service = components["schemas"]["InventoryServiceResponse"];
type Project = components["schemas"]["AppResponse"];
type ProjectService = components["schemas"]["ServiceResponse"];
type Database = components["schemas"]["DatabaseResponse"];
type Queue = components["schemas"]["QueueResponse"];

type Feedback = {
	text: string;
	variant: "default" | "destructive" | "success";
};

type DetailTab = "overview" | "environment" | "logs" | "containers" | "advanced";

type KeyValueRow = {
	key: string;
	value: string;
	description?: string;
	secret?: boolean;
};

const fetchService = async (id: string): Promise<Service> => {
	const { data, error } = await api.GET("/api/services/{id}", {
		params: { path: { id } },
	});
	if (error) {
		throw error;
	}

	return data;
};

const fetchProject = async (id: string): Promise<Project> => {
	const { data, error } = await api.GET("/api/projects/{id}", {
		params: { path: { id } },
	});
	if (error) {
		throw error;
	}

	return data;
};

const fetchDatabase = async (id: string): Promise<Database> => {
	const { data, error } = await api.GET("/api/databases/{id}", {
		params: { path: { id } },
	});
	if (error) {
		throw error;
	}

	return data;
};

const fetchQueue = async (id: string): Promise<Queue> => {
	const { data, error } = await api.GET("/api/queues/{id}", {
		params: { path: { id } },
	});
	if (error) {
		throw error;
	}

	return data;
};

const fetchLogs = async (id: string): Promise<string> => {
	const { data, error } = await api.GET("/api/services/{id}/logs", {
		params: { path: { id }, query: { tail: 200 } },
	});
	if (error) {
		throw error;
	}

	return data.logs ?? "";
};

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
			return "repository service";
		case "managed_database":
			return "template service";
		case "managed_queue":
			return "template service";
		default:
			return service.resource_kind.replaceAll("_", " ");
	}
};

const serviceTypeLabel = (serviceType: string): string => {
	switch (serviceType) {
		case "web_service":
			return "web service";
		case "private_service":
			return "private service";
		case "background_worker":
			return "background worker";
		case "cron_job":
			return "cron service";
		case "postgres":
			return "postgres service";
		case "redis":
			return "valkey service";
		case "mariadb":
			return "mariadb service";
		case "qdrant":
			return "qdrant service";
		case "rabbitmq":
			return "rabbitmq service";
		default:
			return serviceType.replaceAll("_", " ");
	}
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

const formatDate = (value?: string | null): string => {
	if (!value) {
		return "n/a";
	}

	return new Date(value).toLocaleString();
};

const formatBoolean = (value: boolean): string => (value ? "enabled" : "disabled");

const KeyValueCard: Component<{
	title: string;
	description: string;
	items: KeyValueRow[];
	emptyText: string;
	showSecrets: boolean;
	onToggleSecrets?: () => void;
}> = (props) => {
	const copy = async (value: string) => {
		await navigator.clipboard.writeText(value);
	};

	return (
		<Card>
			<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
				<div>
					<CardTitle>{props.title}</CardTitle>
					<CardDescription>{props.description}</CardDescription>
				</div>
				<Show when={props.onToggleSecrets}>
					<Button variant="outline" size="sm" onClick={() => props.onToggleSecrets?.()}>
						{props.showSecrets ? "hide secrets" : "show secrets"}
					</Button>
				</Show>
			</CardHeader>
			<CardContent>
				<Show
					when={props.items.length > 0}
					fallback={<p class="text-sm text-[var(--muted-foreground)]">{props.emptyText}</p>}
				>
					<div class="divide-y divide-[var(--border)] border border-[var(--border)]">
						<For each={props.items}>
							{(item) => (
								<div class="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
									<div class="space-y-1">
										<p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
											{item.key}
										</p>
										<Show when={item.description}>
											<p class="text-sm text-[var(--muted-foreground)]">{item.description}</p>
										</Show>
									</div>
									<div class="flex items-start gap-3 lg:max-w-[70%]">
										<p class="break-all font-mono text-sm text-[var(--foreground-subtle)]">
											{item.secret && !props.showSecrets ? "********" : item.value}
										</p>
										<Button variant="outline" size="sm" onClick={() => void copy(item.value)}>
											copy
										</Button>
									</div>
								</div>
							)}
						</For>
					</div>
				</Show>
			</CardContent>
		</Card>
	);
};

const ServiceDetail: Component = () => {
	const params = useParams();
	const navigate = useNavigate();
	const [activeTab, setActiveTab] = createSignal<DetailTab>("overview");
	const [selectedContainerId, setSelectedContainerId] = createSignal("");
	const [showSecrets, setShowSecrets] = createSignal(false);
	const [feedback, setFeedback] = createSignal<Feedback | null>(null);
	const [pendingAction, setPendingAction] = createSignal<string | null>(null);
	const [externalPort, setExternalPort] = createSignal("");
	const [proxyExternalPort, setProxyExternalPort] = createSignal("");

	const [service, { refetch: refetchService }] = createResource(() => params.id, fetchService);
	const [project, { refetch: refetchProject }] = createResource(() => {
		const current = service();
		if (current?.resource_kind !== "app_service") {
			return undefined;
		}

		return current.project_id ?? undefined;
	}, fetchProject);
	const [database, { refetch: refetchDatabase }] = createResource(
		() => (service()?.resource_kind === "managed_database" ? params.id : undefined),
		fetchDatabase,
	);
	const [queue, { refetch: refetchQueue }] = createResource(
		() => (service()?.resource_kind === "managed_queue" ? params.id : undefined),
		fetchQueue,
	);
	const [logs, { refetch: refetchLogs }] = createResource(() => params.id, fetchLogs);

	const appService = createMemo<ProjectService | null>(() => {
		const currentService = service();
		const currentProject = project();
		if (!currentService || !currentProject) {
			return null;
		}

		return (
			currentProject.services.find((projectService) => projectService.id === currentService.id) ??
			null
		);
	});

	const connectionItems = createMemo<KeyValueRow[]>(() => {
		const currentService = service();
		if (!currentService) {
			return [];
		}

		const items: KeyValueRow[] = [];
		for (const url of currentService.default_urls) {
			items.push({
				key: "public url",
				value: url,
				description: "public endpoint routed through the service edge",
			});
		}

		if (currentService.internal_host && currentService.port) {
			items.push({
				key: "internal endpoint",
				value: `${currentService.internal_host}:${currentService.port}`,
				description: "private address inside the service network",
			});
		}

		if (currentService.connection_string) {
			items.push({
				key: "connection string",
				value: currentService.connection_string,
				description: "primary runtime connection string",
				secret: true,
			});
		}

		if (currentService.proxy_connection_string) {
			items.push({
				key: "proxy connection string",
				value: currentService.proxy_connection_string,
				description: "proxy-aware runtime connection string",
				secret: true,
			});
		}

		const currentDatabase = database();
		if (currentDatabase?.public_connection_string) {
			items.push({
				key: "public connection string",
				value: currentDatabase.public_connection_string,
				description: "public entrypoint for external clients",
				secret: true,
			});
		}

		if (currentDatabase?.public_proxy_connection_string) {
			items.push({
				key: "public proxy connection string",
				value: currentDatabase.public_proxy_connection_string,
				description: "public proxy entrypoint for external clients",
				secret: true,
			});
		}

		if (queue()?.public_connection_string) {
			items.push({
				key: "public connection string",
				value: queue()!.public_connection_string!,
				description: "public entrypoint for external clients",
				secret: true,
			});
		}

		return items;
	});

	const environmentItems = createMemo<KeyValueRow[]>(() => {
		const currentService = service();
		if (!currentService) {
			return [];
		}

		if (currentService.resource_kind === "app_service") {
			const currentProject = project();
			const currentAppService = appService();
			if (!currentProject || !currentAppService) {
				return [];
			}

			return [
				...currentProject.env_vars.map((envVar) => ({
					key: envVar.key,
					value: envVar.value,
					description: "shared across the service network",
					secret: envVar.secret,
				})),
				...currentAppService.env_vars.map((envVar) => ({
					key: envVar.key,
					value: envVar.value,
					description: "service-specific runtime value",
					secret: envVar.secret,
				})),
			];
		}

		if (currentService.resource_kind === "managed_database") {
			const currentDatabase = database();
			if (!currentDatabase) {
				return [];
			}

			switch (currentDatabase.db_type) {
				case "postgres":
					return [
						{
							key: "DATABASE_URL",
							value: currentDatabase.connection_string,
							description: "primary service connection string",
							secret: true,
						},
						{
							key: "PGHOST",
							value: currentDatabase.internal_host,
							description: "internal service host",
						},
						{
							key: "PGPORT",
							value: String(currentDatabase.port),
							description: "internal service port",
						},
						{
							key: "PGUSER",
							value: currentDatabase.username,
							description: "service username",
						},
						{
							key: "PGPASSWORD",
							value: currentDatabase.password,
							description: "service password",
							secret: true,
						},
						{
							key: "PGDATABASE",
							value: currentDatabase.database_name,
							description: "service database name",
						},
					];
				case "redis":
					return [
						{
							key: "REDIS_URL",
							value: currentDatabase.connection_string,
							description: "primary service connection string",
							secret: true,
						},
						{
							key: "REDIS_HOST",
							value: currentDatabase.internal_host,
							description: "internal service host",
						},
						{
							key: "REDIS_PORT",
							value: String(currentDatabase.port),
							description: "internal service port",
						},
						{
							key: "REDIS_PASSWORD",
							value: currentDatabase.password,
							description: "service password",
							secret: true,
						},
					];
				case "mariadb":
					return [
						{
							key: "MARIADB_URL",
							value: currentDatabase.connection_string,
							description: "primary service connection string",
							secret: true,
						},
						{
							key: "MARIADB_HOST",
							value: currentDatabase.internal_host,
							description: "internal service host",
						},
						{
							key: "MARIADB_PORT",
							value: String(currentDatabase.port),
							description: "internal service port",
						},
						{
							key: "MARIADB_USER",
							value: currentDatabase.username,
							description: "service username",
						},
						{
							key: "MARIADB_PASSWORD",
							value: currentDatabase.password,
							description: "service password",
							secret: true,
						},
						{
							key: "MARIADB_DATABASE",
							value: currentDatabase.database_name,
							description: "service database name",
						},
					];
				case "qdrant":
					return [
						{
							key: "QDRANT_URL",
							value: currentDatabase.connection_string,
							description: "primary service connection string",
						},
						{
							key: "QDRANT_HOST",
							value: currentDatabase.internal_host,
							description: "internal service host",
						},
						{
							key: "QDRANT_PORT",
							value: String(currentDatabase.port),
							description: "internal service port",
						},
					];
				default:
					return [];
			}
		}

		const currentQueue = queue();
		if (!currentQueue) {
			return [];
		}

		return [
			{
				key: "RABBITMQ_URL",
				value: currentQueue.connection_string,
				description: "primary service connection string",
				secret: true,
			},
			{
				key: "RABBITMQ_HOST",
				value: currentQueue.internal_host,
				description: "internal service host",
			},
			{
				key: "RABBITMQ_PORT",
				value: String(currentQueue.port),
				description: "internal service port",
			},
			{
				key: "RABBITMQ_USER",
				value: currentQueue.username,
				description: "service username",
			},
			{
				key: "RABBITMQ_PASSWORD",
				value: currentQueue.password,
				description: "service password",
				secret: true,
			},
		];
	});

	const overviewItems = createMemo<KeyValueRow[]>(() => {
		const currentService = service();
		if (!currentService) {
			return [];
		}

		const items: KeyValueRow[] = [
			{
				key: "category",
				value: serviceCategoryLabel(currentService),
			},
			{
				key: "service type",
				value: serviceTypeLabel(currentService.service_type),
			},
			{
				key: "service network",
				value: networkLabel(currentService),
			},
			{
				key: "runtime",
				value: runtimeLabel(currentService),
			},
			{
				key: "created",
				value: formatDate(currentService.created_at),
			},
			{
				key: "updated",
				value: formatDate(currentService.updated_at),
			},
		];

		if (currentService.deployment_id) {
			items.push({
				key: "deployment",
				value: currentService.deployment_id,
			});
		}

		return items;
	});

	const repositoryItems = createMemo<KeyValueRow[]>(() => {
		const currentProject = project();
		const currentAppService = appService();
		if (!currentProject || !currentAppService) {
			return [];
		}

		const items: KeyValueRow[] = [
			{
				key: "repository",
				value: currentProject.github_url,
			},
			{
				key: "branch",
				value: currentProject.branch,
			},
			{
				key: "service name",
				value: currentAppService.name,
			},
			{
				key: "port",
				value: String(currentAppService.port),
			},
			{
				key: "replicas",
				value: String(currentAppService.replicas),
			},
			{
				key: "http exposure",
				value: formatBoolean(currentAppService.expose_http),
			},
		];

		if (currentAppService.schedule?.trim()) {
			items.push({
				key: "schedule",
				value: currentAppService.schedule,
			});
		}

		if (currentAppService.image.trim()) {
			items.push({
				key: "image",
				value: currentAppService.image,
			});
		}

		return items;
	});

	const legacyDetailHref = createMemo(() => {
		const currentService = service();
		if (!currentService) {
			return null;
		}

		if (currentService.resource_kind === "app_service") {
			return currentService.project_id ? `/projects/${currentService.project_id}` : null;
		}

		if (currentService.resource_kind === "managed_database") {
			return `/databases/${currentService.id}`;
		}

		if (currentService.resource_kind === "managed_queue") {
			return `/queues/${currentService.id}`;
		}

		return null;
	});

	const refreshCurrentDetail = async () => {
		const currentService = service();

		await refetchService();
		await refetchLogs();

		if (currentService?.resource_kind === "app_service") {
			await refetchProject();
		}

		if (currentService?.resource_kind === "managed_database") {
			await refetchDatabase();
		}

		if (currentService?.resource_kind === "managed_queue") {
			await refetchQueue();
		}
	};

	const runAction = async (key: string, action: () => Promise<void>, successText: string) => {
		setPendingAction(key);
		setFeedback(null);

		try {
			await action();
			await refreshCurrentDetail();
			setFeedback({
				text: successText,
				variant: "success",
			});
		} catch (error) {
			setFeedback({
				text: describeError(error),
				variant: "destructive",
			});
		} finally {
			setPendingAction(null);
		}
	};

	const startService = async () => {
		const serviceId = params.id;
		if (!serviceId) {
			return;
		}

		await runAction(
			"start",
			async () => {
				const { error } = await api.POST("/api/services/{id}/start", {
					params: { path: { id: serviceId } },
				});
				if (error) {
					throw error;
				}
			},
			"service started",
		);
	};

	const stopService = async () => {
		const serviceId = params.id;
		if (!serviceId) {
			return;
		}

		await runAction(
			"stop",
			async () => {
				const { error } = await api.POST("/api/services/{id}/stop", {
					params: { path: { id: serviceId } },
				});
				if (error) {
					throw error;
				}
			},
			"service stopped",
		);
	};

	const restartService = async () => {
		const serviceId = params.id;
		if (!serviceId) {
			return;
		}

		await runAction(
			"restart",
			async () => {
				const { error } = await api.POST("/api/services/{id}/restart", {
					params: { path: { id: serviceId } },
				});
				if (error) {
					throw error;
				}
			},
			"service restarted",
		);
	};

	const deleteService = async () => {
		const currentService = service();
		if (!currentService) {
			return;
		}

		if (!window.confirm(`delete ${currentService.name}?`)) {
			return;
		}

		await runAction(
			"delete",
			async () => {
				const { error } = await api.DELETE("/api/services/{id}", {
					params: { path: { id: currentService.id } },
				});
				if (error) {
					throw error;
				}
			},
			"service deleted",
		);

		navigate("/services");
	};

	const toggleDatabaseExposure = async (enabled: boolean) => {
		const currentDatabase = database();
		if (!currentDatabase) {
			return;
		}

		await runAction(
			"database-exposure",
			async () => {
				const port = externalPort().trim();
				const { error } = await api.POST("/api/databases/{id}/expose", {
					params: { path: { id: currentDatabase.id } },
					body: {
						enabled,
						external_port: enabled && port.length > 0 ? Number(port) : undefined,
					},
				});
				if (error) {
					throw error;
				}
			},
			enabled ? "public access enabled" : "public access disabled",
		);
	};

	const toggleDatabaseProxy = async (enabled: boolean) => {
		const currentDatabase = database();
		if (!currentDatabase) {
			return;
		}

		await runAction(
			"database-proxy",
			async () => {
				const port = proxyExternalPort().trim();
				const { error } = await api.POST("/api/databases/{id}/proxy", {
					params: { path: { id: currentDatabase.id } },
					body: {
						enabled,
						external_port: enabled && port.length > 0 ? Number(port) : undefined,
					},
				});
				if (error) {
					throw error;
				}
			},
			enabled ? "proxy enabled" : "proxy disabled",
		);
	};

	const toggleDatabasePitr = async (enabled: boolean) => {
		const currentDatabase = database();
		if (!currentDatabase) {
			return;
		}

		await runAction(
			"database-pitr",
			async () => {
				const { error } = await api.POST("/api/databases/{id}/pitr", {
					params: { path: { id: currentDatabase.id } },
					body: { enabled },
				});
				if (error) {
					throw error;
				}
			},
			enabled ? "pitr enabled" : "pitr disabled",
		);
	};

	const toggleQueueExposure = async (enabled: boolean) => {
		const currentQueue = queue();
		if (!currentQueue) {
			return;
		}

		await runAction(
			"queue-exposure",
			async () => {
				const port = externalPort().trim();
				const { error } = await api.POST("/api/queues/{id}/expose", {
					params: { path: { id: currentQueue.id } },
					body: {
						enabled,
						external_port: enabled && port.length > 0 ? Number(port) : undefined,
					},
				});
				if (error) {
					throw error;
				}
			},
			enabled ? "public access enabled" : "public access disabled",
		);
	};

	createEffect(() => {
		const currentService = service();
		if (!currentService) {
			return;
		}

		if (!selectedContainerId() && currentService.container_ids.length > 0) {
			setSelectedContainerId(currentService.container_ids[0]);
		}
	});

	createEffect(() => {
		const currentDatabase = database();
		if (!currentDatabase) {
			return;
		}

		setExternalPort(currentDatabase.external_port ? String(currentDatabase.external_port) : "");
		setProxyExternalPort(
			currentDatabase.proxy_external_port ? String(currentDatabase.proxy_external_port) : "",
		);
	});

	createEffect(() => {
		const currentQueue = queue();
		if (!currentQueue) {
			return;
		}

		setExternalPort(currentQueue.external_port ? String(currentQueue.external_port) : "");
	});

	createEffect(() => {
		if (activeTab() !== "logs" || !params.id) {
			return;
		}

		const interval = window.setInterval(() => {
			void refetchLogs();
		}, 5000);

		onCleanup(() => window.clearInterval(interval));
	});

	return (
		<div class="space-y-8">
			<Show when={feedback()}>
				<Alert
					variant={
						feedback()!.variant === "destructive"
							? "destructive"
							: feedback()!.variant === "success"
								? "success"
								: "default"
					}
					title="service update"
				>
					{feedback()!.text}
				</Alert>
			</Show>

			<Show when={service.error}>
				<Alert variant="destructive" title="failed to load service">
					{describeError(service.error)}
				</Alert>
			</Show>

			<Show when={service()}>
				<PageHeader
					eyebrow={serviceCategoryLabel(service()!)}
					title={service()!.name}
					description={`${serviceTypeLabel(service()!.service_type)} on ${networkLabel(service()!)}`}
					actions={
						<div class="flex flex-wrap gap-3">
							<Badge variant={statusVariant(service()!.status)}>{service()!.status}</Badge>
							<Button
								variant="secondary"
								isLoading={pendingAction() === "restart"}
								onClick={() => void restartService()}
							>
								restart
							</Button>
							<A href="/services">
								<Button variant="outline">all services</Button>
							</A>
						</div>
					}
				/>

				<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
					<Card>
						<CardContent class="space-y-2">
							<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
								service type
							</p>
							<p class="font-serif text-3xl text-[var(--foreground)]">
								{serviceTypeLabel(service()!.service_type)}
							</p>
							<p class="text-sm text-[var(--muted-foreground)]">
								{serviceCategoryLabel(service()!)}
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardContent class="space-y-2">
							<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
								service network
							</p>
							<p class="font-serif text-3xl text-[var(--foreground)]">{networkLabel(service()!)}</p>
							<p class="text-sm text-[var(--muted-foreground)]">{service()!.network_name}</p>
						</CardContent>
					</Card>
					<Card>
						<CardContent class="space-y-2">
							<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
								runtime
							</p>
							<p class="font-serif text-3xl text-[var(--foreground)]">{runtimeLabel(service()!)}</p>
							<p class="text-sm text-[var(--muted-foreground)]">
								{service()!.container_ids.length} active containers tracked
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardContent class="space-y-2">
							<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
								updated
							</p>
							<p class="font-serif text-3xl text-[var(--foreground)]">
								{formatDate(service()!.updated_at)}
							</p>
							<p class="text-sm text-[var(--muted-foreground)]">
								created {formatDate(service()!.created_at)}
							</p>
						</CardContent>
					</Card>
				</div>

				<Tabs value={activeTab()} onValueChange={(value) => setActiveTab(value as DetailTab)}>
					<TabsList>
						<TabsTrigger value="overview">overview</TabsTrigger>
						<TabsTrigger value="environment">environment</TabsTrigger>
						<TabsTrigger value="logs">logs</TabsTrigger>
						<TabsTrigger value="containers">containers</TabsTrigger>
						<TabsTrigger value="advanced">advanced</TabsTrigger>
					</TabsList>

					<TabsContent value="overview">
						<div class="grid gap-6 xl:grid-cols-2">
							<KeyValueCard
								title="service summary"
								description="common service metadata rendered the same way
for every service type."
								items={overviewItems()}
								emptyText="no summary metadata available"
								showSecrets={showSecrets()}
							/>
							<KeyValueCard
								title="connection details"
								description="urls and connection strings rendered through one
shared layout."
								items={connectionItems()}
								emptyText="no connection values are available for this service"
								showSecrets={showSecrets()}
								onToggleSecrets={() => setShowSecrets((current) => !current)}
							/>
						</div>

						<Show when={repositoryItems().length > 0}>
							<KeyValueCard
								title="repository runtime"
								description="repository source and runtime settings for this
service."
								items={repositoryItems()}
								emptyText="no repository settings available"
								showSecrets={showSecrets()}
							/>
						</Show>
					</TabsContent>

					<TabsContent value="environment">
						<KeyValueCard
							title="environment values"
							description="runtime values are rendered with the same layout for
repository and template services."
							items={environmentItems()}
							emptyText="no environment values are configured for this service"
							showSecrets={showSecrets()}
							onToggleSecrets={() => setShowSecrets((current) => !current)}
						/>
					</TabsContent>

					<TabsContent value="logs">
						<Card>
							<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
								<div>
									<CardTitle>service logs</CardTitle>
									<CardDescription>
										this log panel always reads from the unified service log endpoint.
									</CardDescription>
								</div>
								<Button variant="outline" size="sm" onClick={() => void refetchLogs()}>
									refresh
								</Button>
							</CardHeader>
							<CardContent>
								<Show when={logs.error}>
									<Alert variant="destructive" title="failed to load logs">
										{describeError(logs.error)}
									</Alert>
								</Show>
								<div class="min-h-[20rem] border border-[var(--border)] bg-[var(--background)] p-4">
									<Show
										when={(logs() ?? "").trim().length > 0}
										fallback={
											<p class="font-mono text-sm text-[var(--muted-foreground)]">
												no logs available
											</p>
										}
									>
										<pre
											class="whitespace-pre-wrap break-words font-mono text-sm text-[var(--foreground-subtle)]"
											innerHTML={parseAnsi(logs() ?? "")}
										/>
									</Show>
								</div>
							</CardContent>
						</Card>
					</TabsContent>

					<TabsContent value="containers">
						<Card>
							<CardHeader>
								<CardTitle>container monitor</CardTitle>
								<CardDescription>
									select an active container for live status, logs, volumes, and terminal access.
								</CardDescription>
							</CardHeader>
							<CardContent class="space-y-4">
								<Show
									when={service()!.container_ids.length > 0}
									fallback={
										<p class="text-sm text-[var(--muted-foreground)]">
											no active containers are currently tracked for this service.
										</p>
									}
								>
									<div class="max-w-sm">
										<label
											for="container-select"
											class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]"
										>
											container
										</label>
										<select
											id="container-select"
											value={selectedContainerId()}
											onChange={(event) => setSelectedContainerId(event.currentTarget.value)}
											class="mt-2 flex h-11 w-full border border-[var(--border)] bg-[var(--input)] px-3 py-2 text-sm text-[var(--foreground)]"
										>
											<For each={service()!.container_ids}>
												{(containerId) => <option value={containerId}>{containerId}</option>}
											</For>
										</select>
									</div>

									<Show when={selectedContainerId()}>
										<ContainerMonitor containerId={selectedContainerId()} />
									</Show>
								</Show>
							</CardContent>
						</Card>
					</TabsContent>

					<TabsContent value="advanced">
						<div class="grid gap-6 xl:grid-cols-2">
							<Card>
								<CardHeader>
									<CardTitle>service actions</CardTitle>
									<CardDescription>
										use the unified service actions to control runtime state.
									</CardDescription>
								</CardHeader>
								<CardContent class="flex flex-wrap gap-3">
									<Button
										variant="secondary"
										isLoading={pendingAction() === "start"}
										onClick={() => void startService()}
									>
										start
									</Button>
									<Button
										variant="secondary"
										isLoading={pendingAction() === "stop"}
										onClick={() => void stopService()}
									>
										stop
									</Button>
									<Button
										variant="secondary"
										isLoading={pendingAction() === "restart"}
										onClick={() => void restartService()}
									>
										restart
									</Button>
									<Button
										variant="outline"
										isLoading={pendingAction() === "delete"}
										onClick={() => void deleteService()}
									>
										delete
									</Button>
								</CardContent>
							</Card>

							<Card>
								<CardHeader>
									<CardTitle>legacy route</CardTitle>
									<CardDescription>
										advanced service-specific settings still remain available on the legacy detail
										route while the unified view settles in.
									</CardDescription>
								</CardHeader>
								<CardContent>
									<Show
										when={legacyDetailHref()}
										fallback={
											<p class="text-sm text-[var(--muted-foreground)]">
												no legacy route is available for this service.
											</p>
										}
									>
										<A href={legacyDetailHref()!}>
											<Button variant="outline">open legacy detail</Button>
										</A>
									</Show>
								</CardContent>
							</Card>

							<Show when={database()}>
								<Card>
									<CardHeader>
										<CardTitle>database access</CardTitle>
										<CardDescription>
											enable or disable public access and the optional database proxy from the
											unified view.
										</CardDescription>
									</CardHeader>
									<CardContent class="space-y-4">
										<Input
											label="public port"
											type="number"
											value={externalPort()}
											onInput={(event) => setExternalPort(event.currentTarget.value)}
											description="leave empty to let the platform choose a port"
										/>
										<div class="flex flex-wrap gap-3">
											<Button
												variant="secondary"
												isLoading={pendingAction() === "database-exposure"}
												onClick={() => void toggleDatabaseExposure(true)}
											>
												enable public access
											</Button>
											<Button
												variant="outline"
												isLoading={pendingAction() === "database-exposure"}
												onClick={() => void toggleDatabaseExposure(false)}
											>
												disable public access
											</Button>
										</div>

										<Show when={database()!.db_type === "postgres"}>
											<div class="space-y-4 border-t border-[var(--border)] pt-4">
												<Input
													label="proxy port"
													type="number"
													value={proxyExternalPort()}
													onInput={(event) => setProxyExternalPort(event.currentTarget.value)}
													description="optional public proxy port"
												/>
												<div class="flex flex-wrap gap-3">
													<Button
														variant="secondary"
														isLoading={pendingAction() === "database-proxy"}
														onClick={() => void toggleDatabaseProxy(true)}
													>
														enable proxy
													</Button>
													<Button
														variant="outline"
														isLoading={pendingAction() === "database-proxy"}
														onClick={() => void toggleDatabaseProxy(false)}
													>
														disable proxy
													</Button>
													<Button
														variant="secondary"
														isLoading={pendingAction() === "database-pitr"}
														onClick={() => void toggleDatabasePitr(true)}
													>
														enable pitr
													</Button>
													<Button
														variant="outline"
														isLoading={pendingAction() === "database-pitr"}
														onClick={() => void toggleDatabasePitr(false)}
													>
														disable pitr
													</Button>
												</div>
											</div>
										</Show>
									</CardContent>
								</Card>
							</Show>

							<Show when={queue()}>
								<Card>
									<CardHeader>
										<CardTitle>queue access</CardTitle>
										<CardDescription>
											enable or disable public access for this template-backed service.
										</CardDescription>
									</CardHeader>
									<CardContent class="space-y-4">
										<Input
											label="public port"
											type="number"
											value={externalPort()}
											onInput={(event) => setExternalPort(event.currentTarget.value)}
											description="leave empty to let the platform choose a port"
										/>
										<div class="flex flex-wrap gap-3">
											<Button
												variant="secondary"
												isLoading={pendingAction() === "queue-exposure"}
												onClick={() => void toggleQueueExposure(true)}
											>
												enable public access
											</Button>
											<Button
												variant="outline"
												isLoading={pendingAction() === "queue-exposure"}
												onClick={() => void toggleQueueExposure(false)}
											>
												disable public access
											</Button>
										</div>
									</CardContent>
								</Card>
							</Show>
						</div>
					</TabsContent>
				</Tabs>
			</Show>
		</div>
	);
};

export default ServiceDetail;
