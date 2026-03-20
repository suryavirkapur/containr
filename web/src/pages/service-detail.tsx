import { A, useNavigate, useParams } from "@solidjs/router";
import {
	createEffect,
	createMemo,
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
	Panel,
} from "../components/Plain";
import { StatusBadge, StatusDot } from "../components/StatusBadge";
import { type TabDef, Tabs } from "../components/Tabs";
import { useAppStore } from "../context/AppStore";
import {
	copyText,
	describeError,
	formatDateTime,
} from "../utils/format";
import { listAttachableGroups } from "../utils/service-groups";

// ---- WebSocket deployment log streaming ----
const useDeploymentLogStream = (
	serviceId: () => string,
	deploymentId: () => string | null,
) => {
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

// ---- Helpers ----
const endpointFor = (
	service: Awaited<ReturnType<typeof getService>>,
): string => {
	return (
		service.default_urls[0] ??
		service.proxy_connection_string ??
		service.connection_string ??
		(service.internal_host && service.port
			? `${service.internal_host}:${service.port}`
			: "internal only")
	);
};

const isUrl = (s: string) =>
	s.startsWith("http://") || s.startsWith("https://");

const envText = (values: Array<{ key: string; value: string }>) =>
	values.map((e) => `${e.key}=${e.value}`).join("\n");

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

// ---- MaskedValue — reveals secret strings on click ----
const MaskedValue = (props: { value: string }) => {
	const [shown, setShown] = createSignal(false);
	return (
		<span class="inline-flex items-center gap-2 font-mono text-sm">
			<span class={shown() ? '' : 'blur-sm select-none pointer-events-none'}>
				{props.value}
			</span>
			<button
				type="button"
				class="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
				onClick={() => setShown((v) => !v)}
			>
				{shown() ? 'hide' : 'reveal'}
			</button>
		</span>
	);
};

// ---- Shared input styles ----
const inputClass =
	"flex h-8 w-full border border-border bg-card px-3 py-1 text-sm " +
	"placeholder:text-muted-foreground focus-visible:outline-none " +
	"focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

const textareaClass =
	"flex w-full border border-border bg-card px-3 py-2 text-sm font-mono " +
	"placeholder:text-muted-foreground focus-visible:outline-none " +
	"focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

const btnPrimary =
	"px-4 py-1.5 text-sm font-medium bg-foreground text-background " +
	"hover:opacity-80 transition-opacity disabled:opacity-40";

const btnSecondary =
	"px-4 py-1.5 text-sm border border-border text-muted-foreground " +
	"hover:text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-40";

const btnDestructive =
	"px-4 py-1.5 text-sm border border-red-900 text-red-400 " +
	"hover:bg-red-950/30 transition-colors disabled:opacity-40";

// ---- Component ----
const ServiceDetail = () => {
	const params = useParams();
	const navigate = useNavigate();
	const store = useAppStore();
	const serviceId = () => params.id ?? "";

	const [activeTab, setActiveTab] = createSignal("general");
	const [feedback, setFeedback] = createSignal<{
		tone: "success" | "error";
		text: string;
	} | null>(null);
	const [pendingAction, setPendingAction] = createSignal<string | null>(null);
	const [selectedDeploymentId, setSelectedDeploymentId] = createSignal<
		string | null
	>(null);
	const [settingsLoadedFor, setSettingsLoadedFor] = createSignal<
		string | null
	>(null);

	// Config tab state
	const [githubUrl, setGithubUrl] = createSignal("");
	const [branch, setBranch] = createSignal("");
	const [rolloutStrategy, setRolloutStrategy] = createSignal("");
	const [envVarsText, setEnvVarsText] = createSignal("");
	const [watchPathsText, setWatchPathsText] = createSignal("");
	const [serviceJson, setServiceJson] = createSignal("{}");
	const [autoDeployEnabled, setAutoDeployEnabled] = createSignal(false);
	const [cleanupStale, setCleanupStale] = createSignal(false);

	// Deploy panel state
	const [deployBranch, setDeployBranch] = createSignal("");
	const [deployCommitSha, setDeployCommitSha] = createSignal("");
	const [deployCommitMessage, setDeployCommitMessage] = createSignal("");
	const [deployRolloutStrategy, setDeployRolloutStrategy] = createSignal("");

	// Networking Settings tab state
	const [selectedGroupId, setSelectedGroupId] = createSignal<string | null>(
		null,
	);
	const [domainHttpEnabled, setDomainHttpEnabled] = createSignal<
		Record<string, boolean>
	>({});
	const [domainHttpsEnabled, setDomainHttpsEnabled] = createSignal<
		Record<string, boolean>
	>({});
	const [networkingSettingsLoaded, setNetworkingSettingsLoaded] =
		createSignal(false);

	// Certificates
	const [certificateDomain, setCertificateDomain] = createSignal("");

	const [service, { refetch: refetchService }] = createResource(
		serviceId,
		getService,
	);
	const [settings, { refetch: refetchSettings }] = createResource(
		serviceId,
		getServiceSettings,
	);
	const [logs, { refetch: refetchLogs }] = createResource(serviceId, (id) =>
		getServiceLogs(id, 300),
	);
	const [httpLogs, { refetch: refetchHttpLogs }] = createResource(
		serviceId,
		(id) => getServiceHttpLogs(id, 200, 0),
	);
	const [deployments, { refetch: refetchDeployments }] = createResource(
		serviceId,
		listServiceDeployments,
	);
	const [certificates, { refetch: refetchCertificates }] = createResource(
		serviceId,
		getServiceCertificates,
	);
	const [selectedDeployment, { refetch: refetchSelectedDeployment }] =
		createResource(
			() => ({
				currentServiceId: serviceId(),
				deploymentId: selectedDeploymentId(),
			}),
			({ currentServiceId, deploymentId }) =>
				deploymentId
					? getServiceDeployment(currentServiceId, deploymentId)
					: Promise.resolve(null),
		);
	const deploymentLogStream = useDeploymentLogStream(
		serviceId,
		selectedDeploymentId,
	);

	const allServices = createMemo(() => store.state.services);
	const availableGroups = createMemo(() => listAttachableGroups(allServices()));

	const pendingDeployments = () =>
		(deployments() ?? []).filter(
			(d) => d.status === "pending" || d.status === "starting",
		).length;

	const tabs = (): TabDef[] => [
		{ id: "general", label: "General" },
		{ id: "config", label: "Configuration" },
		{ id: "networking", label: "Networking Settings" },
		{ id: "logs", label: "Logs" },
		{ id: "http-logs", label: "HTTP Logs" },
		{
			id: "deployments",
			label: "Deployments",
			badge:
				pendingDeployments() > 0 ? pendingDeployments() : undefined,
		},
		{ id: "certificates", label: "Certificates" },
	];

	const breadcrumbs = (): BreadcrumbItem[] => [
		{ label: "Services", href: "/services" },
		{ label: service()?.name ?? "Loading..." },
	];

	// Load settings into local state
	createEffect(() => {
		const currentSettings = settings();
		if (
			!currentSettings ||
			settingsLoadedFor() === currentSettings.service_id
		)
			return;
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

	// Load networking overrides from serviceJson
	createEffect(() => {
		const currentService = service();
		if (!currentService || networkingSettingsLoaded()) return;
		setNetworkingSettingsLoaded(true);
		setSelectedGroupId(currentService.group_id ?? null);
		// Initialize all domains as http+https enabled by default
		const httpMap: Record<string, boolean> = {};
		const httpsMap: Record<string, boolean> = {};
		for (const domain of currentService.domains) {
			httpMap[domain] = true;
			httpsMap[domain] = true;
		}
		// Merge any overrides stored in serviceJson
		try {
			const parsed = JSON.parse(serviceJson());
			const overrides = parsed?.networking?.domain_overrides ?? {};
			for (const [domain, cfg] of Object.entries(overrides)) {
				const c = cfg as { http?: boolean; https?: boolean };
				if (domain in httpMap) {
					if (c.http !== undefined) httpMap[domain] = c.http;
					if (c.https !== undefined) httpsMap[domain] = c.https;
				}
			}
		} catch {
			// ignore JSON parse errors
		}
		setDomainHttpEnabled(httpMap);
		setDomainHttpsEnabled(httpsMap);
	});

	// Auto-select first deployment
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
			setFeedback({ tone: "success", text: `${action} accepted` });
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

	// Save networking settings — stores domain overrides as env var,
	// and saves settings through the standard updateService path
	const saveNetworkingSettings = async () => {
		setPendingAction("save-networking");
		setFeedback(null);
		try {
			const currentService = service();
			const domainOverrides: Record<string, { http: boolean; https: boolean }> = {};
			if (currentService) {
				for (const domain of currentService.domains) {
					domainOverrides[domain] = {
						http: domainHttpEnabled()[domain] ?? true,
						https: domainHttpsEnabled()[domain] ?? true,
					};
				}
			}
			// Persist domain config as an env var for proxy/backend to consume
			const existingEnvLines = parseEnvText(envVarsText()).filter(
				(e) => e.key !== "CONTAINR_DOMAIN_CONFIG",
			);
			existingEnvLines.push({
				key: "CONTAINR_DOMAIN_CONFIG",
				value: JSON.stringify(domainOverrides),
				secret: false,
			});
			setEnvVarsText(existingEnvLines.map((e) => `${e.key}=${e.value}`).join("\n"));
			// biome-ignore lint/suspicious/noExplicitAny: schema cast for passthrough service object
			let parsedService: any = {};
			try {
				parsedService = JSON.parse(serviceJson());
			} catch {
				// use empty object if JSON is broken
			}
			await store.updateService(serviceId(), {
				github_url: githubUrl().trim() || null,
				branch: branch().trim() || null,
				rollout_strategy: rolloutStrategy().trim() || null,
				env_vars: existingEnvLines,
				auto_deploy: {
					enabled: autoDeployEnabled(),
					cleanup_stale_deployments: cleanupStale(),
					watch_paths: parseLines(watchPathsText()),
					regenerate_webhook_token: false,
				},
				// biome-ignore lint/suspicious/noExplicitAny: passthrough
				service: parsedService,
			});
			setFeedback({ tone: "success", text: "networking settings saved" });
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
		<div class="flex flex-col gap-5">
			<Breadcrumbs items={breadcrumbs()} />

			<Show when={service.loading}>
				<LoadingBlock message="Loading service..." />
			</Show>
			<Show when={service.error}>
				{(error) => (
					<Notice tone="error">
						Failed to load: {describeError(error())}
					</Notice>
				)}
			</Show>

			<Show when={service()}>
				{(currentService) => (
					<>
						{/* Header */}
						<div class="flex flex-col sm:flex-row justify-between items-start gap-3">
							<div>
								<h1 class="text-xl font-semibold tracking-tight">
									{currentService().name}
								</h1>
								<p class="text-xs text-muted-foreground mt-0.5">
									{currentService().service_type.replace(/_/g, " ")} /{" "}
									{currentService().resource_kind.replace(/_/g, " ")}
								</p>
							</div>
							<div class="flex items-center gap-2">
								<StatusBadge
									status={currentService().status}
									size="md"
									showDot
								/>
								<button
									type="button"
									onClick={() => void refreshAll()}
									class={btnSecondary}
								>
									Refresh
								</button>
							</div>
						</div>

						{feedback() ? (
							<Notice tone={feedback()!.tone}>{feedback()!.text}</Notice>
						) : null}

						<Tabs
							tabs={tabs()}
							activeTab={activeTab()}
							onTabChange={setActiveTab}
						>
							<Switch>
								{/* ---- GENERAL TAB ---- */}
								<Match when={activeTab() === "general"}>
									<Panel title="Actions">
										<div class="flex flex-col gap-5">
											<div class="flex flex-wrap gap-2">
												<button
													type="button"
													class={btnSecondary}
													onClick={() => void runAction("start")}
													disabled={pendingAction() === "start"}
												>
													Start
												</button>
												<button
													type="button"
													class={btnSecondary}
													onClick={() => void runAction("stop")}
													disabled={pendingAction() === "stop"}
												>
													Stop
												</button>
												<button
													type="button"
													class={btnSecondary}
													onClick={() => void runAction("restart")}
													disabled={pendingAction() === "restart"}
												>
													Restart
												</button>
												<button
													type="button"
													class={`${btnDestructive} ml-auto`}
													onClick={() => void removeService()}
													disabled={pendingAction() === "delete"}
												>
													Delete
												</button>
											</div>

											<div class="border-t border-border pt-5">
												<p class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
													Deploy
												</p>
												<div class="grid gap-3 sm:grid-cols-2">
													<label class="flex flex-col gap-1.5">
														<span class="text-sm font-medium">Branch</span>
														<input
															class={inputClass}
															value={deployBranch()}
															onInput={(e) =>
																setDeployBranch(e.currentTarget.value)
															}
															placeholder="Default branch"
														/>
													</label>
													<label class="flex flex-col gap-1.5">
														<span class="text-sm font-medium">
															Rollout Strategy
														</span>
														<input
															class={inputClass}
															value={deployRolloutStrategy()}
															onInput={(e) =>
																setDeployRolloutStrategy(e.currentTarget.value)
															}
															placeholder="start_first or stop_first"
														/>
													</label>
													<label class="flex flex-col gap-1.5">
														<span class="text-sm font-medium">Commit SHA</span>
														<input
															class={inputClass}
															value={deployCommitSha()}
															onInput={(e) =>
																setDeployCommitSha(e.currentTarget.value)
															}
															placeholder="Optional"
														/>
													</label>
													<label class="flex flex-col gap-1.5">
														<span class="text-sm font-medium">
															Commit Message
														</span>
														<input
															class={inputClass}
															value={deployCommitMessage()}
															onInput={(e) =>
																setDeployCommitMessage(e.currentTarget.value)
															}
															placeholder="Optional"
														/>
													</label>
												</div>
												<div class="flex gap-2 pt-3">
													<button
														type="button"
														class={btnPrimary}
														onClick={() => void deploy()}
														disabled={pendingAction() === "deploy"}
													>
														Deploy Now
													</button>
												</div>
											</div>
										</div>
									</Panel>

									<Panel title="Summary">
										<KeyValueTable
											rows={[
												[
													"Status",
													<StatusBadge status={currentService().status} />,
												],
												[
													"Endpoint",
													// Managed services: hide connection string behind reveal toggle
													// App services: show as clickable link or plain text
													currentService().resource_kind !== 'app_service'
													? (<MaskedValue value={endpointFor(currentService())} />)
													: isUrl(endpointFor(currentService()))
													? (<a
														href={endpointFor(currentService())}
														target="_blank"
														rel="noopener noreferrer"
														class="font-mono text-sm hover:underline text-muted-foreground hover:text-foreground transition-colors"
													>
														{endpointFor(currentService())}
													</a>)
													: (<span class="font-mono text-sm text-muted-foreground">
														{endpointFor(currentService())}
													</span>),
												],
												[
													"Group",
													currentService().group_id ? (
														<A
															class="hover:underline text-muted-foreground hover:text-foreground transition-colors"
															href={`/services?group=${currentService().group_id}`}
														>
															{currentService().project_name ??
																currentService().group_id}
														</A>
													) : (
														<span class="text-muted-foreground">Isolated</span>
													),
												],
												[
													"Domains",
													<div class="flex flex-col gap-0.5">
														<For
															each={currentService().domains}
															fallback={
																<span class="text-muted-foreground">None</span>
															}
														>
															{(domain) => (
																<a
																	href={`https://${domain}`}
																	target="_blank"
																	rel="noopener noreferrer"
																	class="text-sm hover:underline text-muted-foreground hover:text-foreground transition-colors"
																>
																	{domain}
																</a>
															)}
														</For>
													</div>,
												],
												[
													"Network",
													<span class="font-mono text-muted-foreground">
														{currentService().network_name}
													</span>,
												],
												[
													"Containers",
													<span class="text-muted-foreground">
														{currentService().container_ids.length}
													</span>,
												],
												[
													"Created",
													<span>{formatDateTime(currentService().created_at)}</span>,
												],
												[
													"Updated",
													<span>{formatDateTime(currentService().updated_at)}</span>,
												],
											]}
										/>
									</Panel>
								</Match>

								{/* ---- CONFIGURATION TAB ---- */}
								<Match when={activeTab() === "config"}>
									<Show when={settings.error}>
										{(error) => (
											<Notice tone="error">
												Settings unavailable: {describeError(error())}
											</Notice>
										)}
									</Show>
									<Show when={settings()}>
										{(currentSettings) => (
											<Panel
												title="Configuration"
												subtitle="Raw text and JSON. Save to apply on the next deployment."
											>
												<form
													class="flex flex-col gap-5"
													onSubmit={(event) => {
														event.preventDefault();
														void saveSettings(false);
													}}
												>
													<div class="grid gap-4 sm:grid-cols-2">
														<label class="flex flex-col gap-1.5">
															<span class="text-sm font-medium">GitHub URL</span>
															<input
																class={inputClass}
																value={githubUrl()}
																onInput={(e) =>
																	setGithubUrl(e.currentTarget.value)
																}
															/>
														</label>
														<label class="flex flex-col gap-1.5">
															<span class="text-sm font-medium">Branch</span>
															<input
																class={inputClass}
																value={branch()}
																onInput={(e) => setBranch(e.currentTarget.value)}
															/>
														</label>
														<label class="flex flex-col gap-1.5">
															<span class="text-sm font-medium">
																Rollout Strategy
															</span>
															<input
																class={inputClass}
																value={rolloutStrategy()}
																onInput={(e) =>
																	setRolloutStrategy(e.currentTarget.value)
																}
															/>
														</label>
														<label class="flex flex-col gap-1.5">
															<span class="text-sm font-medium">
																Auto Deploy
															</span>
															<select
																class={inputClass}
																value={autoDeployEnabled() ? "yes" : "no"}
																onChange={(e) =>
																	setAutoDeployEnabled(
																		e.currentTarget.value === "yes",
																	)
																}
															>
																<option value="yes">Yes</option>
																<option value="no">No</option>
															</select>
														</label>
														<label class="flex flex-col gap-1.5">
															<span class="text-sm font-medium">
																Cleanup Stale
															</span>
															<select
																class={inputClass}
																value={cleanupStale() ? "yes" : "no"}
																onChange={(e) =>
																	setCleanupStale(
																		e.currentTarget.value === "yes",
																	)
																}
															>
																<option value="yes">Yes</option>
																<option value="no">No</option>
															</select>
														</label>
													</div>

													<label class="flex flex-col gap-1.5">
														<span class="text-sm font-medium">
															Environment Variables
														</span>
														<small class="text-xs text-muted-foreground">
															One KEY=VALUE per line.
														</small>
														<textarea
															class={`${textareaClass} min-h-[9rem]`}
															value={envVarsText()}
															onInput={(e) =>
																setEnvVarsText(e.currentTarget.value)
															}
														/>
													</label>

													<label class="flex flex-col gap-1.5">
														<span class="text-sm font-medium">Watch Paths</span>
														<small class="text-xs text-muted-foreground">
															One relative path per line.
														</small>
														<textarea
															class={`${textareaClass} min-h-[5rem]`}
															value={watchPathsText()}
															onInput={(e) =>
																setWatchPathsText(e.currentTarget.value)
															}
														/>
													</label>

													<label class="flex flex-col gap-1.5">
														<span class="text-sm font-medium">Service JSON</span>
														<small class="text-xs text-muted-foreground">
															Edit the canonical service payload directly.
														</small>
														<textarea
															class={`${textareaClass} min-h-[10rem]`}
															value={serviceJson()}
															onInput={(e) =>
																setServiceJson(e.currentTarget.value)
															}
														/>
													</label>

													<div class="border border-border p-4 text-xs flex flex-col gap-2">
														<div>
															<span class="text-muted-foreground">
																Webhook Token{" "}
															</span>
															<span class="font-mono break-all">
																{currentSettings().auto_deploy.webhook_token}
															</span>
														</div>
														<div>
															<span class="text-muted-foreground">
																Webhook Path{" "}
															</span>
															<span class="font-mono break-all">
																{currentSettings().auto_deploy.webhook_path}
															</span>
														</div>
													</div>

													<div class="flex flex-wrap gap-2 pt-2 border-t border-border">
														<button
															class={btnPrimary}
															type="submit"
															disabled={pendingAction() === "save"}
														>
															Save Settings
														</button>
														<button
															class={btnSecondary}
															type="button"
															onClick={() => void saveSettings(true)}
															disabled={
																pendingAction() === "rotate-webhook"
															}
														>
															Rotate Webhook
														</button>
														<button
															class={btnSecondary}
															type="button"
															onClick={() =>
																void copyText(
																	currentSettings().auto_deploy.webhook_token,
																)
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

								{/* ---- NETWORKING SETTINGS TAB ---- */}
								<Match when={activeTab() === "networking"}>
									<Panel
										title="Networking Settings"
										subtitle="Configure the network group and per-domain HTTP/HTTPS access."
									>
										<div class="flex flex-col gap-6">
											{/* Group selector */}
											<div class="flex flex-col gap-1.5">
												<label class="text-sm font-medium">Network Group</label>
												<p class="text-xs text-muted-foreground">
													Services in the same group share an internal network.
												</p>
												<select
													class={`${inputClass} max-w-sm`}
													value={selectedGroupId() ?? ""}
													onChange={(e) =>
														setSelectedGroupId(
															e.currentTarget.value || null,
														)
													}
												>
													<option value="">Isolated (no group)</option>
													<For each={availableGroups()}>
														{(group) => (
															<option value={group.id}>
																{group.label}
															</option>
														)}
													</For>
												</select>
											</div>

											{/* Per-domain toggles */}
											<div class="flex flex-col gap-2">
												<p class="text-sm font-medium">Domain Access</p>
												<Show
													when={
														currentService().domains.length > 0
													}
													fallback={
														<p class="text-xs text-muted-foreground">
															No domains configured. Add domains in Configuration.
														</p>
													}
												>
													<div class="border border-border divide-y divide-border">
														<div class="grid grid-cols-4 gap-4 px-4 py-2 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
															<span class="col-span-2">Domain</span>
															<span class="text-center">HTTP</span>
															<span class="text-center">HTTPS</span>
														</div>
														<For each={currentService().domains}>
															{(domain) => (
																<div class="grid grid-cols-4 gap-4 px-4 py-3 items-center">
																	<a
																		href={`https://${domain}`}
																		target="_blank"
																		rel="noopener noreferrer"
																		class="col-span-2 text-sm font-mono hover:underline text-muted-foreground hover:text-foreground transition-colors truncate"
																	>
																		{domain}
																	</a>
																	<div class="flex justify-center">
																		<input
																			type="checkbox"
																			class="w-4 h-4 accent-foreground cursor-pointer"
																			checked={
																				domainHttpEnabled()[domain] ?? true
																			}
																			onChange={(e) =>
																				setDomainHttpEnabled((prev) => ({
																					...prev,
																					[domain]: e.currentTarget.checked,
																				}))
																			}
																		/>
																	</div>
																	<div class="flex justify-center">
																		<input
																			type="checkbox"
																			class="w-4 h-4 accent-foreground cursor-pointer"
																			checked={
																				domainHttpsEnabled()[domain] ?? true
																			}
																			onChange={(e) =>
																				setDomainHttpsEnabled((prev) => ({
																					...prev,
																					[domain]: e.currentTarget.checked,
																				}))
																			}
																		/>
																	</div>
																</div>
															)}
														</For>
													</div>
												</Show>
											</div>

											<div class="flex gap-2 pt-2 border-t border-border">
												<button
													type="button"
													class={btnPrimary}
													onClick={() => void saveNetworkingSettings()}
													disabled={pendingAction() === "save-networking"}
												>
													Save Networking
												</button>
											</div>
										</div>
									</Panel>
								</Match>

								{/* ---- LOGS TAB ---- */}
								<Match when={activeTab() === "logs"}>
									<Panel title="Service Logs">
										<LogViewer serviceId={serviceId()} />
									</Panel>
								</Match>

								{/* ---- HTTP LOGS TAB ---- */}
								<Match when={activeTab() === "http-logs"}>
									<Panel title="HTTP Request Logs">
										<div class="flex mb-4">
											<button
												class={btnSecondary}
												type="button"
												onClick={() => void refetchHttpLogs()}
											>
												Refresh
											</button>
										</div>
										<Show
											when={(httpLogs() ?? []).length > 0}
											fallback={
												<EmptyBlock title="No request logs yet." />
											}
										>
											<div class="border border-border divide-y divide-border">
												<For each={httpLogs() ?? []}>
													{(entry) => (
														<div class="flex items-center gap-4 px-4 py-2.5 text-sm">
															<span class="text-xs font-mono px-1.5 py-0.5 bg-secondary text-foreground shrink-0">
																{entry.method}
															</span>
															<span class="flex-1 font-mono text-xs truncate">
																{entry.path}
															</span>
															<span class="text-xs text-muted-foreground shrink-0">
																{entry.domain}
															</span>
															<span
																class={`text-xs font-medium shrink-0 ${
																	entry.status >= 200 && entry.status < 300
																		? "text-green-400"
																		: entry.status >= 400
																			? "text-red-400"
																			: "text-muted-foreground"
																}`}
															>
																{entry.status}
															</span>
															<span class="text-xs text-muted-foreground shrink-0 hidden lg:block">
																{formatDateTime(entry.created_at)}
															</span>
														</div>
													)}
												</For>
											</div>
										</Show>
									</Panel>
								</Match>

								{/* ---- DEPLOYMENTS TAB ---- */}
								<Match when={activeTab() === "deployments"}>
									<Panel title="Deployments">
										<div class="flex mb-4">
											<button
												class={btnSecondary}
												type="button"
												onClick={() => void refetchDeployments()}
											>
												Refresh
											</button>
										</div>
										<Show
											when={(deployments() ?? []).length > 0}
											fallback={<EmptyBlock title="No deployments yet." />}
										>
											<div class="border border-border divide-y divide-border">
												<For each={deployments() ?? []}>
													{(deployment) => {
														const isOpen = () =>
															selectedDeploymentId() === deployment.id;
														const toggle = () =>
															setSelectedDeploymentId(
																isOpen() ? null : deployment.id,
															);
														return (
															<div class="divide-y divide-border">
																{/* Accordion header row */}
																<div
																	class={`flex items-center gap-4 px-4 py-3 w-full transition-colors hover:bg-secondary/30 cursor-pointer ${
																		isOpen() ? 'bg-secondary/30' : ''
																	}`}
																	onClick={toggle}
																>
																	{/* Chevron */}
																	<span class={`text-muted-foreground text-xs transition-transform shrink-0 ${isOpen() ? 'rotate-90' : ''}`}>
																		›
																	</span>
																	<div class="flex-1 min-w-0">
																		<p class="text-sm font-medium truncate">
																			{deployment.commit_message ?? 'Manual deployment'}
																		</p>
																		<p class="text-xs text-muted-foreground mt-0.5 font-mono truncate">
																			{deployment.commit_sha
																				? deployment.commit_sha.slice(0, 7)
																				: '—'}
																		</p>
																	</div>
																	<StatusBadge status={deployment.status} />
																	<span class="text-xs text-muted-foreground shrink-0 hidden lg:block">
																		{formatDateTime(deployment.started_at)}
																	</span>
																</div>

																{/* Accordion body */}
																<Show when={isOpen()}>
																	<div class="px-4 py-4 bg-secondary/10 flex flex-col gap-4">
																		{/* Metadata */}
																		<div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 text-xs">
																			<div class="flex flex-col gap-0.5">
																				<dt class="text-muted-foreground uppercase tracking-wider">Status</dt>
																				<dd><StatusBadge status={deployment.status} /></dd>
																			</div>
																			<div class="flex flex-col gap-0.5">
																				<dt class="text-muted-foreground uppercase tracking-wider">Created</dt>
																				<dd>{formatDateTime(deployment.created_at)}</dd>
																			</div>
																			<div class="flex flex-col gap-0.5">
																				<dt class="text-muted-foreground uppercase tracking-wider">Started</dt>
																				<dd>{formatDateTime(deployment.started_at)}</dd>
																			</div>
																			<div class="flex flex-col gap-0.5">
																				<dt class="text-muted-foreground uppercase tracking-wider">Finished</dt>
																				<dd>{formatDateTime(deployment.finished_at)}</dd>
																			</div>
																			<div class="flex flex-col gap-0.5 col-span-full">
																				<dt class="text-muted-foreground uppercase tracking-wider">Commit</dt>
																				<dd class="font-mono">{deployment.commit_sha ?? '—'}</dd>
																			</div>
																		</div>

																		{/* Action buttons */}
																		<div class="flex flex-wrap gap-2">
																			<button
																				class={`${btnSecondary} text-xs`}
																				type="button"
																				onClick={() => void rollback(deployment.id)}
																				disabled={pendingAction() === `rollback-${deployment.id}`}
																			>
																				Rollback
																			</button>
																			<button
																				class={`${btnSecondary} text-xs`}
																				type="button"
																				onClick={() => deploymentLogStream.connect()}
																			>
																				Reconnect Logs
																			</button>
																		</div>

																		{/* Build log */}
																		<pre class="bg-[#0d0d0d] text-[#e4e4e4] border border-border p-4 overflow-x-auto text-xs font-mono min-h-[10rem] max-h-[24rem] overflow-y-auto">
																			<Show when={deploymentLogStream.isStreaming()}>
																				<div class="flex items-center gap-2 mb-2 text-green-400">
																					<span class="relative flex h-1.5 w-1.5">
																						<span class="absolute inline-flex h-full w-full bg-green-400 opacity-75 animate-ping" />
																						<span class="relative inline-flex h-1.5 w-1.5 bg-green-500" />
																					</span>
																					streaming live
																				</div>
																			</Show>
																			{deploymentLogStream.logs().join('\n') || 'No logs yet. Click Reconnect Logs to stream.'}
																		</pre>
																	</div>
																</Show>
															</div>
														);
													}}
												</For>
											</div>
										</Show>
									</Panel>
								</Match>

								{/* ---- CERTIFICATES TAB ---- */}
								<Match when={activeTab() === "certificates"}>
									<Panel title="Certificates">
										<div class="flex flex-col sm:flex-row items-end gap-3 mb-6">
											<label class="flex flex-col gap-1.5 flex-1 max-w-sm">
												<span class="text-sm font-medium">
													Reissue Single Domain
												</span>
												<input
													class={inputClass}
													value={certificateDomain()}
													onInput={(e) =>
														setCertificateDomain(e.currentTarget.value)
													}
													placeholder="Leave empty to reissue all"
												/>
											</label>
											<div class="flex gap-2">
												<button
													class={btnPrimary}
													type="button"
													onClick={() => void reissueCertificates()}
													disabled={
														pendingAction() === "reissue-certificates"
													}
												>
													Reissue
												</button>
												<button
													class={btnSecondary}
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
												<EmptyBlock title="No managed certificates yet." />
											}
										>
											<div class="border border-border divide-y divide-border">
												<For each={certificates() ?? []}>
													{(certificate) => (
														<div class="flex items-center gap-4 px-4 py-3">
															<div class="flex-1 min-w-0">
																<p class="text-sm font-medium truncate">
																	{certificate.domain}
																</p>
															</div>
															<StatusBadge status={certificate.status} />
															<div class="text-xs text-muted-foreground hidden sm:block">
																<span>Exp: </span>
																{formatDateTime(certificate.expires_at)}
															</div>
														</div>
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
