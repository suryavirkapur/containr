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
	getServiceLogs,
	listServiceDeployments,
	runServiceAction,
	triggerServiceDeployment,
	type Service,
	type ServiceAction,
	type ServiceDeployment,
} from "../api/services";
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
	EmptyState,
	PageHeader,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../components/ui";
import { parseAnsi } from "../utils/ansi";

type DetailTab = "overview" | "logs" | "deployments" | "containers";
type Feedback = {
	text: string;
	variant: "default" | "destructive" | "success";
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

const formatDate = (value?: string | null): string => {
	if (!value) {
		return "n/a";
	}

	return new Date(value).toLocaleString();
};

const formatDeploymentStatus = (deployment: ServiceDeployment): string =>
	deployment.status.replaceAll("_", " ");

const ServiceDetail: Component = () => {
	const params = useParams<{ id: string }>();
	const navigate = useNavigate();

	const [tab, setTab] = createSignal<DetailTab>("overview");
	const [pendingAction, setPendingAction] = createSignal<ServiceAction | null>(null);
	const [deploying, setDeploying] = createSignal(false);
	const [deleting, setDeleting] = createSignal(false);
	const [selectedContainerId, setSelectedContainerId] = createSignal("");
	const [selectedDeploymentId, setSelectedDeploymentId] = createSignal("");
	const [feedback, setFeedback] = createSignal<Feedback | null>(null);

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

	const currentService = createMemo(() => serviceResource());
	const canDeploy = createMemo(() => currentService()?.resource_kind === "app_service");
	const selectedDeployment = createMemo(() =>
		(deployments() ?? []).find((deployment) => deployment.id === selectedDeploymentId()),
	);
	const logMarkup = createMemo(() => parseAnsi(logs() ?? ""));
	const deploymentLogMarkup = createMemo(() =>
		parseAnsi((deploymentLogs() ?? []).join("\n")),
	);
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
		if (canDeploy()) {
			await refetchDeployments();
			if (selectedDeploymentId()) {
				await refetchDeploymentLogs();
			}
		}
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
								<TabsTrigger value="logs">logs</TabsTrigger>
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
