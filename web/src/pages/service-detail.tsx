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
	getServiceDeployment,
	getServiceLogs,
	getServiceSettings,
	listServiceDeployments,
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
import { copyText, describeError, formatDateTime } from "../utils/format";

const ESC_CODE = 27;
const ESC = String.fromCharCode(ESC_CODE);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

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
				const line = stripAnsi(event.data);
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

const MaskedValue = (props: { value: string }) => {
	const [shown, setShown] = createSignal(false);
	return (
		<span class="inline-flex items-center gap-2 font-mono text-sm">
			<span class={shown() ? "" : "blur-sm select-none pointer-events-none"}>
				{props.value}
			</span>
			<button
				type="button"
				class="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
				onClick={() => setShown((value) => !value)}
			>
				{shown() ? "hide" : "reveal"}
			</button>
		</span>
	);
};

const ServiceDetail = () => {
	const params = useParams();
	const navigate = useNavigate();
	const store = useAppStore();
	const serviceId = () => params.id ?? "";
	const [activeTab, setActiveTab] = createSignal("http");
	const [feedback, setFeedback] = createSignal<{ tone: "success" | "error"; text: string } | null>(null);
	const [pendingAction, setPendingAction] = createSignal<string | null>(null);
	const [selectedDeploymentId, setSelectedDeploymentId] = createSignal<string | null>(null);

	const [deployBranch, setDeployBranch] = createSignal("");
	const [deployCommitSha, setDeployCommitSha] = createSignal("");
	const [deployCommitMessage, setDeployCommitMessage] = createSignal("");
	const [deployRolloutStrategy, setDeployRolloutStrategy] = createSignal("");

	const [envVars, setEnvVars] = createSignal<Array<{ key: string; value: string; secret: boolean; isNew?: boolean; isEdited?: boolean }>>([]);
	const [bulkEditMode, setBulkEditMode] = createSignal(false);
	const [bulkEditText, setBulkEditText] = createSignal("");
	const [newEnvKey, setNewEnvKey] = createSignal("");
	const [newEnvValue, setNewEnvValue] = createSignal("");
	const [newEnvSecret, setNewEnvSecret] = createSignal(false);
	const [showAddEnv, setShowAddEnv] = createSignal(false);

	const [autoDeployEnabled, setAutoDeployEnabled] = createSignal(false);
	const [watchPathsText, setWatchPathsText] = createSignal("");

	const [httpEnabled, setHttpEnabled] = createSignal(true);
	const [customDomains, setCustomDomains] = createSignal<string[]>([]);
	const [httpOnlyDomains, setHttpOnlyDomains] = createSignal<string[]>([]);
	const [newDomain, setNewDomain] = createSignal("");

	const [serviceJson, setServiceJson] = createSignal("{}");
	const [rolloutStrategy, setRolloutStrategy] = createSignal("");
	const [replicas, setReplicas] = createSignal("1");

	const isAppService = () => {
		const s = service();
		if (!s) return true;
		const t = s.service_type.toLowerCase();
		return !["postgres", "redis", "mariadb", "qdrant", "rabbitmq", "postgresql", "qdrantmq"].includes(t);
	};

	const [service, { refetch: refetchService }] = createResource(serviceId, getService);
	const [settings, { refetch: refetchSettings }] = createResource(
		() => (serviceId() && isAppService() ? serviceId() : null),
		(id) => id ? getServiceSettings(id) : Promise.resolve(null),
	);
	const [logs, { refetch: refetchLogs }] = createResource(serviceId, (id) => getServiceLogs(id, 300));
	const [deployments, { refetch: refetchDeployments }] = createResource(
		() => (serviceId() && isAppService() ? serviceId() : null),
		(id) => id ? listServiceDeployments(id) : Promise.resolve([]),
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
		{ id: "http", label: "HTTP Settings" },
		{ id: "appconfigs", label: "App Configs" },
		{ id: "deployment", label: "Deployment" },
		{ id: "logs", label: "Logs" },
	];

	const breadcrumbs = (): BreadcrumbItem[] => [
		{ label: "Services", href: "/services" },
		{ label: service()?.name ?? "Loading..." },
	];

	createEffect(() => {
		const s = settings();
		if (!s) return;
		setDeployBranch(s.branch);
		setDeployRolloutStrategy(s.rollout_strategy);
		setAutoDeployEnabled(s.auto_deploy.enabled);
		setWatchPathsText(s.auto_deploy.watch_paths.join("\n"));
		setServiceJson(JSON.stringify(s.service, null, 2));
		setRolloutStrategy(s.rollout_strategy);
		setReplicas(String(s.service.replicas ?? 1));
		setEnvVars(s.env_vars.map((e) => ({ ...e, isNew: false, isEdited: false })));
		setBulkEditText(s.env_vars.map((e) => `${e.key}=${e.value}`).join("\n"));
		setHttpEnabled(s.service.expose_http);
		setCustomDomains(s.service.domains ?? []);
		setHttpOnlyDomains((s.service as { http_only_domains?: string[] }).http_only_domains ?? []);
	});

	createEffect(() => {
		const rows = deployments();
		if (!rows || rows.length === 0) return;
		if (!selectedDeploymentId()) {
			setSelectedDeploymentId(rows[0].id);
		}
	});

	createEffect(() => {
		if (activeTab() !== "deployment") return;
		const interval = setInterval(() => {
			void refetchDeployments();
			void refetchSelectedDeployment();
		}, 5000);
		onCleanup(() => clearInterval(interval));
	});

	const refreshAll = async () => {
		await Promise.all([
			refetchService(),
			refetchSettings(),
			refetchLogs(),
			refetchDeployments(),
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

	const saveAppConfigs = async () => {
		setPendingAction("save-appconfigs");
		setFeedback(null);
		try {
			let finalEnvVars: Array<{ key: string; value: string; secret: boolean }> = [];
			if (bulkEditMode()) {
				finalEnvVars = bulkEditText()
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean)
					.map((line) => {
						const [key, ...rest] = line.split("=");
						return { key: key.trim(), value: rest.join("=").trim(), secret: false };
					});
			} else {
				finalEnvVars = envVars()
					.filter((e) => !e.isNew || e.key.trim())
					.map(({ key, value, secret }) => ({ key: key.trim(), value, secret }));
			}

			const parsedService = JSON.parse(serviceJson());
			parsedService.replicas = Math.max(1, Number.parseInt(replicas().trim(), 10) || 1);

			await store.updateService(serviceId(), {
				env_vars: finalEnvVars,
				auto_deploy: {
					enabled: autoDeployEnabled(),
					watch_paths: watchPathsText().split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
				},
				service: parsedService,
			});
			setFeedback({ tone: "success", text: "app configs saved" });
			setPendingAction(null);
			void refreshAll();
		} catch (error) {
			setFeedback({ tone: "error", text: describeError(error) });
			setPendingAction(null);
		}
	};

	const saveHttpSettings = async () => {
		setPendingAction("save-http");
		setFeedback(null);
		try {
			const parsedService = JSON.parse(serviceJson());
			parsedService.expose_http = httpEnabled();
			parsedService.domains = customDomains().filter(Boolean);
			parsedService.http_only_domains = httpOnlyDomains().filter((domain) =>
				customDomains().includes(domain),
			);

			await store.updateService(serviceId(), {
				service: parsedService,
			});
			setFeedback({ tone: "success", text: "http settings saved" });
			setPendingAction(null);
			void refreshAll();
		} catch (error) {
			setFeedback({ tone: "error", text: describeError(error) });
			setPendingAction(null);
		}
	};

	const addEnvVar = () => {
		if (!newEnvKey().trim()) return;
		setEnvVars((prev) => [
			...prev,
			{ key: newEnvKey().trim(), value: newEnvValue(), secret: newEnvSecret(), isNew: true, isEdited: true },
		]);
		setNewEnvKey("");
		setNewEnvValue("");
		setNewEnvSecret(false);
		setShowAddEnv(false);
	};

	const removeEnvVar = (index: number) => {
		setEnvVars((prev) => prev.filter((_, i) => i !== index));
	};

	const updateEnvVar = (index: number, field: "key" | "value" | "secret", value: string | boolean) => {
		setEnvVars((prev) =>
			prev.map((e, i) =>
				i === index ? { ...e, [field]: value, isEdited: true } : e,
			),
		);
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

	const addCustomDomain = () => {
		const domain = newDomain().trim();
		if (!domain || customDomains().includes(domain)) return;
		setCustomDomains((prev) => [...prev, domain]);
		setNewDomain("");
	};

	const removeCustomDomain = (domain: string) => {
		setCustomDomains((prev) => prev.filter((d) => d !== domain));
		setHttpOnlyDomains((prev) => prev.filter((d) => d !== domain));
	};

	const domainHttpsEnabled = (domain: string) => !httpOnlyDomains().includes(domain);

	const setDomainHttpsEnabled = (domain: string, enabled: boolean) => {
		if (enabled) {
			setHttpOnlyDomains((prev) => prev.filter((d) => d !== domain));
			return;
		}

		setHttpOnlyDomains((prev) => (prev.includes(domain) ? prev : [...prev, domain]));
	};

	const httpsSummary = () => {
		if (customDomains().length === 0) return "No domains";
		const enabledCount = customDomains().filter((domain) => domainHttpsEnabled(domain)).length;
		if (enabledCount === 0) return "Disabled";
		if (enabledCount === customDomains().length) return "Enabled on all domains";
		return `Enabled on ${enabledCount} of ${customDomains().length} domains`;
	};

	const latestDeployment = () => (deployments() ?? [])[0];

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
								<div class="flex items-center gap-2">
									<button
										type="button"
										onClick={() => void runAction("start")}
										disabled={pendingAction() === "start" || currentService().status === "running"}
										class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
									>
										Start
									</button>
									<button
										type="button"
										onClick={() => void runAction("stop")}
										disabled={pendingAction() === "stop" || currentService().status === "stopped"}
										class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
									>
										Stop
									</button>
									<button
										type="button"
										onClick={() => void runAction("restart")}
										disabled={pendingAction() === "restart"}
										class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
									>
										Restart
									</button>
									<button
										type="button"
										onClick={() => void refreshAll()}
										class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
									>
										Refresh
									</button>
								</div>
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
									currentService().resource_kind !== "app_service" ? (
										<MaskedValue value={endpointFor(currentService())} />
									) : (
										endpointFor(currentService()).slice(0, 20) +
										(endpointFor(currentService()).length > 20 ? "..." : "")
									)
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
								<Match when={activeTab() === "http"}>
									<Show when={settings()}>
										{(currentSettings) => (
											<>
												<Panel title="HTTP Settings" subtitle="Configure web access and domain routing">
													<form
														class="flex flex-col gap-6"
														onSubmit={(e) => { e.preventDefault(); void saveHttpSettings(); }}
													>
														<div class="flex items-center gap-6">
															<label class="flex items-center gap-3 cursor-pointer">
																<input
																	type="checkbox"
																	checked={httpEnabled()}
																	onChange={(e) => setHttpEnabled(e.currentTarget.checked)}
																	class="h-4 w-4 rounded border-input text-primary focus:ring-primary"
																/>
																<span class="text-sm font-medium">Enable HTTP</span>
															</label>
														</div>

														<KeyValueTable
															rows={[
																["Public HTTP", httpEnabled() ? "Enabled" : "Disabled"],
																["HTTPS / SSL", httpsSummary()],
																["Default URL", currentService().default_urls[0] ?? "None"],
																["Custom Domains", `${customDomains().length} mapped`],
															]}
														/>

														<div class="border-t border-border pt-6">
															<h3 class="text-sm font-semibold mb-4">Custom Domain Routing</h3>
															<div class="flex flex-col gap-4">
																<div class="flex gap-2">
																	<input
																		class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																		value={newDomain()}
																		onInput={(e) => setNewDomain(e.currentTarget.value)}
																		placeholder="e.g. myapp.example.com"
																		onKeyDown={(e) => {
																			if (e.key === "Enter") {
																				e.preventDefault();
																				void addCustomDomain();
																			}
																		}}
																	/>
																	<button
																		type="button"
																		onClick={() => void addCustomDomain()}
																		class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4"
																	>
																		Add Domain
																	</button>
																</div>
																<Show
																	when={customDomains().length > 0}
																	fallback={
																		<p class="text-sm text-muted-foreground">
																			No custom domains mapped.
																		</p>
																	}
																>
																	<div class="rounded-lg border border-border overflow-hidden">
																		<table class="w-full text-sm">
																			<thead class="bg-muted/50">
																				<tr>
																					<th class="text-left px-4 py-2 font-medium text-muted-foreground">Domain</th>
																					<th class="text-left px-4 py-2 font-medium text-muted-foreground">HTTPS</th>
																					<th class="text-right px-4 py-2 font-medium text-muted-foreground">Action</th>
																				</tr>
																			</thead>
																			<tbody>
																				<For each={customDomains()}>
																					{(domain) => (
																						<tr class="border-t border-border hover:bg-muted/30">
																							<td class="px-4 py-2 font-mono">{domain}</td>
																							<td class="px-4 py-2">
																								<label class="flex items-center gap-2 cursor-pointer">
																									<input
																										type="checkbox"
																										checked={domainHttpsEnabled(domain)}
																										onChange={(e) => setDomainHttpsEnabled(domain, e.currentTarget.checked)}
																										class="h-4 w-4 rounded border-input text-primary focus:ring-primary"
																									/>
																									<span class="text-xs text-muted-foreground">
																										{domainHttpsEnabled(domain) ? "Enabled" : "Disabled"}
																									</span>
																								</label>
																							</td>
																							<td class="px-4 py-2 text-right">
																								<button
																									type="button"
																									onClick={() => removeCustomDomain(domain)}
																									class="text-xs text-destructive hover:underline"
																								>
																									Remove
																								</button>
																							</td>
																						</tr>
																					)}
																				</For>
																			</tbody>
																		</table>
																	</div>
																</Show>
																<p class="text-xs text-muted-foreground">
																	Point your DNS A record to this server's IP, or CNAME to the default domain. HTTPS is configured per domain and only enabled rows will request certificates.
																</p>
															</div>
														</div>

														<div class="flex gap-2 pt-4 border-t border-border">
															<button
																type="submit"
																class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
																disabled={pendingAction() === "save-http"}
															>
																Save HTTP Settings
															</button>
														</div>
													</form>
												</Panel>
											</>
										)}
									</Show>
								</Match>

								<Match when={activeTab() === "appconfigs"}>
									<Show when={settings()}>
										{(currentSettings) => (
											<>
												<Panel title="Scaling" subtitle="Set how many instances should run for this service">
													<div class="grid gap-4 md:grid-cols-[minmax(0,20rem)_1fr]">
														<div class="flex flex-col gap-2">
															<label class="text-sm font-medium" for="replica-count">
																Instance Count
															</label>
															<input
																id="replica-count"
																type="number"
																min="1"
																step="1"
																class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																value={replicas()}
																onInput={(e) => setReplicas(e.currentTarget.value)}
															/>
															<p class="text-xs text-muted-foreground">
																Saving app configs updates the desired instance count and running replicas.
															</p>
														</div>
														<KeyValueTable
															rows={[
																["Desired instances", replicas()],
																["Running instances", `${currentService().running_instances}`],
																["Live containers", `${currentService().container_ids.length}`],
															]}
														/>
													</div>
												</Panel>

												<Panel title="Environment Variables" subtitle="Configure runtime environment for this service">
													<div class="flex items-center justify-between mb-4">
														<div class="flex items-center gap-4">
															<label class="flex items-center gap-2 cursor-pointer">
																<input
																	id="bulk-edit-toggle"
																	type="checkbox"
																	checked={bulkEditMode()}
																	onChange={(e) => setBulkEditMode(e.currentTarget.checked)}
																	class="h-4 w-4 rounded border-input text-primary focus:ring-primary"
																/>
																<span class="text-sm font-medium" for="bulk-edit-toggle">Bulk Edit (KEY=VALUE per line)</span>
															</label>
														</div>
														<Show when={!bulkEditMode()}>
															<button
																type="button"
																onClick={() => setShowAddEnv(true)}
																class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2"
															>
																+ Add Variable
															</button>
														</Show>
													</div>

													<Show
														when={bulkEditMode()}
														fallback={
															<div class="flex flex-col gap-3">
																<Show when={showAddEnv()}>
																	<div class="flex items-end gap-2 p-4 rounded-lg border border-dashed border-border bg-muted/30">
																		<div class="flex flex-col gap-1 flex-1">
																			<label class="text-xs font-medium text-muted-foreground" for="new-env-key">Key</label>
																			<input
																				id="new-env-key"
																				class="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
																				value={newEnvKey()}
																				onInput={(e) => setNewEnvKey(e.currentTarget.value)}
																				placeholder="MY_VAR"
																			/>
																		</div>
																		<div class="flex flex-col gap-1 flex-1">
																			<label class="text-xs font-medium text-muted-foreground" for="new-env-value">Value</label>
																			<input
																				id="new-env-value"
																				class="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
																				value={newEnvValue()}
																				onInput={(e) => setNewEnvValue(e.currentTarget.value)}
																				placeholder="value"
																			/>
																		</div>
																		<label class="flex items-center gap-1 cursor-pointer pb-1">
																			<input
																				type="checkbox"
																				checked={newEnvSecret()}
																				onChange={(e) => setNewEnvSecret(e.currentTarget.checked)}
																				class="h-4 w-4 rounded border-input"
																			/>
																			<span class="text-xs">Secret</span>
																		</label>
																		<button
																			type="button"
																			onClick={() => addEnvVar()}
																			class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-8 px-3"
																		>
																			Add
																		</button>
																		<button
																			type="button"
																			onClick={() => setShowAddEnv(false)}
																			class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent shadow-sm h-8 px-3"
																		>
																			Cancel
																		</button>
																	</div>
																</Show>

																<Show
																	when={envVars().length > 0}
																	fallback={
																		<p class="text-sm text-muted-foreground p-4 text-center border rounded-lg border-dashed">
																			No environment variables defined.
																		</p>
																	}
																>
																	<div class="rounded-lg border border-border overflow-hidden">
																		<table class="w-full text-sm">
																			<thead class="bg-muted/50">
																				<tr>
																					<th class="text-left px-4 py-2 font-medium text-muted-foreground w-8">Secret</th>
																					<th class="text-left px-4 py-2 font-medium text-muted-foreground">Key</th>
																					<th class="text-left px-4 py-2 font-medium text-muted-foreground">Value</th>
																					<th class="text-right px-4 py-2 font-medium text-muted-foreground w-24">Action</th>
																				</tr>
																			</thead>
																			<tbody>
																				<For each={envVars()}>
																					{(env, index) => (
																						<tr class="border-t border-border hover:bg-muted/30">
																							<td class="px-4 py-2">
																								<input
																									type="checkbox"
																									checked={env.secret}
																									onChange={(e) => updateEnvVar(index(), "secret", e.currentTarget.checked)}
																									class="h-4 w-4 rounded border-input text-primary focus:ring-primary"
																								/>
																							</td>
																							<td class="px-4 py-2">
																								<input
																									class="flex h-8 w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
																									value={env.key}
																									onInput={(e) => updateEnvVar(index(), "key", e.currentTarget.value)}
																								/>
																							</td>
																							<td class="px-4 py-2">
																								<Show
																									when={env.secret}
																									fallback={
																										<input
																											class="flex h-8 w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
																											value={env.value}
																											onInput={(e) => updateEnvVar(index(), "value", e.currentTarget.value)}
																										/>
																									}
																								>
																									<div class="flex items-center gap-2">
																										<span class="font-mono text-muted-foreground text-sm">••••••••</span>
																										<input
																											type="password"
																											class="flex h-8 w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
																											value={env.value}
																											onInput={(e) => updateEnvVar(index(), "value", e.currentTarget.value)}
																											placeholder="Enter secret value"
																										/>
																									</div>
																								</Show>
																							</td>
																							<td class="px-4 py-2 text-right">
																								<button
																									type="button"
																									onClick={() => removeEnvVar(index())}
																									class="text-xs text-destructive hover:underline"
																								>
																									Remove
																								</button>
																							</td>
																						</tr>
																					)}
																				</For>
																			</tbody>
																		</table>
																	</div>
																</Show>

																<button
																	type="button"
																	onClick={() => {
																		setBulkEditMode(true);
																		setBulkEditText(envVars().map((e) => `${e.key}=${e.value}`).join("\n"));
																	}}
																	class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent shadow-sm h-7 px-3 w-fit"
																>
																	Switch to Bulk Edit
																</button>
															</div>
														}
													>
														<div class="flex flex-col gap-3">
															<div>
																<label class="text-xs font-medium text-muted-foreground mb-1 block" for="bulk-edit-textarea">
																	KEY=VALUE format — one entry per line
																</label>
																<textarea
																	id="bulk-edit-textarea"
																	class="flex min-h-[12rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
																	value={bulkEditText()}
																	onInput={(e) => setBulkEditText(e.currentTarget.value)}
																	placeholder={"MY_VAR=hello\nDEBUG=true\nAPI_KEY=secret123"}
																/>
															</div>
															<button
																type="button"
																onClick={() => setBulkEditMode(false)}
																class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent shadow-sm h-7 px-3 w-fit"
															>
																Switch to Form Edit
															</button>
														</div>
													</Show>

													<div class="flex gap-2 pt-4 border-t border-border">
														<button
															type="button"
															onClick={() => void saveAppConfigs()}
															disabled={pendingAction() === "save-appconfigs"}
															class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
														>
															Save App Configs
														</button>
													</div>
												</Panel>

												<Panel title="caprover_demo_env_variable">
													<Notice tone="info">
														<div class="text-sm space-y-2">
															<p class="font-medium">About Environment Variables</p>
															<p>
																Environment variables are injected into your container at runtime.
																Changes take effect on the next deployment.
															</p>
															<p>
																Variables marked as <strong>Secret</strong> are stored encrypted
																and hidden from the UI after saving.
															</p>
														</div>
													</Notice>
												</Panel>

												<Panel title="Auto-Deploy & Webhooks">
													<div class="flex flex-col gap-6">
														<label class="flex items-center gap-3 cursor-pointer">
															<input
																type="checkbox"
																checked={autoDeployEnabled()}
																onChange={(e) => setAutoDeployEnabled(e.currentTarget.checked)}
																class="h-4 w-4 rounded border-input text-primary focus:ring-primary"
															/>
															<span class="text-sm font-medium">Enable Auto-Deploy from Git</span>
														</label>

														<div class="flex flex-col gap-2">
															<span class="text-sm font-medium">Watch Paths</span>
															<small class="text-[0.8rem] text-muted-foreground">
																Changes to these paths trigger auto-deploy. One relative path per line.
															</small>
															<textarea
																class="flex min-h-[6rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
																value={watchPathsText()}
																onInput={(e) => setWatchPathsText(e.currentTarget.value)}
																placeholder="src/\npackage.json"
															/>
														</div>

														<KeyValueTable
															rows={[
																[
																	"Webhook Path",
																	<span class="font-mono break-all">
																		{currentSettings().auto_deploy.webhook_path}
																	</span>,
																],
																[
																	"Webhook Token",
																	<span class="font-mono break-all">
																		{currentSettings().auto_deploy.webhook_token.slice(0, 12)}...
																	</span>,
																],
															]}
														/>

														<div class="flex gap-2">
															<button
																type="button"
																onClick={() => void copyText(currentSettings().auto_deploy.webhook_token)}
																class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
															>
																Copy Token
															</button>
														</div>
													</div>
												</Panel>
											</>
										)}
									</Show>
								</Match>

								<Match when={activeTab() === "deployment"}>
									<Show when={settings()}>
										{(currentSettings) => (
											<>
												<Panel title="Deployment Methods">
													<div class="flex flex-col gap-6">
														<div class="grid gap-4 sm:grid-cols-2">
															<label class="flex flex-col gap-2">
																<span class="text-sm font-medium leading-none">Branch</span>
																<input
																	class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																	value={deployBranch()}
																	onInput={(e) => setDeployBranch(e.currentTarget.value)}
																	placeholder="main"
																/>
															</label>
															<label class="flex flex-col gap-2">
																<span class="text-sm font-medium leading-none">Rollout Strategy</span>
																<select
																	class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																	value={deployRolloutStrategy()}
																	onChange={(e) => setDeployRolloutStrategy(e.currentTarget.value)}
																>
																	<option value="stop_first">Stop First (default)</option>
																	<option value="start_first">Start First</option>
																</select>
															</label>
															<label class="flex flex-col gap-2">
																<span class="text-sm font-medium leading-none">Commit SHA (optional)</span>
																<input
																	class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
																	value={deployCommitSha()}
																	onInput={(e) => setDeployCommitSha(e.currentTarget.value)}
																	placeholder="Specific commit to deploy"
																/>
															</label>
															<label class="flex flex-col gap-2">
																<span class="text-sm font-medium leading-none">Commit Message (optional)</span>
																<input
																	class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
																	value={deployCommitMessage()}
																	onInput={(e) => setDeployCommitMessage(e.currentTarget.value)}
																	placeholder="Deployment note"
																/>
															</label>
														</div>

														<div class="flex gap-2 pt-2">
															<button
																type="button"
																onClick={() => void deploy()}
																disabled={pendingAction() === "deploy"}
																class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
															>
																Deploy Now
															</button>
														</div>
													</div>
												</Panel>

												<Panel title="Port Mapping">
													<KeyValueTable
														rows={[
															["Container Port", currentSettings().service.port],
															["Exposed HTTP", currentSettings().service.expose_http ? "Yes" : "No"],
															["Additional Ports", currentSettings().service.additional_ports.join(", ") || "None"],
															["Public Exposed Port", currentService().external_port ?? "None"],
														]}
													/>
												</Panel>

												<Panel title="Version History">
													<div class="flex items-center justify-between mb-4">
														<div class="flex items-center gap-2 text-sm text-muted-foreground">
															<span class="relative flex h-2 w-2">
																<span class="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
																<span class="relative inline-flex h-2 w-2 rounded-full bg-primary" />
															</span>
															Auto-refreshing every 5s
														</div>
														<button
															type="button"
															onClick={() => void refetchDeployments()}
															class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
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
																			<div
																				class={`flex items-center gap-4 px-4 py-3 w-full transition-colors hover:bg-secondary/30 cursor-pointer ${
																					isOpen() ? "bg-secondary/30" : ""
																				}`}
																				onClick={toggle}
																			>
																				<span class={`text-muted-foreground text-xs transition-transform shrink-0 ${isOpen() ? "rotate-90" : ""}`}>
																					›
																				</span>
																				<div class="flex-1 min-w-0">
																					<p class="text-sm font-medium truncate">
																						{deployment.commit_message ?? "Manual deployment"}
																					</p>
																					<p class="text-xs text-muted-foreground mt-0.5 font-mono truncate">
																						{deployment.commit_sha
																							? deployment.commit_sha.slice(0, 7)
																							: "—"}
																					</p>
																				</div>
																				<StatusBadge status={deployment.status} />
																				<span class="text-xs text-muted-foreground shrink-0 hidden lg:block">
																					{formatDateTime(deployment.started_at)}
																				</span>
																			</div>

																			<Show when={isOpen()}>
																				<div class="px-4 py-4 bg-secondary/10 flex flex-col gap-4">
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
																							<dd class="font-mono">{deployment.commit_sha ?? "—"}</dd>
																						</div>
																					</div>

																					<div class="flex flex-wrap gap-2">
																						<button
																							class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent shadow-sm h-7 px-3"
																							type="button"
																							onClick={() => void rollback(deployment.id)}
																							disabled={pendingAction() === `rollback-${deployment.id}`}
																						>
																							Rollback
																						</button>
																						<button
																							class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent shadow-sm h-7 px-3"
																							type="button"
																							onClick={() => deploymentLogStream.connect()}
																						>
																							Reconnect Logs
																						</button>
																					</div>

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
																						{deploymentLogStream.logs().join("\n") || "No logs yet. Click Reconnect Logs to stream."}
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
											</>
										)}
									</Show>
								</Match>

								<Match when={activeTab() === "logs"}>
									<Panel title="Application Logs" subtitle="Combined logs from all containers in this service">
										<LogViewer serviceId={serviceId()} />
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
