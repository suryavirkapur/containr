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
	getServiceCertificates,
	getServiceDeployment,
	getServiceDeploymentLogs,
	getServiceHttpLogs,
	getServiceLogs,
	getServiceSettings,
	listServiceDeployments,
	reissueServiceCertificate,
	rollbackServiceDeployment,
	runServiceAction,
	triggerServiceDeployment,
	updateService,
	type Service as InventoryService,
	type ServiceAction,
	type ServiceSettings,
} from "../api/services";
import ContainerMonitor from "../components/ContainerMonitor";
import {
	normalizeServiceType,
	type Service as ServiceFormValue,
} from "../components/ServiceForm";
import { ServiceCertificatePanel } from "../components/service-detail/ServiceCertificatePanel";
import { ServiceDeploymentPanel } from "../components/service-detail/ServiceDeploymentPanel";
import {
	describeError,
	formatDate,
	statusVariant,
} from "../components/service-detail/formatters";
import { ServiceHttpLogsPanel } from "../components/service-detail/ServiceHttpLogsPanel";
import { ServiceLogsPanel } from "../components/service-detail/ServiceLogsPanel";
import { ServiceSettingsPanel } from "../components/service-detail/ServiceSettingsPanel";
import type { MetadataRow, SettingsFormState } from "../components/service-detail/types";
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
	PageHeader,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
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

const ServiceDetail: Component = () => {
	const params = useParams<{ id: string }>();
	const navigate = useNavigate();

	const [tab, setTab] = createSignal<DetailTab>("overview");
	const [pendingAction, setPendingAction] = createSignal<ServiceAction | null>(null);
	const [deploying, setDeploying] = createSignal(false);
	const [rollbacking, setRollbacking] = createSignal(false);
	const [reissuingCertificates, setReissuingCertificates] = createSignal(false);
	const [reissuingDomain, setReissuingDomain] = createSignal<string | null>(null);
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
	const [deploymentDetailResource, { refetch: refetchDeploymentDetail }] = createResource(
		() => {
			const serviceId = serviceResource()?.id;
			const deploymentId = selectedDeploymentId();
			return serviceId && deploymentId ? { serviceId, deploymentId } : null;
		},
		({ serviceId, deploymentId }) => getServiceDeployment(serviceId, deploymentId),
	);
	const [httpLogs, { refetch: refetchHttpLogs }] = createResource(
		() => {
			const current = serviceResource();
			return current?.public_http ? current.id : null;
		},
		(id) => getServiceHttpLogs(id, 200, 0),
	);
	const [certificates, { refetch: refetchCertificates }] = createResource(
		() => {
			const current = serviceResource();
			return current && current.domains.length > 0 ? current.id : null;
		},
		getServiceCertificates,
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
	const canManageCertificates = createMemo(
		() => (currentService()?.domains.length ?? 0) > 0,
	);
	const selectedDeployment = createMemo(() => {
		const detail = deploymentDetailResource();
		if (detail && detail.id === selectedDeploymentId()) {
			return detail;
		}
		return (deployments() ?? []).find(
			(deployment) => deployment.id === selectedDeploymentId(),
		);
	});
	const logMarkup = createMemo(() => parseAnsi(logs() ?? ""));
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
	const metadataRows = createMemo<MetadataRow[]>(() => {
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
		if (canManageCertificates()) {
			await refetchCertificates();
		}
		if (canDeploy()) {
			await refetchDeployments();
			await refetchServiceSettings();
			if (selectedDeploymentId()) {
				await refetchDeploymentDetail();
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

	const handleRollbackDeployment = async (rolloutStrategy?: string) => {
		const deploymentId = selectedDeploymentId();
		if (!deploymentId) {
			return;
		}

		setRollbacking(true);
		setFeedback(null);

		try {
			const deployment = await rollbackServiceDeployment(params.id, deploymentId, rolloutStrategy
				? { rollout_strategy: rolloutStrategy }
				: undefined);
			setSelectedDeploymentId(deployment.id);
			setTab("deployments");
			setFeedback({
				text: "rollback deployment queued",
				variant: "success",
			});
			await refreshAll();
		} catch (error) {
			setFeedback({
				text: describeError(error),
				variant: "destructive",
			});
		} finally {
			setRollbacking(false);
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

	const handleReissueCertificate = async (domain?: string) => {
		setReissuingCertificates(!domain);
		setReissuingDomain(domain ?? null);
		setFeedback(null);

		try {
			const response = await reissueServiceCertificate(
				params.id,
				domain ? { domain } : undefined,
			);
			setFeedback({
				text: response.message,
				variant: "success",
			});
			await refetchCertificates();
		} catch (error) {
			setFeedback({
				text: describeError(error),
				variant: "destructive",
			});
		} finally {
			setReissuingCertificates(false);
			setReissuingDomain(null);
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

								<Show when={canManageCertificates()}>
									<ServiceCertificatePanel
										domains={service().domains}
										certificates={certificates() ?? []}
										loading={Boolean(certificates.loading)}
										error={certificates.error}
										reissuingAll={reissuingCertificates() && !reissuingDomain()}
										reissuingDomain={reissuingDomain()}
										onRefresh={() => void refetchCertificates()}
										onReissue={(domain) =>
											void handleReissueCertificate(domain)
										}
									/>
								</Show>

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
									<ServiceSettingsPanel
										settingsForm={settingsForm()}
										settingsLoading={Boolean(serviceSettingsResource.loading)}
										settingsError={serviceSettingsResource.error}
										deployWebhookUrl={deployWebhookUrl()}
										saving={savingSettings()}
										onUpdateSetting={updateSettings}
										onCopyWebhook={() => void handleCopyWebhook()}
										onSave={() => void handleSaveSettings()}
									/>
								</Show>
							</TabsContent>

							<TabsContent value="logs" class="space-y-4">
								<ServiceLogsPanel
									logMarkup={logMarkup()}
									loading={Boolean(logs.loading)}
									error={logs.error}
									onRefresh={() => void refetchLogs()}
								/>
							</TabsContent>

							<TabsContent value="http" class="space-y-4">
								<Show when={canShowHttpLogs()}>
									<ServiceHttpLogsPanel
										logs={httpLogs() ?? []}
										loading={Boolean(httpLogs.loading)}
										error={httpLogs.error}
										onRefresh={() => void refetchHttpLogs()}
									/>
								</Show>
							</TabsContent>

							<TabsContent value="deployments" class="space-y-4">
								<Show when={canDeploy()}>
									<ServiceDeploymentPanel
										deployments={deployments() ?? []}
										deploymentsLoading={Boolean(deployments.loading)}
										deploymentsError={deployments.error}
										selectedDeploymentId={selectedDeploymentId()}
										onSelectDeployment={setSelectedDeploymentId}
										selectedDeployment={selectedDeployment()}
										selectedDeploymentLoading={Boolean(deploymentDetailResource.loading)}
										selectedDeploymentError={deploymentDetailResource.error}
										deploymentLogs={deploymentLogs() ?? []}
										deploymentLogsLoading={Boolean(deploymentLogs.loading)}
										deploymentLogsError={deploymentLogs.error}
										deploying={deploying()}
										rollbacking={rollbacking()}
										onDeploy={() => void handleDeploy()}
										onRollback={(rolloutStrategy) =>
											void handleRollbackDeployment(rolloutStrategy)
										}
										onRefreshDeployments={() => void refetchDeployments()}
										onRefreshDeploymentDetails={() => void refetchDeploymentDetail()}
										onRefreshDeploymentLogs={() => void refetchDeploymentLogs()}
									/>
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
