import { A, useNavigate, useParams } from "@solidjs/router";
import {
	type Component,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	Show,
} from "solid-js";

import {
	deleteService,
	getService,
	getServiceDeploymentLogs,
	getServiceHttpLogs,
	getServiceLogs,
	getServiceSettings,
	listServiceDeployments,
	runServiceAction,
	triggerServiceDeployment,
	updateService,
	type HttpRequestLog,
	type Service as InventoryService,
	type ServiceAction,
	type ServiceDeployment,
	type ServiceSettings,
} from "../api/services";
import ContainerMonitor from "../components/ContainerMonitor";
import EnvVarEditor from "../components/EnvVarEditor";
import ServiceForm, {
	normalizeServiceType,
	type Service as ServiceFormValue,
} from "../components/ServiceForm";
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
	Switch,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	Textarea,
} from "../components/ui";
import { parseAnsi } from "../utils/ansi";
import { mapServiceToRequest, type EditableEnvVar } from "../utils/projectEditor";

type DetailTab =
	| "overview"
	| "settings"
	| "logs"
	| "http"
	| "deployments"
	| "containers";

type Feedback = {
	text: string;
	variant: "default" | "destructive" | "success";
};

type SettingsFormState = {
	githubUrl: string;
	branch: string;
	rolloutStrategy: string;
	envVars: EditableEnvVar[];
	service: ServiceFormValue;
	autoDeployEnabled: boolean;
	autoDeployWatchPathsText: string;
	cleanupStaleDeployments: boolean;
	webhookPath: string;
	regenerateWebhookToken: boolean;
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

const httpStatusVariant = (
	status: number,
): "outline" | "success" | "warning" | "error" => {
	if (status >= 500) {
		return "error";
	}
	if (status >= 400) {
		return "warning";
	}
	if (status >= 200 && status < 400) {
		return "success";
	}
	return "outline";
};

const serviceCategoryLabel = (service: InventoryService): string => {
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

const runtimeLabel = (service: InventoryService): string => {
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

const endpointLabel = (service: InventoryService): string => {
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

const formatDate = (value?: string | null): string => {
	if (!value) {
		return "n/a";
	}

	return new Date(value).toLocaleString();
};

const formatDeploymentStatus = (deployment: ServiceDeployment): string =>
	deployment.status.replaceAll("_", " ");

const editableEntries = (
	entries: { key: string; value: string; secret: boolean }[],
): EditableEnvVar[] => entries.map((entry) => ({ ...entry }));

const serviceSettingsToFormState = (settings: ServiceSettings): SettingsFormState => ({
	githubUrl: settings.github_url,
	branch: settings.branch,
	rolloutStrategy: settings.rollout_strategy,
	envVars: editableEntries(settings.env_vars),
	service: {
		name: settings.service.name,
		image: settings.service.image ?? "",
		service_type: normalizeServiceType(settings.service.service_type),
		port: settings.service.port,
		expose_http: settings.service.expose_http,
		domains: [...settings.service.domains],
		additional_ports: [...settings.service.additional_ports],
		replicas: settings.service.replicas,
		memory_limit_mb: settings.service.memory_limit_mb ?? null,
		cpu_limit: settings.service.cpu_limit ?? null,
		depends_on: [...settings.service.depends_on],
		health_check_path: settings.service.health_check?.path ?? "",
		health_check_interval_secs: settings.service.health_check?.interval_secs ?? 30,
		health_check_timeout_secs: settings.service.health_check?.timeout_secs ?? 5,
		health_check_retries: settings.service.health_check?.retries ?? 3,
		restart_policy: settings.service.restart_policy,
		registry_auth: settings.service.registry_auth
			? {
					server: settings.service.registry_auth.server ?? "",
					username: settings.service.registry_auth.username,
					password: settings.service.registry_auth.password,
				}
			: null,
		env_vars: editableEntries(settings.service.env_vars),
		build_context: settings.service.build_context ?? "",
		dockerfile_path: settings.service.dockerfile_path ?? "",
		build_target: settings.service.build_target ?? "",
		build_args: editableEntries(settings.service.build_args),
		command: settings.service.command ?? [],
		entrypoint: settings.service.entrypoint ?? [],
		working_dir: settings.service.working_dir ?? "",
		mounts: settings.service.mounts.map((mount) => ({
			name: mount.name,
			target: mount.target,
			read_only: Boolean(mount.read_only),
		})),
	},
	autoDeployEnabled: settings.auto_deploy.enabled,
	autoDeployWatchPathsText: settings.auto_deploy.watch_paths.join("\n"),
	cleanupStaleDeployments: settings.auto_deploy.cleanup_stale_deployments,
	webhookPath: settings.auto_deploy.webhook_path,
	regenerateWebhookToken: false,
});

const textToWatchPaths = (value: string): string[] =>
	Array.from(
		new Set(
			value
				.split(/[\n,]+/)
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0),
		),
	);

const requestLabel = (request: HttpRequestLog): string =>
	`${request.method} ${request.path}`;

const ServiceDetail: Component = () => {
	const params = useParams<{ id: string }>();
	const navigate = useNavigate();

	const [tab, setTab] = createSignal<DetailTab>("overview");
	const [pendingAction, setPendingAction] = createSignal<ServiceAction | null>(null);
	const [deploying, setDeploying] = createSignal(false);
	const [deleting, setDeleting] = createSignal(false);
	const [savingSettings, setSavingSettings] = createSignal(false);
	const [selectedContainerId, setSelectedContainerId] = createSignal("");
	const [selectedDeploymentId, setSelectedDeploymentId] = createSignal("");
	const [feedback, setFeedback] = createSignal<Feedback | null>(null);
	const [settingsForm, setSettingsForm] = createSignal<SettingsFormState | null>(null);

	const [serviceResource, { refetch: refetchService }] = createResource(
		() => params.id,
		getService,
	);
	const [logs, { refetch: refetchLogs }] = createResource(() => params.id, (id) =>
		getServiceLogs(id, 300),
	);
	const [deployments, { refetch: refetchDeployments }] = createResource(
		() => {
			const current = serviceResource();
			return current && current.resource_kind === "app_service" ? current.id : null;
		},
		listServiceDeployments,
	);
	const [deploymentLogs, { refetch: refetchDeploymentLogs }] = createResource(
		() => {
			const serviceId = serviceResource()?.id;
			const deploymentId = selectedDeploymentId();
			return serviceId && deploymentId ? { serviceId, deploymentId } : null;
		},
		({ serviceId, deploymentId }) => getServiceDeploymentLogs(serviceId, deploymentId, 200, 0),
	);
	const [httpLogs, { refetch: refetchHttpLogs }] = createResource(
		() => {
			const current = serviceResource();
			return current?.public_http ? current.id : null;
		},
		(id) => getServiceHttpLogs(id, 200, 0),
	);
	const [serviceSettingsResource, { refetch: refetchServiceSettings }] = createResource(
		() => {
			const current = serviceResource();
			return current && current.resource_kind === "app_service" ? current.id : null;
		},
		getServiceSettings,
	);

	createEffect(() => {
		const containerIds = serviceResource()?.container_ids ?? [];
		if (!containerIds.includes(selectedContainerId())) {
			setSelectedContainerId(containerIds[0] ?? "");
		}
	});

	createEffect(() => {
		const rows = deployments() ?? [];
		const current = selectedDeploymentId();
		if (!rows.some((deployment) => deployment.id === current)) {
			setSelectedDeploymentId(rows[0]?.id ?? "");
		}
	});

	createEffect(() => {
		const settings = serviceSettingsResource();
		if (settings) {
			setSettingsForm(serviceSettingsToFormState(settings));
		}
	});

	createEffect(() => {
		if (tab() === "settings" && serviceResource()?.resource_kind !== "app_service") {
			setTab("overview");
		}
		if (tab() === "http" && !serviceResource()?.public_http) {
			setTab("overview");
		}
		if (tab() === "deployments" && serviceResource()?.resource_kind !== "app_service") {
			setTab("overview");
		}
	});

	const currentService = createMemo(() => serviceResource());
	const canDeploy = createMemo(() => currentService()?.resource_kind === "app_service");
	const canEditSettings = createMemo(() => currentService()?.resource_kind === "app_service");
	const canShowHttpLogs = createMemo(() => Boolean(currentService()?.public_http));
	const selectedDeployment = createMemo(() =>
		(deployments() ?? []).find((deployment) => deployment.id === selectedDeploymentId()),
	);
	const logMarkup = createMemo(() => parseAnsi(logs() ?? ""));
	const deploymentLogMarkup = createMemo(() => parseAnsi((deploymentLogs() ?? []).join("\n")));
	const deployWebhookUrl = createMemo(() => {
		const path = settingsForm()?.webhookPath;
		if (!path) {
			return "";
		}
		if (typeof window === "undefined") {
			return path;
		}
		return new URL(path, window.location.origin).toString();
	});
	const endpointDetails = createMemo(() => {
		const current = currentService();
		if (!current) {
			return [];
		}

		return [
			...current.default_urls,
			...current.domains.map((domain) => `https://${domain}`),
			current.proxy_connection_string,
			current.connection_string,
			current.internal_host && current.port ? `${current.internal_host}:${current.port}` : null,
		].filter((value): value is string => Boolean(value?.trim()));
	});
	const metadataRows = createMemo(() => {
		const current = currentService();
		if (!current) {
			return [];
		}

		return [
			{ label: "service id", value: current.id },
			{ label: "group id", value: current.group_id ?? "standalone" },
			{ label: "network", value: current.network_name },
			{ label: "deployment id", value: current.deployment_id ?? "n/a" },
			{ label: "created", value: formatDate(current.created_at) },
			{ label: "updated", value: formatDate(current.updated_at) },
		];
	});

	const refreshAll = async () => {
		await refetchService();
		await refetchLogs();
		if (canShowHttpLogs()) {
			await refetchHttpLogs();
		}
		if (canDeploy()) {
			await refetchDeployments();
			await refetchServiceSettings();
			if (selectedDeploymentId()) {
				await refetchDeploymentLogs();
			}
		}
	};

	const updateSettings = <K extends keyof SettingsFormState>(
		key: K,
		value: SettingsFormState[K],
	) => {
		setSettingsForm((current) => (current ? { ...current, [key]: value } : current));
	};

	const handleAction = async (action: ServiceAction) => {
		setPendingAction(action);
		setFeedback(null);

		try {
			await runServiceAction(params.id, action);
			setFeedback({
				text: `service ${action} completed`,
				variant: "success",
			});
			await refreshAll();
		} catch (error) {
			setFeedback({
				text: describeError(error),
				variant: "destructive",
			});
		} finally {
			setPendingAction(null);
		}
	};

	const handleDeploy = async () => {
		setDeploying(true);
		setFeedback(null);

		try {
			const deployment = await triggerServiceDeployment(params.id);
			setSelectedDeploymentId(deployment.id);
			setTab("deployments");
			setFeedback({
				text: "deployment queued",
				variant: "success",
			});
			await refreshAll();
		} catch (error) {
			setFeedback({
				text: describeError(error),
				variant: "destructive",
			});
		} finally {
			setDeploying(false);
		}
	};

	const handleSaveSettings = async () => {
		const current = settingsForm();
		if (!current) {
			return;
		}

		setSavingSettings(true);
		setFeedback(null);

		try {
			await updateService(params.id, {
				github_url: current.githubUrl.trim(),
				branch: current.branch.trim() || "main",
				env_vars: current.envVars,
				rollout_strategy: current.rolloutStrategy,
				auto_deploy: {
					enabled: current.autoDeployEnabled,
					watch_paths: textToWatchPaths(current.autoDeployWatchPathsText),
					cleanup_stale_deployments: current.cleanupStaleDeployments,
					regenerate_webhook_token: current.regenerateWebhookToken || undefined,
				},
				service: mapServiceToRequest(current.service),
			});

			setFeedback({
				text: "settings saved; deploy to apply runtime changes",
				variant: "success",
			});
			setSettingsForm((form) =>
				form ? { ...form, regenerateWebhookToken: false } : form,
			);
			await refreshAll();
		} catch (error) {
			setFeedback({
				text: describeError(error),
				variant: "destructive",
			});
		} finally {
			setSavingSettings(false);
		}
	};

	const handleCopyWebhook = async () => {
		const url = deployWebhookUrl();
		if (!url) {
			return;
		}

		try {
			await navigator.clipboard.writeText(url);
			setFeedback({
				text: "deploy webhook copied",
				variant: "success",
			});
		} catch {
			setFeedback({
				text: "failed to copy deploy webhook",
				variant: "destructive",
			});
		}
	};

	const handleDelete = async () => {
		if (!confirm("delete this service?")) {
			return;
		}

		setDeleting(true);
		setFeedback(null);

		try {
			await deleteService(params.id);
			navigate("/services");
		} catch (error) {
			setFeedback({
				text: describeError(error),
				variant: "destructive",
			});
			setDeleting(false);
		}
	};

	return (
		<div class="space-y-8">
			<Show
				when={currentService()}
				fallback={
					<Show
						when={serviceResource.error}
						fallback={
							<div class="space-y-6">
								<Skeleton class="h-28 w-full" />
								<Skeleton class="h-80 w-full" />
							</div>
						}
					>
						<Alert variant="destructive" title="failed to load service">
							{describeError(serviceResource.error)}
						</Alert>
					</Show>
				}
			>
				{(service) => (
					<>
						<PageHeader
							eyebrow="service detail"
							title={service().name}
							description={`${serviceTypeLabel(service().service_type)} in the ${serviceCategoryLabel(
								service(),
							)} service model.`}
							actions={
								<>
									<A href="/services">
										<Button variant="outline">all services</Button>
									</A>
									<Button
										variant="secondary"
										isLoading={pendingAction() === "start"}
										onClick={() => void handleAction("start")}
									>
										start
									</Button>
									<Button
										variant="secondary"
										isLoading={pendingAction() === "stop"}
										onClick={() => void handleAction("stop")}
									>
										stop
									</Button>
									<Button
										variant="secondary"
										isLoading={pendingAction() === "restart"}
										onClick={() => void handleAction("restart")}
									>
										restart
									</Button>
									<Show when={canDeploy()}>
										<Button isLoading={deploying()} onClick={() => void handleDeploy()}>
											deploy
										</Button>
									</Show>
									<Button variant="danger" isLoading={deleting()} onClick={() => void handleDelete()}>
										delete
									</Button>
								</>
							}
						/>

						<Show when={feedback()}>
							{(currentFeedback) => (
								<Alert
									variant={currentFeedback().variant}
									title={currentFeedback().variant === "success" ? "updated" : "error"}
								>
									{currentFeedback().text}
								</Alert>
							)}
						</Show>

						<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
							<Card>
								<CardContent class="space-y-2">
									<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
										status
									</p>
									<Badge variant={statusVariant(service().status)}>{service().status}</Badge>
									<p class="text-sm text-[var(--muted-foreground)]">{runtimeLabel(service())}</p>
								</CardContent>
							</Card>
							<Card>
								<CardContent class="space-y-2">
									<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
										service type
									</p>
									<p class="font-serif text-3xl text-[var(--foreground)]">
										{serviceTypeLabel(service().service_type)}
									</p>
									<p class="text-sm text-[var(--muted-foreground)]">
										{serviceCategoryLabel(service())}
									</p>
								</CardContent>
							</Card>
							<Card>
								<CardContent class="space-y-2">
									<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
										network
									</p>
									<p class="font-serif text-3xl text-[var(--foreground)]">
										{service().project_name || service().network_name}
									</p>
									<p class="text-sm text-[var(--muted-foreground)]">{service().network_name}</p>
								</CardContent>
							</Card>
							<Card>
								<CardContent class="space-y-2">
									<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
										endpoint
									</p>
									<p class="font-mono text-sm text-[var(--foreground)]">{endpointLabel(service())}</p>
									<p class="text-sm text-[var(--muted-foreground)]">
										{service().container_ids.length} tracked containers
									</p>
								</CardContent>
							</Card>
						</div>

						<Tabs value={tab()} onValueChange={(value) => setTab(value as DetailTab)}>
							<TabsList>
								<TabsTrigger value="overview">overview</TabsTrigger>
								<Show when={canEditSettings()}>
									<TabsTrigger value="settings">settings</TabsTrigger>
								</Show>
								<TabsTrigger value="logs">logs</TabsTrigger>
								<Show when={canShowHttpLogs()}>
									<TabsTrigger value="http">http</TabsTrigger>
								</Show>
								<Show when={canDeploy()}>
									<TabsTrigger value="deployments">deployments</TabsTrigger>
								</Show>
								<TabsTrigger value="containers">containers</TabsTrigger>
							</TabsList>

							<TabsContent value="overview" class="space-y-4">
								<Card>
									<CardHeader>
										<CardTitle>connectivity</CardTitle>
										<CardDescription>
											URLs, ports, and connection strings exposed by this service.
										</CardDescription>
									</CardHeader>
									<CardContent>
										<Show
											when={endpointDetails().length > 0}
											fallback={
												<p class="text-sm text-[var(--muted-foreground)]">
													no public or connection endpoints are currently available.
												</p>
											}
										>
											<div class="space-y-3">
												<For each={endpointDetails()}>
													{(value) => (
														<div class="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-4 py-3 font-mono text-xs text-[var(--foreground)]">
															{value}
														</div>
													)}
												</For>
											</div>
										</Show>
									</CardContent>
								</Card>

								<Card>
									<CardHeader>
										<CardTitle>metadata</CardTitle>
										<CardDescription>
											Canonical service identifiers and timestamps.
										</CardDescription>
									</CardHeader>
									<CardContent>
										<div class="divide-y divide-[var(--border)] border border-[var(--border)]">
											<For each={metadataRows()}>
												{(row) => (
													<div class="flex flex-col gap-2 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
														<p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
															{row.label}
														</p>
														<p class="font-mono text-xs text-[var(--foreground)]">{row.value}</p>
													</div>
												)}
											</For>
										</div>
									</CardContent>
								</Card>
							</TabsContent>

							<TabsContent value="settings" class="space-y-4">
								<Show when={canEditSettings()}>
									<>
										<Alert title="save config, then deploy">
											Settings are stored immediately, but runtime changes only apply after the next deployment.
										</Alert>

										<Show when={serviceSettingsResource.error}>
											<Alert variant="destructive" title="failed to load settings">
												{describeError(serviceSettingsResource.error)}
											</Alert>
										</Show>

										<Show when={serviceSettingsResource.loading && !settingsForm()}>
											<Skeleton class="h-80 w-full" />
										</Show>

										<Show when={settingsForm()}>
											{(form) => (
												<div class="space-y-4">
													<Card>
														<CardHeader>
															<CardTitle>repository</CardTitle>
															<CardDescription>
																Git source and rollout behavior for this service.
															</CardDescription>
														</CardHeader>
														<CardContent class="grid gap-4 md:grid-cols-2">
															<Input
																label="github url"
																value={form().githubUrl}
																onInput={(event) => updateSettings("githubUrl", event.currentTarget.value)}
																placeholder="https://github.com/org/repo.git"
															/>
															<Input
																label="branch"
																value={form().branch}
																onInput={(event) => updateSettings("branch", event.currentTarget.value)}
																placeholder="main"
															/>
															<div class="space-y-2 md:col-span-2">
																<label
																	class="text-sm font-medium text-[var(--foreground)]"
																	for="rollout-strategy"
																>
																	rollout strategy
																</label>
																<select
																	id="rollout-strategy"
																	class="flex h-11 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--input)] px-3 py-2 text-sm font-medium text-[var(--foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
																	value={form().rolloutStrategy}
																	onChange={(event) =>
																		updateSettings("rolloutStrategy", event.currentTarget.value)
																	}
																>
																	<option value="stop_first">stop first</option>
																	<option value="start_first">start first</option>
																</select>
															</div>
														</CardContent>
													</Card>

													<EnvVarEditor
														envVars={form().envVars}
														onChange={(envVars) => updateSettings("envVars", envVars)}
														title="shared environment variables"
														description="applied to every container in this repository service."
														emptyText="no shared variables configured"
														addLabel="add shared variable"
													/>

													<div class="space-y-2">
														<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
															service definition
														</p>
														<h2 class="font-serif text-2xl text-[var(--foreground)]">
															build, runtime, and storage
														</h2>
													</div>
													<ServiceForm
														service={form().service}
														index={0}
														allServices={[form().service]}
														showServiceTypePicker={false}
														onUpdate={(_, next) => updateSettings("service", next)}
														onRemove={() => {}}
														allowRemove={false}
													/>

													<Card>
														<CardHeader>
															<CardTitle>auto deploy</CardTitle>
															<CardDescription>
																Control github push deploys, watched paths, and CI-triggered deploy hooks.
															</CardDescription>
														</CardHeader>
														<CardContent class="space-y-4">
															<div class="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-4 py-4">
																<div class="space-y-1">
																	<p class="font-medium text-[var(--foreground)]">github push auto-deploy</p>
																	<p class="text-sm text-[var(--muted-foreground)]">
																		Deploy automatically when matching pushes land on the tracked branch.
																	</p>
																</div>
																<Switch
																	checked={form().autoDeployEnabled}
																	onChange={(checked) =>
																		updateSettings("autoDeployEnabled", checked)
																	}
																/>
															</div>

															<div class="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-4 py-4">
																<div class="space-y-1">
																	<p class="font-medium text-[var(--foreground)]">cleanup stale auto-deploys</p>
																	<p class="text-sm text-[var(--muted-foreground)]">
																		Stop queued or in-progress auto-deploys when a newer deploy is triggered.
																	</p>
																</div>
																<Switch
																	checked={form().cleanupStaleDeployments}
																	onChange={(checked) =>
																		updateSettings("cleanupStaleDeployments", checked)
																	}
																/>
															</div>

															<Textarea
																label="watch paths"
																description="Optional newline-delimited repo paths or glob patterns. Leave empty to deploy on every push."
																value={form().autoDeployWatchPathsText}
																onInput={(event) =>
																	updateSettings(
																		"autoDeployWatchPathsText",
																		event.currentTarget.value,
																	)
																}
																placeholder={"apps/api/**\nDockerfile\npackage.json"}
																class="min-h-32 font-mono"
															/>

															<Input
																label="deploy webhook"
																description="Use this webhook from CI to trigger a deployment without GitHub push webhooks."
																value={deployWebhookUrl()}
																readOnly
																class="font-mono text-xs"
															/>

															<div class="flex flex-wrap gap-3">
																<Button variant="outline" onClick={() => void handleCopyWebhook()}>
																	copy webhook
																</Button>
																<Button
																	variant={form().regenerateWebhookToken ? "secondary" : "outline"}
																	onClick={() =>
																		updateSettings(
																			"regenerateWebhookToken",
																			!form().regenerateWebhookToken,
																		)
																	}
																>
																	{form().regenerateWebhookToken ? "token rotates on save" : "rotate token on save"}
																</Button>
															</div>
														</CardContent>
													</Card>

													<div class="flex justify-end">
														<Button isLoading={savingSettings()} onClick={() => void handleSaveSettings()}>
															save settings
														</Button>
													</div>
												</div>
											)}
										</Show>
									</>
								</Show>
							</TabsContent>

							<TabsContent value="logs" class="space-y-4">
								<Card>
									<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
										<div>
											<CardTitle>service logs</CardTitle>
											<CardDescription>
												Recent logs from the canonical service runtime endpoint.
											</CardDescription>
										</div>
										<Button variant="outline" onClick={() => void refetchLogs()}>
											refresh logs
										</Button>
									</CardHeader>
									<CardContent>
										<Show when={logs.error}>
											<Alert variant="destructive" title="failed to load logs">
												{describeError(logs.error)}
											</Alert>
										</Show>
										<Show when={logs.loading}>
											<Skeleton class="h-80 w-full" />
										</Show>
										<Show when={!logs.loading}>
											<div
												class="min-h-80 overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-black px-4 py-4 font-mono text-xs leading-6 text-white"
												innerHTML={logMarkup()}
											/>
										</Show>
									</CardContent>
								</Card>
							</TabsContent>

							<TabsContent value="http" class="space-y-4">
								<Show when={canShowHttpLogs()}>
									<Card>
										<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
											<div>
												<CardTitle>http request logs</CardTitle>
												<CardDescription>
													Recent request-level access logs captured by the proxy for this public service.
												</CardDescription>
											</div>
											<Button variant="outline" onClick={() => void refetchHttpLogs()}>
												refresh http logs
											</Button>
										</CardHeader>
										<CardContent>
											<Show when={httpLogs.error}>
												<Alert variant="destructive" title="failed to load http logs">
													{describeError(httpLogs.error)}
												</Alert>
											</Show>
											<Show when={httpLogs.loading}>
												<Skeleton class="h-64 w-full" />
											</Show>
											<Show
												when={!httpLogs.loading && (httpLogs()?.length ?? 0) > 0}
												fallback={
													<EmptyState
														title="no http requests yet"
														description="request logs will appear here after traffic reaches the service."
													/>
												}
											>
												<div class="space-y-3">
													<For each={httpLogs() ?? []}>
														{(request) => (
															<div class="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-4 py-4">
																<div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
																	<div class="space-y-2">
																		<div class="flex flex-wrap items-center gap-2">
																			<Badge variant="outline">{request.method}</Badge>
																			<Badge variant={httpStatusVariant(request.status)}>
																				{request.status}
																			</Badge>
																			<p class="text-xs text-[var(--muted-foreground)]">
																				{request.domain}
																			</p>
																		</div>
																		<p class="font-mono text-sm text-[var(--foreground)]">
																			{requestLabel(request)}
																			</p>
																			<p class="text-xs text-[var(--muted-foreground)]">
																				{request.protocol} {"->"} {request.upstream}
																			</p>
																	</div>
																	<p class="text-xs text-[var(--muted-foreground)]">
																		{formatDate(request.created_at)}
																	</p>
																</div>
															</div>
														)}
													</For>
												</div>
											</Show>
										</CardContent>
									</Card>
								</Show>
							</TabsContent>

							<TabsContent value="deployments" class="space-y-4">
								<Show when={canDeploy()}>
									<>
										<Card>
											<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
												<div>
													<CardTitle>service deployments</CardTitle>
													<CardDescription>
														Deployments are now scoped to the service endpoint surface.
													</CardDescription>
												</div>
												<Button isLoading={deploying()} onClick={() => void handleDeploy()}>
													deploy latest
												</Button>
											</CardHeader>
											<CardContent>
												<Show when={deployments.error}>
													<Alert variant="destructive" title="failed to load deployments">
														{describeError(deployments.error)}
													</Alert>
												</Show>
												<Show when={deployments.loading}>
													<Skeleton class="h-56 w-full" />
												</Show>
												<Show
													when={!deployments.loading && (deployments()?.length ?? 0) > 0}
													fallback={
														<EmptyState
															title="no deployments yet"
															description="queue a deployment to track rollout history for this service."
														/>
													}
												>
													<div class="divide-y divide-[var(--border)] border border-[var(--border)]">
														<For each={deployments() ?? []}>
															{(deployment) => (
																<button
																	type="button"
																	class={`flex w-full flex-col gap-3 px-4 py-4 text-left transition-colors hover:bg-[var(--muted)] ${
																		selectedDeploymentId() === deployment.id ? "bg-[var(--muted)]" : "bg-[var(--card)]"
																	}`}
																	onClick={() => setSelectedDeploymentId(deployment.id)}
																>
																	<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
																		<div class="space-y-1">
																			<p class="font-medium text-[var(--foreground)]">{deployment.commit_sha}</p>
																			<p class="text-sm text-[var(--muted-foreground)]">
																				{deployment.commit_message || "manual deployment"}
																			</p>
																		</div>
																		<div class="flex items-center gap-3">
																			<Badge variant={statusVariant(deployment.status)}>
																				{formatDeploymentStatus(deployment)}
																			</Badge>
																			<p class="text-xs text-[var(--muted-foreground)]">
																				{formatDate(deployment.created_at)}
																			</p>
																		</div>
																	</div>
																</button>
															)}
														</For>
													</div>
												</Show>
											</CardContent>
										</Card>

										<Show when={selectedDeployment()}>
											{(deployment) => (
												<Card>
													<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
														<div>
															<CardTitle>deployment logs</CardTitle>
															<CardDescription>
																{deployment().commit_message || "manual deployment"} · {deployment().commit_sha}
															</CardDescription>
														</div>
														<Button variant="outline" onClick={() => void refetchDeploymentLogs()}>
															refresh deployment logs
														</Button>
													</CardHeader>
													<CardContent>
														<Show when={deploymentLogs.error}>
															<Alert variant="destructive" title="failed to load deployment logs">
																{describeError(deploymentLogs.error)}
															</Alert>
														</Show>
														<Show when={deploymentLogs.loading}>
															<Skeleton class="h-80 w-full" />
														</Show>
														<Show when={!deploymentLogs.loading}>
															<div
																class="min-h-80 overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-black px-4 py-4 font-mono text-xs leading-6 text-white"
																innerHTML={deploymentLogMarkup()}
															/>
														</Show>
													</CardContent>
												</Card>
											)}
										</Show>
									</>
								</Show>
							</TabsContent>

							<TabsContent value="containers" class="space-y-4">
								<Card>
									<CardHeader>
										<CardTitle>runtime containers</CardTitle>
										<CardDescription>
											Inspect live container state, logs, volumes, and terminal access.
										</CardDescription>
									</CardHeader>
									<CardContent class="space-y-4">
										<Show
											when={service().container_ids.length > 0}
											fallback={
												<EmptyState
													title="no active containers"
													description="this service does not currently report any running container ids."
												/>
											}
										>
											<div class="flex flex-wrap gap-2">
												<For each={service().container_ids}>
													{(containerId) => (
														<Button
															variant={
																selectedContainerId() === containerId ? "secondary" : "outline"
															}
															size="sm"
															onClick={() => setSelectedContainerId(containerId)}
														>
															{containerId.slice(0, 12)}
														</Button>
													)}
												</For>
											</div>

											<Show when={selectedContainerId()}>
												<ContainerMonitor containerId={selectedContainerId()} defaultTab="overview" />
											</Show>
										</Show>
									</CardContent>
								</Card>
							</TabsContent>
						</Tabs>
					</>
				)}
			</Show>
		</div>
	);
};

export default ServiceDetail;
