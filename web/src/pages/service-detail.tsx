import { A, useNavigate, useParams } from "@solidjs/router";
import {
	createEffect,
	createResource,
	createSignal,
	For,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import {
	getService,
	getServiceCertificates,
	getServiceDeployment,
	getServiceHttpLogs,
	getServiceLogs,
	getServiceSettings,
	listServiceDeployments,
	reissueServiceCertificate,
	rollbackServiceDeployment,
} from "../api/services";
import { type BreadcrumbItem, Breadcrumbs } from "../components/Breadcrumbs";
import { LogViewer } from "../components/LogViewer";
import {
	EmptyBlock,
	KeyValueTable,
	LoadingBlock,
	Notice,
	PageTitle,
	Panel,
} from "../components/Plain";
import { StatCard } from "../components/StatCard";
import { StatusBadge, StatusDot } from "../components/StatusBadge";
import { type TabDef, Tabs } from "../components/Tabs";
import { useAppStore } from "../context/AppStore";
import { copyText, describeError, formatDateTime, formatList } from "../utils/format";

const useDeploymentLogStream = (serviceId: () => string, deploymentId: () => string | null) => {
	const [logs, setLogs] = createSignal<string[]>([]);
	const [isStreaming, setIsStreaming] = createSignal(false);
	let ws: WebSocket | null = null;
	let lastDeploymentId: string | null = null;

	const connect = () => {
		const depId = deploymentId();
		const svcId = serviceId();
		if (!depId || !svcId) return;

		disconnect();
		lastDeploymentId = depId;
		setLogs([]);
		setIsStreaming(true);

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = window.location.host;
		const token = localStorage.getItem("containr_token");
		const url = `${protocol}//${host}/api/services/${svcId}/deployments/${depId}/logs/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;

		try {
			ws = new WebSocket(url);
			ws.onopen = () => setIsStreaming(true);
			ws.onmessage = (event: MessageEvent<string>) => {
				const line = event.data;
				if (!line) return;
				setLogs((prev) => [...prev, line]);
			};
			ws.onerror = () => setIsStreaming(false);
			ws.onclose = () => {
				setIsStreaming(false);
				ws = null;
			};
		} catch {
			setIsStreaming(false);
		}
	};

	const disconnect = () => {
		if (ws) {
			ws.close();
			ws = null;
		}
		setIsStreaming(false);
	};

	createEffect(() => {
		const depId = deploymentId();
		if (depId && depId !== lastDeploymentId) {
			connect();
		}
	});

	onCleanup(() => disconnect());

	return { logs, isStreaming, connect, disconnect };
};

const endpointFor = (service: Awaited<ReturnType<typeof getService>>): string => {
	return (
		service.default_urls[0] ??
		service.proxy_connection_string ??
		service.connection_string ??
		(service.internal_host && service.port
			? `${service.internal_host}:${service.port}`
			: "internal only")
	);
};

const envText = (values: Array<{ key: string; value: string }>) =>
	values.map((entry) => `${entry.key}=${entry.value}`).join("\n");

const parseEnvText = (value: string) =>
	value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [key, ...rest] = line.split("=");
			return { key: key.trim(), value: rest.join("=").trim(), secret: false };
		});

const parseLines = (value: string) =>
	value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

const ServiceDetail = () => {
	const params = useParams();
	const navigate = useNavigate();
	const store = useAppStore();
	const serviceId = () => params.id ?? "";
	const [activeTab, setActiveTab] = createSignal("general");
	const [feedback, setFeedback] = createSignal<{ tone: "success" | "error"; text: string } | null>(
		null,
	);
	const [pendingAction, setPendingAction] = createSignal<string | null>(null);
	const [selectedDeploymentId, setSelectedDeploymentId] = createSignal<string | null>(null);
	const [settingsLoadedFor, setSettingsLoadedFor] = createSignal<string | null>(null);
	const [githubUrl, setGithubUrl] = createSignal("");
	const [branch, setBranch] = createSignal("");
	const [rolloutStrategy, setRolloutStrategy] = createSignal("");
	const [deployBranch, setDeployBranch] = createSignal("");
	const [deployCommitSha, setDeployCommitSha] = createSignal("");
	const [deployCommitMessage, setDeployCommitMessage] = createSignal("");
	const [deployRolloutStrategy, setDeployRolloutStrategy] = createSignal("");
	const [certificateDomain, setCertificateDomain] = createSignal("");
	const [envVarsText, setEnvVarsText] = createSignal("");
	const [watchPathsText, setWatchPathsText] = createSignal("");
	const [serviceJson, setServiceJson] = createSignal("{}");
	const [autoDeployEnabled, setAutoDeployEnabled] = createSignal(false);
	const [cleanupStale, setCleanupStale] = createSignal(false);

	const [service, { refetch: refetchService }] = createResource(serviceId, getService);
	const [settings, { refetch: refetchSettings }] = createResource(serviceId, getServiceSettings);
	const [logs, { refetch: refetchLogs }] = createResource(serviceId, (id) =>
		getServiceLogs(id, 300),
	);
	const [httpLogs, { refetch: refetchHttpLogs }] = createResource(serviceId, (id) =>
		getServiceHttpLogs(id, 200, 0),
	);
	const [deployments, { refetch: refetchDeployments }] = createResource(
		serviceId,
		listServiceDeployments,
	);
	const [certificates, { refetch: refetchCertificates }] = createResource(
		serviceId,
		getServiceCertificates,
	);
	const [selectedDeployment, { refetch: refetchSelectedDeployment }] = createResource(
		() => ({ currentServiceId: serviceId(), deploymentId: selectedDeploymentId() }),
		({ currentServiceId, deploymentId }) =>
			deploymentId ? getServiceDeployment(currentServiceId, deploymentId) : Promise.resolve(null),
	);
	const deploymentLogStream = useDeploymentLogStream(serviceId, selectedDeploymentId);

	const pendingDeployments = () =>
		(deployments() ?? []).filter((d) => d.status === "pending" || d.status === "starting").length;

	const tabs = (): TabDef[] => [
		{ id: "general", label: "General" },
		{ id: "config", label: "Configuration" },
		{ id: "logs", label: "Service Logs" },
		{ id: "http-logs", label: "HTTP Logs" },
		{
			id: "deployments",
			label: "Deployments",
			badge: pendingDeployments() > 0 ? pendingDeployments() : undefined,
		},
		{ id: "certificates", label: "Certificates" },
	];

	const breadcrumbs = (): BreadcrumbItem[] => [
		{ label: "Services", href: "/services" },
		{ label: service()?.name ?? "Loading..." },
	];

	createEffect(() => {
		const currentSettings = settings();
		if (!currentSettings || settingsLoadedFor() === currentSettings.service_id) return;
		setSettingsLoadedFor(currentSettings.service_id);
		setGithubUrl(currentSettings.github_url);
		setBranch(currentSettings.branch);
		setRolloutStrategy(currentSettings.rollout_strategy);
		setDeployBranch(currentSettings.branch);
		setDeployRolloutStrategy(currentSettings.rollout_strategy);
		setEnvVarsText(envText(currentSettings.env_vars));
		setWatchPathsText(currentSettings.auto_deploy.watch_paths.join("\n"));
		setServiceJson(JSON.stringify(currentSettings.service, null, 2));
		setAutoDeployEnabled(currentSettings.auto_deploy.enabled);
		setCleanupStale(currentSettings.auto_deploy.cleanup_stale_deployments);
	});

	createEffect(() => {
		const rows = deployments();
		if (!rows || rows.length === 0) return;
		if (!selectedDeploymentId()) {
			setSelectedDeploymentId(rows[0].id);
		}
	});

	const refreshAll = async () => {
		await Promise.all([
			refetchService(),
			refetchSettings(),
			refetchLogs(),
			refetchHttpLogs(),
			refetchDeployments(),
			refetchCertificates(),
			refetchSelectedDeployment(),
			store.loadServices(),
		]);
	};

	const runAction = async (action: "start" | "stop" | "restart") => {
		setPendingAction(action);
		setFeedback(null);
		try {
			await store.runAction(serviceId(), action);
			setFeedback({ tone: "success", text: `${action} request accepted` });
			setPendingAction(null);
			void refreshAll();
		} catch (error) {
			setFeedback({ tone: "error", text: describeError(error) });
			setPendingAction(null);
		}
	};

	const deploy = async () => {
		setPendingAction("deploy");
		setFeedback(null);
		try {
			await store.triggerDeploy(serviceId(), {
				branch: deployBranch().trim() || null,
				commit_sha: deployCommitSha().trim() || null,
				commit_message: deployCommitMessage().trim() || null,
				rollout_strategy: deployRolloutStrategy().trim() || null,
			});
			setFeedback({ tone: "success", text: "deployment queued" });
			setPendingAction(null);
			void refreshAll();
		} catch (error) {
			setFeedback({ tone: "error", text: describeError(error) });
			setPendingAction(null);
		}
	};

	const saveSettings = async (rotateWebhookToken = false) => {
		setPendingAction(rotateWebhookToken ? "rotate-webhook" : "save");
		setFeedback(null);
		try {
			const parsedService = JSON.parse(serviceJson());
			await store.updateService(serviceId(), {
				github_url: githubUrl().trim() || null,
				branch: branch().trim() || null,
				rollout_strategy: rolloutStrategy().trim() || null,
				env_vars: parseEnvText(envVarsText()),
				auto_deploy: {
					enabled: autoDeployEnabled(),
					cleanup_stale_deployments: cleanupStale(),
					watch_paths: parseLines(watchPathsText()),
					regenerate_webhook_token: rotateWebhookToken,
				},
				service: parsedService,
			});
			setFeedback({
				tone: "success",
				text: rotateWebhookToken ? "webhook token rotated" : "settings saved",
			});
			setPendingAction(null);
			void refreshAll();
		} catch (error) {
			setFeedback({ tone: "error", text: describeError(error) });
			setPendingAction(null);
		}
	};

	const rollback = async (deploymentId: string) => {
		setPendingAction(`rollback-${deploymentId}`);
		setFeedback(null);
		try {
			await rollbackServiceDeployment(serviceId(), deploymentId, {});
			setFeedback({ tone: "success", text: "rollback queued" });
			setPendingAction(null);
			void refreshAll();
		} catch (error) {
			setFeedback({ tone: "error", text: describeError(error) });
			setPendingAction(null);
		}
	};

	const reissueCertificates = async () => {
		setPendingAction("reissue-certificates");
		setFeedback(null);
		try {
			const response = await reissueServiceCertificate(serviceId(), {
				domain: certificateDomain().trim() || null,
			});
			setFeedback({ tone: "success", text: response.message });
			setPendingAction(null);
			void refetchCertificates();
		} catch (error) {
			setFeedback({ tone: "error", text: describeError(error) });
			setPendingAction(null);
		}
	};

	const removeService = async () => {
		if (!confirm("delete this service?")) return;
		setPendingAction("delete");
		setFeedback(null);
		try {
			await store.removeService(serviceId());
			navigate("/services");
		} catch (error) {
			setFeedback({ tone: "error", text: describeError(error) });
			setPendingAction(null);
		}
	};

	return (
		<div class="flex flex-col gap-6">
			<Breadcrumbs items={breadcrumbs()} />

			<Show when={service.loading}>
				<LoadingBlock message="Loading service..." />
			</Show>
			<Show when={service.error}>
				{(error) => <Notice tone="error">Failed to load service: {describeError(error())}</Notice>}
			</Show>

			<Show when={service()}>
				{(currentService) => (
					<>
						<div class="flex flex-col sm:flex-row justify-between items-start gap-4">
							<div>
								<h1 class="text-3xl font-bold tracking-tight">{currentService().name}</h1>
								<p class="text-muted-foreground mt-1">
									{currentService().service_type.replace(/_/g, " ")} /{" "}
									{currentService().resource_kind.replace(/_/g, " ")}
								</p>
							</div>
							<div class="flex items-center gap-3">
								<div class="flex items-center gap-2">
									<StatusBadge status={currentService().status} size="md" showDot />
								</div>
								<button
									type="button"
									onClick={() => void refreshAll()}
									class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
								>
									Refresh
								</button>
							</div>
						</div>

						{feedback() ? <Notice tone={feedback()!.tone}>{feedback()!.text}</Notice> : null}

						<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
							<StatCard
								title="Status"
								value={currentService().status}
								iconBg="bg-secondary"
								icon={<StatusDot status={currentService().status} size="md" />}
							/>
							<StatCard
								title="Endpoint"
								value={
									endpointFor(currentService()).slice(0, 20) +
									(endpointFor(currentService()).length > 20 ? "..." : "")
								}
								description="Primary endpoint"
								iconBg="bg-blue-500/10"
								icon={<span class="text-blue-600">→</span>}
							/>
							<StatCard
								title="Containers"
								value={currentService().container_ids.length}
								description="Active instances"
								iconBg="bg-purple-500/10"
								icon={<span class="text-purple-600">□</span>}
							/>
							<StatCard
								title="Domains"
								value={currentService().domains.length}
								description="Mapped domains"
								iconBg="bg-green-500/10"
								icon={<span class="text-green-600">◎</span>}
							/>
						</div>

						<Tabs tabs={tabs()} activeTab={activeTab()} onTabChange={setActiveTab}>
							<Switch>
								<Match when={activeTab() === "general"}>
									<Panel title="Actions">
										<div class="flex flex-col gap-6">
											<div class="flex flex-wrap gap-2">
												<button
													type="button"
													class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
													onClick={() => void runAction("start")}
													disabled={pendingAction() === "start"}
												>
													Start
												</button>
												<button
													type="button"
													class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
													onClick={() => void runAction("stop")}
													disabled={pendingAction() === "stop"}
												>
													Stop
												</button>
												<button
													type="button"
													class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
													onClick={() => void runAction("restart")}
													disabled={pendingAction() === "restart"}
												>
													Restart
												</button>
												<button
													type="button"
													class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-destructive bg-background text-destructive hover:bg-destructive hover:text-destructive-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50 ml-auto"
													onClick={() => void removeService()}
													disabled={pendingAction() === "delete"}
												>
													Delete Service
												</button>
											</div>

											<div class="h-px bg-border my-2 w-full" />

											<div class="grid gap-4 sm:grid-cols-2">
												<label class="flex flex-col gap-2">
													<span class="text-sm font-medium leading-none">Deploy Branch</span>
													<input
														class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
														value={deployBranch()}
														onInput={(event) => setDeployBranch(event.currentTarget.value)}
														placeholder="Default branch if empty"
													/>
												</label>
												<label class="flex flex-col gap-2">
													<span class="text-sm font-medium leading-none">
														Deploy Rollout Strategy
													</span>
													<input
														class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
														value={deployRolloutStrategy()}
														onInput={(event) => setDeployRolloutStrategy(event.currentTarget.value)}
														placeholder="start_first or stop_first"
													/>
												</label>
												<label class="flex flex-col gap-2">
													<span class="text-sm font-medium leading-none">Commit SHA</span>
													<input
														class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
														value={deployCommitSha()}
														onInput={(event) => setDeployCommitSha(event.currentTarget.value)}
														placeholder="Optional"
													/>
												</label>
												<label class="flex flex-col gap-2">
													<span class="text-sm font-medium leading-none">Commit Message</span>
													<input
														class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
														value={deployCommitMessage()}
														onInput={(event) => setDeployCommitMessage(event.currentTarget.value)}
														placeholder="Optional"
													/>
												</label>
											</div>
											<div class="flex gap-2 pt-2">
												<button
													type="button"
													class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
													onClick={() => void deploy()}
													disabled={pendingAction() === "deploy"}
												>
													Deploy Now
												</button>
											</div>
										</div>
									</Panel>

									<Panel title="Summary">
										<KeyValueTable
											rows={[
												["Status", <StatusBadge status={currentService().status} />],
												[
													"Endpoint",
													<span class="font-mono bg-secondary/50 px-1.5 py-0.5 rounded">
														{endpointFor(currentService())}
													</span>,
												],
												[
													"Group",
													currentService().group_id ? (
														<A
															class="text-primary hover:underline"
															href={`/services?group=${currentService().group_id}`}
														>
															{currentService().project_name ?? currentService().group_id}
														</A>
													) : (
														<span class="text-muted-foreground">Isolated</span>
													),
												],
												["Domains", <span>{formatList(currentService().domains)}</span>],
												["Network", <span class="font-mono">{currentService().network_name}</span>],
												[
													"Containers",
													currentService().container_ids.length > 0 ? (
														<div class="flex flex-col gap-1">
															<For each={currentService().container_ids}>
																{(containerId) => (
																	<A
																		class="text-primary hover:underline font-mono"
																		href={`/containers/${containerId}`}
																	>
																		{containerId}
																	</A>
																)}
															</For>
														</div>
													) : (
														<span class="text-muted-foreground">None</span>
													),
												],
												[
													"Deployment ID",
													<span class="font-mono text-muted-foreground">
														{currentService().deployment_id ?? "N/A"}
													</span>,
												],
												["Created", <span>{formatDateTime(currentService().created_at)}</span>],
												["Updated", <span>{formatDateTime(currentService().updated_at)}</span>],
											]}
										/>
									</Panel>
								</Match>

								<Match when={activeTab() === "config"}>
									<Show when={settings.error}>
										{(error) => (
											<Notice tone="error">Settings unavailable: {describeError(error())}</Notice>
										)}
									</Show>
									<Show when={settings()}>
										{(currentSettings) => (
											<Panel
												title="Configuration"
												subtitle="Raw text and JSON only. Save to update the next deployment."
											>
												<form
													class="flex flex-col gap-6"
													onSubmit={(event) => {
														event.preventDefault();
														void saveSettings(false);
													}}
												>
													<div class="grid gap-4 sm:grid-cols-2">
														<label class="flex flex-col gap-2">
															<span class="text-sm font-medium leading-none">GitHub URL</span>
															<input
																class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																value={githubUrl()}
																onInput={(event) => setGithubUrl(event.currentTarget.value)}
															/>
														</label>
														<label class="flex flex-col gap-2">
															<span class="text-sm font-medium leading-none">Branch</span>
															<input
																class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																value={branch()}
																onInput={(event) => setBranch(event.currentTarget.value)}
															/>
														</label>
														<label class="flex flex-col gap-2">
															<span class="text-sm font-medium leading-none">Rollout Strategy</span>
															<input
																class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																value={rolloutStrategy()}
																onInput={(event) => setRolloutStrategy(event.currentTarget.value)}
															/>
														</label>
														<label class="flex flex-col gap-2">
															<span class="text-sm font-medium leading-none">
																Auto Deploy Enabled
															</span>
															<select
																class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																value={autoDeployEnabled() ? "yes" : "no"}
																onChange={(event) =>
																	setAutoDeployEnabled(event.currentTarget.value === "yes")
																}
															>
																<option value="yes">Yes</option>
																<option value="no">No</option>
															</select>
														</label>
														<label class="flex flex-col gap-2">
															<span class="text-sm font-medium leading-none">
																Cleanup Stale Deployments
															</span>
															<select
																class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																value={cleanupStale() ? "yes" : "no"}
																onChange={(event) =>
																	setCleanupStale(event.currentTarget.value === "yes")
																}
															>
																<option value="yes">Yes</option>
																<option value="no">No</option>
															</select>
														</label>
													</div>

													<label class="flex flex-col gap-2">
														<span class="text-sm font-medium leading-none">
															Environment Variables
														</span>
														<small class="text-[0.8rem] text-muted-foreground">
															One KEY=VALUE entry per line.
														</small>
														<textarea
															class="flex min-h-[9rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
															value={envVarsText()}
															onInput={(event) => setEnvVarsText(event.currentTarget.value)}
														/>
													</label>

													<label class="flex flex-col gap-2">
														<span class="text-sm font-medium leading-none">Watch Paths</span>
														<small class="text-[0.8rem] text-muted-foreground">
															One relative path per line.
														</small>
														<textarea
															class="flex min-h-[6rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
															value={watchPathsText()}
															onInput={(event) => setWatchPathsText(event.currentTarget.value)}
														/>
													</label>

													<label class="flex flex-col gap-2">
														<span class="text-sm font-medium leading-none">Service JSON</span>
														<small class="text-[0.8rem] text-muted-foreground">
															Edit the canonical service request payload directly.
														</small>
														<textarea
															class="flex min-h-[12rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
															value={serviceJson()}
															onInput={(event) => setServiceJson(event.currentTarget.value)}
														/>
													</label>

													<KeyValueTable
														rows={[
															[
																"Deploy Webhook Token",
																<span class="font-mono break-all">
																	{currentSettings().auto_deploy.webhook_token}
																</span>,
															],
															[
																"Deploy Webhook Path",
																<span class="font-mono break-all">
																	{currentSettings().auto_deploy.webhook_path}
																</span>,
															],
														]}
													/>

													<div class="flex flex-wrap gap-2 pt-4 border-t border-border">
														<button
															class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
															type="submit"
															disabled={pendingAction() === "save"}
														>
															Save Settings
														</button>
														<button
															class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
															type="button"
															onClick={() => void saveSettings(true)}
															disabled={pendingAction() === "rotate-webhook"}
														>
															Rotate Webhook Token
														</button>
														<button
															class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
															type="button"
															onClick={() =>
																void copyText(currentSettings().auto_deploy.webhook_token)
															}
														>
															Copy Token
														</button>
													</div>
												</form>
											</Panel>
										)}
									</Show>
								</Match>

								<Match when={activeTab() === "logs"}>
									<Panel title="Service Logs">
										<div class="mb-4">
											<p class="text-sm text-muted-foreground mb-3">
												Real-time log streaming with WebSocket (falls back to polling).
											</p>
										</div>
										<LogViewer serviceId={serviceId()} />
									</Panel>
								</Match>

								<Match when={activeTab() === "http-logs"}>
									<Panel title="HTTP Request Logs">
										<div class="flex mb-4">
											<button
												class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
												type="button"
												onClick={() => void refetchHttpLogs()}
											>
												Refresh HTTP Logs
											</button>
										</div>
										<Show
											when={(httpLogs() ?? []).length > 0}
											fallback={
												<p class="text-sm text-muted-foreground p-4 text-center border rounded-lg border-dashed">
													No request logs yet.
												</p>
											}
										>
											<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
												<For each={httpLogs() ?? []}>
													{(entry) => (
														<article class="rounded-xl border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-4">
															<div class="flex justify-between items-start gap-3">
																<div class="min-w-0">
																	<h3 class="font-semibold tracking-tight truncate">
																		<span class="text-primary mr-1 bg-secondary px-1 py-0.5 rounded text-xs">
																			{entry.method}
																		</span>{" "}
																		{entry.path}
																	</h3>
																	<p class="text-xs text-muted-foreground mt-1">
																		{formatDateTime(entry.created_at)}
																	</p>
																</div>
																<StatusBadge
																	status={
																		entry.status >= 200 && entry.status < 300
																			? "success"
																			: entry.status >= 400
																				? "error"
																				: "pending"
																	}
																/>
															</div>
															<div class="grid grid-cols-2 gap-4 py-3 border-y border-border text-xs">
																<div class="flex flex-col gap-1 col-span-2">
																	<p class="font-semibold uppercase text-muted-foreground tracking-wider">
																		Domain
																	</p>
																	<p class="truncate">{entry.domain}</p>
																</div>
																<div class="flex flex-col gap-1">
																	<p class="font-semibold uppercase text-muted-foreground tracking-wider">
																		Upstream
																	</p>
																	<p class="font-mono truncate">{entry.upstream}</p>
																</div>
																<div class="flex flex-col gap-1">
																	<p class="font-semibold uppercase text-muted-foreground tracking-wider">
																		Protocol
																	</p>
																	<p>{entry.protocol}</p>
																</div>
															</div>
														</article>
													)}
												</For>
											</div>
										</Show>
									</Panel>
								</Match>

								<Match when={activeTab() === "deployments"}>
									<Panel title="Deployments">
										<div class="flex mb-4">
											<button
												class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
												type="button"
												onClick={() => void refetchDeployments()}
											>
												Refresh Deployments
											</button>
										</div>
										<Show
											when={(deployments() ?? []).length > 0}
											fallback={
												<p class="text-sm text-muted-foreground p-4 text-center border rounded-lg border-dashed">
													No deployments recorded yet.
												</p>
											}
										>
											<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-8">
												<For each={deployments() ?? []}>
													{(deployment) => (
														<button
															type="button"
															class={`rounded-xl border shadow-sm p-4 flex flex-col gap-4 text-left transition-colors hover:border-primary/30 w-full ${
																selectedDeploymentId() === deployment.id
																	? "bg-primary/5 border-primary/30"
																	: "bg-card text-card-foreground"
															}`}
															onClick={() => setSelectedDeploymentId(deployment.id)}
														>
															<div class="flex justify-between items-start gap-3">
																<div class="min-w-0">
																	<h3 class="font-semibold tracking-tight truncate text-base">
																		{deployment.commit_message ?? "Manual deployment"}
																	</h3>
																	<p class="text-xs text-muted-foreground font-mono truncate mt-1">
																		{deployment.id}
																	</p>
																</div>
																<StatusBadge status={deployment.status} />
															</div>
															<div class="grid grid-cols-2 gap-4 py-3 border-y border-border text-xs">
																<div class="flex flex-col gap-1 col-span-2">
																	<p class="font-semibold uppercase text-muted-foreground tracking-wider">
																		Commit
																	</p>
																	<p class="font-mono truncate">{deployment.commit_sha}</p>
																</div>
																<div class="flex flex-col gap-1">
																	<p class="font-semibold uppercase text-muted-foreground tracking-wider">
																		Started
																	</p>
																	<p>{formatDateTime(deployment.started_at)}</p>
																</div>
																<div class="flex flex-col gap-1">
																	<p class="font-semibold uppercase text-muted-foreground tracking-wider">
																		Finished
																	</p>
																	<p>{formatDateTime(deployment.finished_at)}</p>
																</div>
															</div>
															<div class="flex flex-wrap gap-2">
																<button
																	class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3 ml-auto"
																	type="button"
																	onClick={(e) => {
																		e.stopPropagation();
																		void rollback(deployment.id);
																	}}
																	disabled={pendingAction() === `rollback-${deployment.id}`}
																>
																	Rollback
																</button>
															</div>
														</button>
													)}
												</For>
											</div>
										</Show>

										<Show when={selectedDeploymentId()}>
											{(deploymentId) => (
												<div class="flex flex-col gap-4 p-6 border rounded-xl bg-card text-card-foreground shadow-sm mt-6">
													<div class="flex flex-col sm:flex-row justify-between items-start gap-4 border-b pb-4">
														<p class="font-medium">
															Selected Deployment:{" "}
															<span class="font-mono text-muted-foreground ml-2 text-sm">
																{deploymentId()}
															</span>
														</p>
														<div class="flex flex-wrap gap-2">
															<button
																class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3"
																type="button"
																onClick={() => void refetchSelectedDeployment()}
															>
																Refresh Status
															</button>
															<button
																class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3"
																type="button"
																onClick={() => deploymentLogStream.connect()}
															>
																Reconnect Logs
															</button>
														</div>
													</div>

													<Show when={selectedDeployment()}>
														{(deployment) => (
															<KeyValueTable
																rows={[
																	["Status", <StatusBadge status={deployment().status} />],
																	[
																		"Commit",
																		<span class="font-mono text-muted-foreground">
																			{deployment().commit_sha}
																		</span>,
																	],
																	[
																		"Message",
																		<span>
																			{deployment().commit_message ?? "Manual deployment"}
																		</span>,
																	],
																	[
																		"Container ID",
																		<span class="font-mono text-muted-foreground">
																			{deployment().container_id ?? "N/A"}
																		</span>,
																	],
																	[
																		"Created",
																		<span>{formatDateTime(deployment().created_at)}</span>,
																	],
																	[
																		"Started",
																		<span>{formatDateTime(deployment().started_at)}</span>,
																	],
																	[
																		"Finished",
																		<span>{formatDateTime(deployment().finished_at)}</span>,
																	],
																]}
															/>
														)}
													</Show>

													<pre class="mt-4 bg-zinc-900 text-zinc-100 border border-border rounded-lg p-4 overflow-x-auto text-sm font-mono min-h-[14rem]">
														<Show when={deploymentLogStream.isStreaming()}>
															<div class="flex items-center gap-2 mb-2 text-green-400 text-xs">
																<span class="relative flex h-2 w-2">
																	<span class="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />
																	<span class="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
																</span>
																Streaming live
															</div>
														</Show>
														{deploymentLogStream.logs().join("\n") || "No logs available."}
													</pre>
												</div>
											)}
										</Show>
									</Panel>
								</Match>

								<Match when={activeTab() === "certificates"}>
									<Panel title="Certificates">
										<div class="flex flex-col sm:flex-row items-end gap-4 mb-8">
											<label class="flex flex-col gap-2 flex-1 max-w-sm">
												<span class="text-sm font-medium leading-none">Reissue Single Domain</span>
												<input
													class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
													value={certificateDomain()}
													onInput={(event) => setCertificateDomain(event.currentTarget.value)}
													placeholder="Leave empty to reissue all"
												/>
											</label>
											<div class="flex gap-2">
												<button
													class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
													type="button"
													onClick={() => void reissueCertificates()}
													disabled={pendingAction() === "reissue-certificates"}
												>
													Reissue
												</button>
												<button
													class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
													type="button"
													onClick={() => void refetchCertificates()}
												>
													Refresh
												</button>
											</div>
										</div>

										<Show
											when={(certificates() ?? []).length > 0}
											fallback={
												<p class="text-sm text-muted-foreground p-4 text-center border rounded-lg border-dashed">
													No managed certificates yet.
												</p>
											}
										>
											<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
												<For each={certificates() ?? []}>
													{(certificate) => (
														<article class="rounded-xl border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-4">
															<div class="flex justify-between items-start gap-4">
																<div class="min-w-0">
																	<h3 class="font-semibold tracking-tight truncate text-base">
																		{certificate.domain}
																	</h3>
																	<p class="text-[0.65rem] uppercase font-semibold tracking-widest text-muted-foreground mt-1">
																		Lifecycle
																	</p>
																</div>
																<StatusBadge status={certificate.status} />
															</div>
															<div class="grid grid-cols-2 gap-4 pt-3 border-t border-border text-xs mt-auto">
																<div class="flex flex-col gap-1">
																	<p class="font-semibold uppercase text-muted-foreground tracking-wider">
																		Issued
																	</p>
																	<p>{formatDateTime(certificate.issued_at)}</p>
																</div>
																<div class="flex flex-col gap-1">
																	<p class="font-semibold uppercase text-muted-foreground tracking-wider">
																		Expires
																	</p>
																	<p>{formatDateTime(certificate.expires_at)}</p>
																</div>
															</div>
														</article>
													)}
												</For>
											</div>
										</Show>
									</Panel>
								</Match>
							</Switch>
						</Tabs>
					</>
				)}
			</Show>
		</div>
	);
};

export default ServiceDetail;
