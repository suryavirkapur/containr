import {
	Component,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	ErrorBoundary,
	For,
	onCleanup,
	Show,
} from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import EnvVarEditor from "../components/EnvVarEditor";
import ServiceForm, {
	Service,
	ServiceType,
	createServiceForType,
	serviceTypeLabel,
} from "../components/ServiceForm";
import { parseAnsi } from "../utils/ansi";
import ContainerMonitor from "../components/ContainerMonitor";
import { api, components } from "../api";
import {
	createPrimaryService,
	EditableEnvVar,
	mapServiceResponseToForm,
	mapServiceToRequest,
} from "../utils/projectEditor";

type Project = components["schemas"]["AppResponse"];
type Deployment = components["schemas"]["DeploymentResponse"];
type CertificateStatus = components["schemas"]["CertificateResponse"];
type ContainerListItem = components["schemas"]["ContainerListItem"];
type RuntimeStatus =
	| "pending"
	| "starting"
	| "running"
	| "partial"
	| "stopped"
	| "failed";

interface ServiceInventoryItem {
	id: string;
	group_id?: string | null;
	project_id?: string | null;
	resource_kind: string;
	service_type: string;
	name: string;
	status: RuntimeStatus;
	desired_instances: number;
	running_instances: number;
	default_urls: string[];
	container_ids: string[];
	schedule?: string | null;
	updated_at: string;
}

const serviceTypeOptions: ServiceType[] = [
	"web_service",
	"private_service",
	"background_worker",
	"cron_job",
];

function nextServiceName(
	services: Service[],
	serviceType: ServiceType,
): string {
	const baseName =
		serviceType === "web_service"
			? "web"
			: serviceType === "private_service"
				? "private"
				: serviceType === "background_worker"
					? "worker"
					: "cron";

	if (!services.some((service) => service.name === baseName)) {
		return baseName;
	}

	let counter = 2;
	while (
		services.some((service) => service.name === `${baseName}-${counter}`)
	) {
		counter += 1;
	}

	return `${baseName}-${counter}`;
}

/**
 * fetches project details
 */
const fetchProject = async (id: string): Promise<Project> => {
	const { data, error } = await api.GET("/api/projects/{id}", {
		params: { path: { id } },
	});
	if (error) throw error;
	return data;
};

/**
 * fetches deployments for a project
 */
const fetchDeployments = async (projectId: string): Promise<Deployment[]> => {
	const { data, error } = await api.GET("/api/projects/{id}/deployments", {
		params: { path: { id: projectId } },
	});
	if (error) throw error;
	return data;
};

/**
 * fetches certificate status for a project
 */
const fetchCertificate = async (
	projectId: string,
): Promise<CertificateStatus[]> => {
	const { data, error } = await api.GET("/api/projects/{id}/certificate", {
		params: { path: { id: projectId } },
	});
	if (error) throw error;
	return data;
};

/**
 * fetches containers for the user
 */
const fetchContainers = async (): Promise<ContainerListItem[]> => {
	const { data, error } = await api.GET("/api/containers");
	if (error) throw error;
	return data;
};

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

const readRequestError = async (response: Response): Promise<string> => {
	try {
		const data = (await response.json()) as { error?: string };
		if (typeof data.error === "string" && data.error.trim()) {
			return data.error;
		}
	} catch {
		// ignore malformed json and use a generic fallback below
	}

	return `request failed with status ${response.status}`;
};

const fetchServices = async (): Promise<ServiceInventoryItem[]> => {
	const response = await fetch("/api/services", {
		headers: buildAuthHeaders(),
	});

	handleUnauthorized(response);
	if (!response.ok) {
		throw new Error(await readRequestError(response));
	}

	return (await response.json()) as ServiceInventoryItem[];
};

/**
 * project detail page
 */
const AppDetail: Component = () => {
	const params = useParams();
	const navigate = useNavigate();
	const [deploying, setDeploying] = createSignal(false);
	const [deployError, setDeployError] = createSignal("");
	const [deleting, setDeleting] = createSignal(false);

	// deployment logs state
	const [selectedDeployment, setSelectedDeployment] =
		createSignal<Deployment | null>(null);
	const [deploymentLogs, setDeploymentLogs] = createSignal<string[]>([]);
	const [deploymentLogOffset, setDeploymentLogOffset] = createSignal(0);
	const [deploymentLogHasMore, setDeploymentLogHasMore] = createSignal(true);
	const [deploymentLogsConnected, setDeploymentLogsConnected] =
		createSignal(false);
	const [deploymentLogsLoading, setDeploymentLogsLoading] = createSignal(false);
	let deploymentLogsSocket: WebSocket | null = null;
	let deploymentLogsRef: HTMLDivElement | undefined;

	const [app, { refetch: refetchApp }] = createResource(
		() => params.id,
		fetchProject,
	);

	const [deployments, { refetch: refetchDeployments }] = createResource(
		() => params.id,
		fetchDeployments,
	);

	const [certificate, { refetch: refetchCertificate }] = createResource(
		() => params.id,
		fetchCertificate,
	);
	const [serviceInventory, { refetch: refetchServiceInventory }] =
		createResource(fetchServices);

	const [containers, { refetch: refetchContainers }] =
		createResource(fetchContainers);
	const [selectedContainer, setSelectedContainer] = createSignal("");
	const [selectedServiceId, setSelectedServiceId] = createSignal("");

	const appContainers = createMemo(() =>
		(containers() || []).filter(
			(item) => item.resource_type === "app" && item.resource_id === params.id,
		),
	);
	const projectServices = createMemo(() => app()?.services || []);
	const projectRuntimeServices = createMemo(() =>
		(serviceInventory() || []).filter(
			(service) =>
				service.resource_kind === "app_service" &&
				(service.project_id === params.id || service.group_id === params.id),
		),
	);
	const serviceRuntimeById = createMemo(() => {
		const entries = projectRuntimeServices().map((service) => [
			service.id,
			service,
		]);
		return new Map(entries);
	});
	const selectedProjectService = createMemo(
		() =>
			projectServices().find((service) => service.id === selectedServiceId()) ||
			projectServices()[0],
	);
	const latestDeployment = createMemo(() => deployments()?.[0] || null);

	createEffect(() => {
		if (
			selectedContainer() &&
			!appContainers().some((container) => container.id === selectedContainer())
		) {
			setSelectedContainer("");
		}

		if (!selectedContainer() && appContainers().length > 0) {
			setSelectedContainer(appContainers()[0].id);
		}
	});

	createEffect(() => {
		if (
			selectedServiceId() &&
			!projectServices().some((service) => service.id === selectedServiceId())
		) {
			setSelectedServiceId("");
		}

		if (!selectedServiceId() && projectServices().length > 0) {
			setSelectedServiceId(projectServices()[0].id);
		}
	});

	createEffect(() => {
		const items = deployments();
		if (
			!items ||
			!items.some((deployment) => isLiveDeployment(deployment.status))
		) {
			return;
		}

		const interval = setInterval(() => {
			refetchDeployments();
			refetchContainers();
			refetchServiceInventory();
		}, 3000);

		onCleanup(() => clearInterval(interval));
	});

	const [reissuing, setReissuing] = createSignal(false);

	const reissueCertificate = async (domain?: string) => {
		setReissuing(true);
		try {
			const { error } = await api.POST(
				"/api/projects/{id}/certificate/reissue",
				{
					params: { path: { id: params.id! } },
					body: domain ? { domain } : {},
				},
			);
			if (error) throw error;

			refetchCertificate();
		} catch (err) {
			console.error(err);
		} finally {
			setReissuing(false);
		}
	};

	const copyToClipboard = (text: string) => {
		if (!text || typeof navigator === "undefined") return;
		navigator.clipboard.writeText(text);
	};

	const [serviceMountAction, setServiceMountAction] = createSignal<{
		service: string;
		kind: "backup" | "restore";
	} | null>(null);
	const [serviceMountActionError, setServiceMountActionError] = createSignal<{
		service: string;
		message: string;
	} | null>(null);

	const readApiError = async (response: Response) => {
		try {
			const body = await response.json();
			if (
				body &&
				typeof body === "object" &&
				"error" in body &&
				typeof body.error === "string"
			) {
				return body.error;
			}
		} catch {}
		return "operation failed";
	};

	const downloadServiceMounts = async (serviceName: string) => {
		const token = localStorage.getItem("containr_token");
		if (!token) {
			throw new Error("missing auth token");
		}

		setServiceMountAction({ service: serviceName, kind: "backup" });
		setServiceMountActionError(null);

		try {
			const response = await fetch(
				`/api/projects/${params.id}/services/${encodeURIComponent(serviceName)}/mounts/backup`,
				{
					headers: {
						Authorization: `Bearer ${token}`,
					},
				},
			);

			if (!response.ok) {
				throw new Error(await readApiError(response));
			}

			const blob = await response.blob();
			const currentApp = app();
			const fileName = `${currentApp?.name || "app"}-${serviceName}-mounts.tar`;
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = fileName;
			document.body.appendChild(anchor);
			anchor.click();
			document.body.removeChild(anchor);
			URL.revokeObjectURL(url);
		} catch (error) {
			setServiceMountActionError({
				service: serviceName,
				message:
					error instanceof Error
						? error.message
						: "failed to back up service mounts",
			});
		} finally {
			setServiceMountAction(null);
		}
	};

	const restoreServiceMounts = async (
		serviceName: string,
		files: FileList | null,
	) => {
		const archive = files?.[0];
		if (!archive) {
			return;
		}

		const token = localStorage.getItem("containr_token");
		if (!token) {
			throw new Error("missing auth token");
		}

		if (
			!confirm(
				`restore mounts for ${serviceName}? existing mount data will be replaced.`,
			)
		) {
			return;
		}

		setServiceMountAction({ service: serviceName, kind: "restore" });
		setServiceMountActionError(null);

		try {
			const form = new FormData();
			form.append("archive", archive, archive.name);

			const response = await fetch(
				`/api/projects/${params.id}/services/${encodeURIComponent(serviceName)}/mounts/restore`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
					},
					body: form,
				},
			);

			if (!response.ok) {
				throw new Error(await readApiError(response));
			}
		} catch (error) {
			setServiceMountActionError({
				service: serviceName,
				message:
					error instanceof Error
						? error.message
						: "failed to restore service mounts",
			});
		} finally {
			setServiceMountAction(null);
		}
	};

	// Edit form state
	const [editing, setEditing] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [editError, setEditError] = createSignal("");
	const [editForm, setEditForm] = createSignal({
		github_url: "",
		branch: "main",
		env_vars: [] as EditableEnvVar[],
		services: [] as Service[],
	});

	const formatServicePorts = (service: Project["services"][number]) => {
		if (
			service.service_type === "background_worker" ||
			service.service_type === "cron_job" ||
			service.port === 0
		) {
			if (service.additional_ports.length === 0) {
				return "no inbound port";
			}

			return `no inbound port + ${service.additional_ports.join(", ")}`;
		}

		if (service.additional_ports.length === 0) {
			return `:${service.port}`;
		}

		return `:${service.port} + ${service.additional_ports.join(", ")}`;
	};

	const formatServiceHealth = (service: Project["services"][number]) => {
		if (
			service.service_type === "background_worker" ||
			service.service_type === "cron_job"
		) {
			return service.health_check ? "custom" : "not used";
		}

		if (!service.health_check) {
			return "none";
		}

		return `${service.health_check.path} every ${service.health_check.interval_secs}s`;
	};

	const formatServiceHealthDetail = (service: Project["services"][number]) => {
		if (
			service.service_type === "background_worker" ||
			service.service_type === "cron_job"
		) {
			return service.health_check
				? "custom worker health check"
				: "not used for worker or cron services";
		}

		if (!service.health_check) {
			return "none";
		}

		const healthCheck = service.health_check;
		return `${healthCheck.path} / ${healthCheck.interval_secs}s / ${
			healthCheck.timeout_secs
		}s / ${healthCheck.retries} retries`;
	};

	const formatServiceRegistry = (service: Project["services"][number]) => {
		if (!service.registry_auth) {
			return "none";
		}

		const registryAuth = service.registry_auth;
		return registryAuth.server
			? `${registryAuth.username} @ ${registryAuth.server}`
			: registryAuth.username;
	};

	const formatPublicUrlStatus = (service: Project["services"][number]) => {
		if (service.service_type !== "web_service") {
			return "none";
		}

		if (!service.domains || service.domains.length === 0) {
			return "service subdomain";
		}

		return `service subdomain + ${service.domains.length} custom domain${
			service.domains.length === 1 ? "" : "s"
		}`;
	};

	const appDomains = createMemo(() => {
		const current = app();
		if (!current) return [];
		const serviceDomains = Array.from(
			new Set(
				(current.services || []).flatMap((service) => service.domains || []),
			),
		);
		if (serviceDomains.length > 0) {
			return serviceDomains;
		}
		return current.domains && current.domains.length > 0
			? current.domains
			: current.domain
				? [current.domain]
				: [];
	});

	const certificateList = createMemo(() => certificate() || []);
	const serviceTypeCounts = createMemo(() => {
		const services = projectServices();
		return {
			web: services.filter((service) => service.service_type === "web_service")
				.length,
			private: services.filter(
				(service) => service.service_type === "private_service",
			).length,
			workers: services.filter(
				(service) => service.service_type === "background_worker",
			).length,
			cron: services.filter((service) => service.service_type === "cron_job")
				.length,
		};
	});

	const projectRuntimeStatus = createMemo<RuntimeStatus>(() => {
		const runtimeServices = projectRuntimeServices();
		if (runtimeServices.length > 0) {
			if (runtimeServices.every((service) => service.status === "running")) {
				return "running";
			}

			if (runtimeServices.some((service) => service.status === "running")) {
				return "partial";
			}

			if (runtimeServices.some((service) => service.status === "failed")) {
				return "failed";
			}

			if (
				runtimeServices.some(
					(service) =>
						service.status === "starting" || service.status === "pending",
				)
			) {
				return "starting";
			}

			if (runtimeServices.every((service) => service.status === "stopped")) {
				return "stopped";
			}

			return runtimeServices[0].status;
		}

		const deployment = latestDeployment();
		if (!deployment) {
			return "pending";
		}

		switch (deployment.status) {
			case "running":
				return appContainers().length > 0 ? "running" : "stopped";
			case "failed":
				return "failed";
			case "stopped":
				return "stopped";
			case "pending":
				return "pending";
			case "cloning":
			case "building":
			case "pushing":
			case "starting":
				return "starting";
		}
	});

	const projectRuntimeText = createMemo(() => {
		switch (projectRuntimeStatus()) {
			case "running":
				return "running";
			case "partial":
				return "partially running";
			case "starting":
				return "deploying";
			case "failed":
				return "failed";
			case "stopped":
				return "stopped";
			case "pending":
			default:
				return "pending";
		}
	});

	const projectRuntimeDetail = createMemo(() => {
		const runtimeServices = projectRuntimeServices();
		if (runtimeServices.length > 0) {
			const running = runtimeServices.reduce(
				(total, service) => total + service.running_instances,
				0,
			);
			const desired = runtimeServices.reduce(
				(total, service) => total + service.desired_instances,
				0,
			);
			if (desired === 0) {
				return "no active instances";
			}
			return `${running}/${desired} instances ready`;
		}

		const deployment = latestDeployment();
		if (!deployment) {
			return "no deployment recorded";
		}

		return `latest deployment ${deployment.status}`;
	});

	const runtimeStatusDotClass = (status: RuntimeStatus) => {
		switch (status) {
			case "running":
				return "bg-emerald-400";
			case "partial":
				return "bg-blue-400";
			case "starting":
			case "pending":
				return "bg-yellow-400 animate-pulse";
			case "failed":
				return "bg-red-400";
			case "stopped":
			default:
				return "bg-neutral-500";
		}
	};

	const serviceRuntime = (serviceId: string) =>
		serviceRuntimeById().get(serviceId);

	const resourceErrorMessage = (value: unknown): string | null => {
		if (!value) {
			return null;
		}

		if (value instanceof Error && value.message) {
			return value.message;
		}

		if (
			typeof value === "object" &&
			value &&
			"error" in value &&
			typeof value.error === "string"
		) {
			return value.error;
		}

		return "failed to load project detail";
	};

	const pageError = createMemo(() => {
		return (
			resourceErrorMessage(app.error) ||
			resourceErrorMessage(deployments.error) ||
			resourceErrorMessage(certificate.error) ||
			resourceErrorMessage(containers.error) ||
			resourceErrorMessage(serviceInventory.error)
		);
	});

	const certificateStatusLabel = (status: CertificateStatus["status"]) => {
		switch (status) {
			case "valid":
				return "valid";
			case "expiringsoon":
				return "expiring";
			case "expired":
				return "expired";
			case "pending":
				return "pending";
			case "failed":
				return "failed";
			default:
				return "none";
		}
	};

	const certificateDotClass = (status: CertificateStatus["status"]) => {
		switch (status) {
			case "valid":
				return "bg-black";
			case "expiringsoon":
				return "bg-neutral-400";
			case "expired":
			case "failed":
				return "bg-neutral-300";
			case "pending":
				return "bg-neutral-400 animate-pulse";
			default:
				return "bg-neutral-200";
		}
	};

	const openEditModal = () => {
		const currentApp = app();
		if (currentApp) {
			const services =
				currentApp.services.length > 0
					? currentApp.services.map(mapServiceResponseToForm)
					: [
							{
								...createPrimaryService(),
								port: currentApp.port,
							},
						];
			setEditForm({
				github_url: currentApp.github_url,
				branch: currentApp.branch,
				env_vars: currentApp.env_vars
					? currentApp.env_vars.map((e) => ({ ...e }))
					: [],
				services,
			});
			setEditError("");
			setEditing(true);
		}
	};

	const addEditService = (serviceType: ServiceType) => {
		setEditForm((previous) => {
			const nextService = createServiceForType(serviceType);
			nextService.name = nextServiceName(previous.services, serviceType);

			return {
				...previous,
				services: [...previous.services, nextService],
			};
		});
	};

	const updateEditService = (index: number, service: Service) => {
		setEditForm((previous) => {
			const services = [...previous.services];
			services[index] = service;
			return {
				...previous,
				services,
			};
		});
	};

	const removeEditService = (index: number) => {
		setEditForm((previous) => ({
			...previous,
			services: previous.services.filter(
				(_, serviceIndex) => serviceIndex !== index,
			),
		}));
	};

	const readErrorMessage = (error: unknown) => {
		if (
			typeof error === "object" &&
			error !== null &&
			"error" in error &&
			typeof error.error === "string"
		) {
			return error.error;
		}

		if (error instanceof Error && error.message) {
			return error.message;
		}

		return "failed to update group";
	};

	const updateApp = async () => {
		setSaving(true);
		setEditError("");
		try {
			const form = editForm();
			const services = form.services;
			if (services.length === 0) {
				throw new Error("add at least one service");
			}

			const { error } = await api.PUT("/api/projects/{id}", {
				params: { path: { id: params.id! } },
				body: {
					github_url: form.github_url,
					branch: form.branch,
					env_vars: form.env_vars,
					services: services.map(mapServiceToRequest),
				},
			});
			if (error) throw error;

			setEditing(false);
			refetchApp();
			refetchCertificate();
			refetchContainers();
			refetchServiceInventory();
		} catch (err) {
			setEditError(readErrorMessage(err));
		} finally {
			setSaving(false);
		}
	};

	// Logs state
	const [logs, setLogs] = createSignal<string[]>([]);
	const [logsConnected, setLogsConnected] = createSignal(false);
	const [showLogs, setShowLogs] = createSignal(false);
	let logsSocket: WebSocket | null = null;
	let logsRef: HTMLDivElement | undefined;

	const connectLogs = () => {
		if (typeof window === "undefined") return;

		try {
			if (logsSocket) {
				logsSocket.close();
			}

			setLogs([]);
			setLogsConnected(false);

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const wsUrl = `${protocol}//${window.location.host}/api/projects/${params.id}/logs/ws?tail=100`;

			setLogs(["connecting..."]);

			logsSocket = new WebSocket(wsUrl);

			logsSocket.onopen = () => {
				setLogsConnected(true);
				setLogs((prev) => [...prev, "[connected]"]);
			};

			logsSocket.onmessage = (event) => {
				setLogs((prev) => [...prev, event.data]);
				if (logsRef) {
					logsRef.scrollTop = logsRef.scrollHeight;
				}
			};

			logsSocket.onclose = (event) => {
				setLogsConnected(false);
				setLogs((prev) => [...prev, `[disconnected: ${event.code}]`]);
			};

			logsSocket.onerror = () => {
				setLogsConnected(false);
				setLogs((prev) => [...prev, "[error]"]);
			};
		} catch (err) {
			setLogsConnected(false);
			setLogs([`error: ${err}`]);
		}
	};

	const disconnectLogs = () => {
		if (logsSocket) {
			logsSocket.close();
			logsSocket = null;
		}
		setLogsConnected(false);
	};

	const toggleLogs = () => {
		if (showLogs()) {
			disconnectLogs();
			setShowLogs(false);
		} else {
			setShowLogs(true);
			connectLogs();
		}
	};

	// fetch historical deployment logs
	const fetchDeploymentLogs = async (deploymentId: string, reset = false) => {
		setDeploymentLogsLoading(true);
		try {
			const limit = 100;
			const offset = reset ? 0 : deploymentLogOffset();

			const { data, error } = await api.GET(
				"/api/projects/{project_id}/deployments/{id}/logs",
				{
					params: {
						path: { project_id: params.id!, id: deploymentId },
						query: { limit, offset },
					},
				},
			);
			if (error) throw error;
			const logs = data;

			if (reset) {
				setDeploymentLogs(logs);
			} else {
				setDeploymentLogs((prev) => [...prev, ...logs]);
			}

			setDeploymentLogOffset(offset + logs.length);
			setDeploymentLogHasMore(logs.length === limit);

			return logs.length;
		} catch (err) {
			console.error(err);
			if (reset) setDeploymentLogs(["error fetching logs"]);
			return 0;
		} finally {
			setDeploymentLogsLoading(false);
		}
	};

	const loadMoreLogs = () => {
		const deployment = selectedDeployment();
		if (deployment) {
			fetchDeploymentLogs(deployment.id, false);
		}
	};

	// connect to live deployment logs
	const connectDeploymentLogs = (deploymentId: string, offset = 0) => {
		if (typeof window === "undefined") return;

		try {
			if (deploymentLogsSocket) {
				deploymentLogsSocket.close();
			}

			setDeploymentLogsConnected(false);

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const wsUrl = `${protocol}//${window.location.host}/api/projects/${params.id}/deployments/${deploymentId}/logs/ws?offset=${offset}`;

			deploymentLogsSocket = new WebSocket(wsUrl);

			deploymentLogsSocket.onopen = () => {
				setDeploymentLogsConnected(true);
			};

			deploymentLogsSocket.onmessage = (event) => {
				setDeploymentLogs((prev) => [...prev, event.data]);
				if (deploymentLogsRef) {
					deploymentLogsRef.scrollTop = deploymentLogsRef.scrollHeight;
				}
			};

			deploymentLogsSocket.onclose = () => {
				setDeploymentLogsConnected(false);
			};

			deploymentLogsSocket.onerror = () => {
				setDeploymentLogsConnected(false);
			};
		} catch (err) {
			setDeploymentLogsConnected(false);
		}
	};

	const isLiveDeployment = (status: Deployment["status"]) =>
		["pending", "cloning", "building", "starting"].includes(status);

	const openDeploymentLogs = async (deployment: Deployment) => {
		setSelectedDeployment(deployment);
		setDeploymentLogs([]);
		setDeploymentLogOffset(0);
		setDeploymentLogHasMore(true);

		const initialLogCount = await fetchDeploymentLogs(deployment.id, true);

		if (isLiveDeployment(deployment.status)) {
			connectDeploymentLogs(deployment.id, initialLogCount);
		}
	};

	const closeDeploymentLogs = () => {
		if (deploymentLogsSocket) {
			deploymentLogsSocket.close();
			deploymentLogsSocket = null;
		}
		setSelectedDeployment(null);
		setDeploymentLogs([]);
		setDeploymentLogsConnected(false);
	};

	const triggerDeploy = async () => {
		setDeploying(true);
		setDeployError("");
		try {
			const { error } = await api.POST("/api/projects/{id}/deployments", {
				params: { path: { id: params.id! } },
				body: {},
			});
			if (error) throw error;

			refetchDeployments();
			refetchContainers();
			refetchServiceInventory();
		} catch (err) {
			console.error(err);
			if (typeof err === "object" && err && "error" in err) {
				const message = err.error;
				if (typeof message === "string" && message) {
					setDeployError(message);
				} else {
					setDeployError("failed to trigger deployment");
				}
			} else if (err instanceof Error && err.message) {
				setDeployError(err.message);
			} else {
				setDeployError("failed to trigger deployment");
			}
		} finally {
			setDeploying(false);
		}
	};

	const deleteApp = async () => {
		if (!confirm("are you sure you want to delete this group?")) {
			return;
		}

		setDeleting(true);
		try {
			const { error } = await api.DELETE("/api/projects/{id}", {
				params: { path: { id: params.id! } },
			});
			if (error) throw error;

			navigate("/projects");
		} catch (err) {
			console.error(err);
			setDeleting(false);
		}
	};

	const statusIndicator = (status: string) => {
		switch (status) {
			case "running":
				return "bg-emerald-400";
			case "pending":
			case "cloning":
			case "building":
			case "starting":
				return "bg-yellow-400 animate-pulse";
			case "failed":
				return "bg-red-400";
			case "stopped":
				return "bg-neutral-500";
			default:
				return "bg-neutral-500";
		}
	};

	const [activeSection, setActiveSection] = createSignal("overview");

	const sidebarItems = [
		{
			id: "overview",
			label: "overview",
			icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
		},
		{
			id: "services",
			label: "services",
			icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10",
		},
		{
			id: "logs",
			label: "logs",
			icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
		},
		{
			id: "monitor",
			label: "monitor",
			icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
		},
		{
			id: "deployments",
			label: "deployments",
			icon: "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
		},
		{
			id: "settings",
			label: "settings",
			icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z",
		},
	];

	return (
		<ErrorBoundary
			fallback={(error) => (
				<div class="border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
					{error.message || "failed to render project detail"}
				</div>
			)}
		>
			<div>
				<Show when={pageError()}>
					<div class="mb-6 border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
						{pageError()}
					</div>
				</Show>

				{/* loading */}
				<Show when={app.loading && !app()}>
					<div class="animate-pulse">
						<div class="h-7 bg-neutral-800 w-1/4 mb-3"></div>
						<div class="h-4 bg-neutral-800/50 w-1/2 mb-10"></div>
						<div class="border border-neutral-800 p-8">
							<div class="h-5 bg-neutral-800 w-full mb-4"></div>
							<div class="h-5 bg-neutral-800/50 w-3/4"></div>
						</div>
					</div>
				</Show>

				{/* content */}
				<Show when={app()}>
					{/* header */}
					<div class="flex justify-between items-start mb-6">
						<div>
							<div class="flex items-center gap-3">
								<h1 class="text-2xl font-semibold text-white">{app()!.name}</h1>
								<Badge variant="default">docker</Badge>
							</div>
							<p class="text-neutral-500 mt-1.5 text-sm font-mono">
								{app()!.github_url}
							</p>
							<div class="flex items-center gap-3 mt-2">
								<span class="flex items-center gap-1.5 text-xs text-neutral-400">
									<span
										class={`w-1.5 h-1.5 ${runtimeStatusDotClass(
											projectRuntimeStatus(),
										)}`}
									></span>
									{projectRuntimeText()}
								</span>
								<span class="text-neutral-600">·</span>
								<span class="text-xs text-neutral-400 font-mono">
									{app()!.branch}
								</span>
								<span class="text-neutral-600">·</span>
								<span class="text-xs text-neutral-400">
									{projectRuntimeDetail()}
								</span>
							</div>
						</div>
						<div class="flex gap-2">
							<button
								onClick={triggerDeploy}
								disabled={deploying()}
								class="px-4 py-1.5 bg-white text-black hover:bg-neutral-200 disabled:opacity-50 transition-colors text-sm font-medium cursor-pointer"
							>
								{deploying() ? "deploying..." : "manual deploy"}
							</button>
						</div>
					</div>

					<Show when={deployError()}>
						<div class="mb-6 border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-400">
							{deployError()}
						</div>
					</Show>

					{/* sidebar + content layout */}
					<div class="flex gap-6">
						{/* info grid */}
						<div class="grid grid-cols-4 gap-px bg-neutral-200 mb-8">
							{/* status */}
							<div class="bg-white p-5">
								<h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">
									status
								</h3>
								<div class="flex items-center gap-2">
									<span
										class={`w-2 h-2 ${runtimeStatusDotClass(
											projectRuntimeStatus(),
										)}`}
									></span>
									<span class="text-black text-sm">{projectRuntimeText()}</span>
								</div>
								<p class="mt-2 text-xs text-neutral-500">
									{projectRuntimeDetail()}
								</p>
							</div>

							{/* custom domains */}
							<div class="bg-white p-5">
								<h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">
									custom domains
								</h3>
								<Show
									when={appDomains().length > 0}
									fallback={<span class="text-neutral-400 text-sm">n/a</span>}
								>
									<div class="space-y-1">
										<For each={appDomains().slice(0, 2)}>
											{(domain) => (
												<a
													href={`https://${domain}`}
													target="_blank"
													class="block text-black text-sm hover:underline"
												>
													{domain}
												</a>
											)}
										</For>
										<Show when={appDomains().length > 2}>
											<span class="text-xs text-neutral-400">
												+{appDomains().length - 2} more
											</span>
										</Show>
									</div>
								</Show>
							</div>

							{/* branch */}
							<div class="bg-white p-5">
								<h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">
									branch
								</h3>
								<span class="text-black text-sm font-mono">
									{app()!.branch}
								</span>
							</div>

							{/* certificate */}
							<div class="bg-white p-5">
								<h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">
									ssl
								</h3>
								<Show when={certificate.loading}>
									<span class="text-neutral-400 text-sm">loading...</span>
								</Show>
								<Show when={!certificate.loading}>
									<Show
										when={certificateList().length > 0}
										fallback={<span class="text-neutral-400 text-sm">n/a</span>}
									>
										<div class="space-y-2">
											<For each={certificateList().slice(0, 2)}>
												{(cert) => (
													<div class="flex items-center justify-between">
														<div class="flex items-center gap-2">
															<span
																class={`w-2 h-2 ${certificateDotClass(cert.status)}`}
															></span>
															<span class="text-neutral-600 text-xs">
																{cert.domain}
															</span>
														</div>
														<span class="text-xs text-neutral-500">
															{certificateStatusLabel(cert.status)}
														</span>
													</div>
												)}
											</For>
											<Show when={certificateList().length > 2}>
												<span class="text-xs text-neutral-400">
													+{certificateList().length - 2} more
												</span>
											</Show>
										</div>
									</Show>
								</Show>
							</div>
						</div>

						<Show when={projectServices().length > 0}>
							<div class="border border-neutral-200 mb-8">
								<div class="border-b border-neutral-200 px-5 py-4 flex flex-wrap items-start justify-between gap-4">
									<div>
										<h2 class="text-sm font-serif text-black">services</h2>
										<p class="mt-1 text-xs text-neutral-500">
											{projectServices().length} configured service
											{projectServices().length === 1 ? "" : "s"} with{" "}
											{projectServices().reduce(
												(total, service) => total + service.replicas,
												0,
											)}{" "}
											total desired slots
										</p>
									</div>
									<div class="flex flex-wrap gap-2 text-xs text-neutral-500">
										<span class="border border-neutral-200 px-2 py-1">
											web {serviceTypeCounts().web}
										</span>
										<span class="border border-neutral-200 px-2 py-1">
											private {serviceTypeCounts().private}
										</span>
										<span class="border border-neutral-200 px-2 py-1">
											workers {serviceTypeCounts().workers}
										</span>
										<span class="border border-neutral-200 px-2 py-1">
											cron {serviceTypeCounts().cron}
										</span>
										<span class="border border-neutral-200 px-2 py-1">
											with mounts{" "}
											{
												projectServices().filter(
													(service) => service.mounts.length > 0,
												).length
											}
										</span>
									</div>
								</div>

								<div class="border-b border-neutral-200 px-5 py-3 overflow-x-auto">
									<div class="flex gap-2 min-w-max">
										<For each={projectServices()}>
											{(service) => (
												<button
													type="button"
													onClick={() => setSelectedServiceId(service.id)}
													class={`border px-3 py-2 text-left min-w-[220px] transition-colors ${
														selectedProjectService()?.id === service.id
															? "border-black bg-black text-white"
															: "border-neutral-200 text-black hover:border-neutral-400"
													}`}
												>
													<div class="flex items-center justify-between gap-3">
														<span class="text-sm font-medium">
															{service.name}
														</span>
														<span
															class={`text-[10px] uppercase tracking-wide ${
																selectedProjectService()?.id === service.id
																	? "text-neutral-200"
																	: "text-neutral-500"
															}`}
														>
															{serviceTypeLabel(service.service_type)}
														</span>
													</div>
													<div
														class={`mt-2 flex items-center gap-2 text-[11px] ${
															selectedProjectService()?.id === service.id
																? "text-neutral-200"
																: "text-neutral-500"
														}`}
													>
														<span
															class={`h-2 w-2 ${runtimeStatusDotClass(
																serviceRuntime(service.id)?.status || "pending",
															)}`}
														></span>
														<span>
															{serviceRuntime(service.id)?.status || "pending"}
														</span>
														<span>
															{serviceRuntime(service.id)
																? `${serviceRuntime(service.id)!.running_instances}/${serviceRuntime(service.id)!.desired_instances}`
																: "0/0"}
														</span>
													</div>
													<div
														class={`mt-2 flex items-center justify-between text-xs ${
															selectedProjectService()?.id === service.id
																? "text-neutral-200"
																: "text-neutral-500"
														}`}
													>
														<span>{formatServicePorts(service)}</span>
														<span>
															{service.replicas}x
															{service.domains?.length
																? ` · ${service.domains.length}d`
																: ""}
														</span>
													</div>
												</button>
											)}
										</For>
									</div>
								</div>

								<Show when={selectedProjectService()}>
									{(service) => (
										<div class="px-5 py-5 space-y-4">
											<div class="grid lg:grid-cols-[1.6fr_1fr] gap-4">
												<div class="border border-neutral-200 bg-neutral-50 p-4">
													<div class="flex flex-wrap items-start justify-between gap-4">
														<div>
															<div class="flex items-center gap-3">
																<h3 class="text-xl font-serif text-black">
																	{service().name}
																</h3>
																<span class="border border-neutral-300 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
																	{serviceTypeLabel(service().service_type)}
																</span>
																<span class="inline-flex items-center gap-2 border border-neutral-300 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
																	<span
																		class={`h-2 w-2 ${runtimeStatusDotClass(
																			serviceRuntime(service().id)?.status ||
																				"pending",
																		)}`}
																	></span>
																	{serviceRuntime(service().id)?.status ||
																		"pending"}
																</span>
															</div>
															<p class="mt-2 text-sm text-neutral-500 font-mono">
																{service().image || "built from repository"}
															</p>
														</div>
														<div class="text-xs text-neutral-500 space-y-1">
															<p>restart {service().restart_policy}</p>
															<p>health {formatServiceHealth(service())}</p>
														</div>
													</div>
												</div>

												<div class="grid grid-cols-2 gap-3">
													<div class="border border-neutral-200 p-3">
														<p class="text-[10px] uppercase tracking-wide text-neutral-400">
															status
														</p>
														<p class="mt-2 text-sm font-mono text-black">
															{serviceRuntime(service().id)?.status ||
																"pending"}
														</p>
													</div>
													<div class="border border-neutral-200 p-3">
														<p class="text-[10px] uppercase tracking-wide text-neutral-400">
															instances
														</p>
														<p class="mt-2 text-sm font-mono text-black">
															{serviceRuntime(service().id)
																? `${serviceRuntime(service().id)!.running_instances}/${serviceRuntime(service().id)!.desired_instances}`
																: "0/0"}
														</p>
													</div>
													<div class="border border-neutral-200 p-3">
														<p class="text-[10px] uppercase tracking-wide text-neutral-400">
															listen
														</p>
														<p class="mt-2 text-sm font-mono text-black">
															{formatServicePorts(service())}
														</p>
													</div>
													<div class="border border-neutral-200 p-3">
														<p class="text-[10px] uppercase tracking-wide text-neutral-400">
															replicas
														</p>
														<p class="mt-2 text-sm font-mono text-black">
															{service().replicas}
														</p>
													</div>
													<div class="border border-neutral-200 p-3">
														<p class="text-[10px] uppercase tracking-wide text-neutral-400">
															memory
														</p>
														<p class="mt-2 text-sm font-mono text-black">
															{service().memory_limit_mb
																? `${service().memory_limit_mb}mb`
																: "auto"}
														</p>
													</div>
													<div class="border border-neutral-200 p-3">
														<p class="text-[10px] uppercase tracking-wide text-neutral-400">
															cpu
														</p>
														<p class="mt-2 text-sm font-mono text-black">
															{service().cpu_limit
																? `${service().cpu_limit}`
																: "auto"}
														</p>
													</div>
												</div>
											</div>

											<div class="grid lg:grid-cols-3 gap-4">
												<section class="border border-neutral-200 p-4">
													<h4 class="text-xs uppercase tracking-wide text-neutral-400">
														network
													</h4>
													<div class="mt-4 space-y-3 text-sm text-neutral-600">
														<div>
															<p class="text-[10px] uppercase tracking-wide text-neutral-400">
																public routing
															</p>
															<p class="mt-1">
																{service().service_type === "web_service"
																	? "enabled"
																	: "disabled"}
															</p>
														</div>
														<div>
															<p class="text-[10px] uppercase tracking-wide text-neutral-400">
																default route
															</p>
															<p class="mt-1">
																{formatPublicUrlStatus(service())}
															</p>
														</div>
														<div>
															<p class="text-[10px] uppercase tracking-wide text-neutral-400">
																custom domains
															</p>
															<Show
																when={service().domains.length > 0}
																fallback={<p class="mt-1">none</p>}
															>
																<div class="mt-2 space-y-2">
																	<For each={service().domains}>
																		{(domain) => {
																			const cert = certificateList().find(
																				(entry) => entry.domain === domain,
																			);
																			const status = cert?.status || "none";
																			return (
																				<div class="flex items-center justify-between gap-2 border border-neutral-200 bg-white px-2 py-2 text-xs">
																					<div class="flex items-center gap-2 overflow-hidden">
																						<span
																							class={`h-2 w-2 ${certificateDotClass(status)}`}
																						></span>
																						<a
																							href={`https://${domain}`}
																							target="_blank"
																							class="truncate font-mono text-black hover:underline"
																						>
																							{domain}
																						</a>
																					</div>
																					<div class="flex items-center gap-2 text-neutral-500">
																						<span>
																							{certificateStatusLabel(status)}
																						</span>
																						<Show when={status !== "pending"}>
																							<button
																								type="button"
																								onClick={() =>
																									reissueCertificate(domain)
																								}
																								disabled={reissuing()}
																								class="border border-neutral-300 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-600 hover:border-black hover:text-black disabled:opacity-50"
																							>
																								{reissuing()
																									? "..."
																									: "reissue"}
																							</button>
																						</Show>
																					</div>
																				</div>
																			);
																		}}
																	</For>
																</div>
															</Show>
														</div>
														<div>
															<p class="text-[10px] uppercase tracking-wide text-neutral-400">
																ports
															</p>
															<p class="mt-1 font-mono text-black">
																{formatServicePorts(service())}
															</p>
														</div>
														<div>
															<p class="text-[10px] uppercase tracking-wide text-neutral-400">
																depends on
															</p>
															<p class="mt-1">
																{service().depends_on.length > 0
																	? service().depends_on.join(", ")
																	: "none"}
															</p>
														</div>
													</div>
												</section>

												<section class="border border-neutral-200 p-4">
													<h4 class="text-xs uppercase tracking-wide text-neutral-400">
														runtime
													</h4>
													<div class="mt-4 space-y-3 text-sm text-neutral-600">
														<div>
															<p class="text-[10px] uppercase tracking-wide text-neutral-400">
																health check
															</p>
															<p class="mt-1">
																{formatServiceHealthDetail(service())}
															</p>
														</div>
														<div>
															<p class="text-[10px] uppercase tracking-wide text-neutral-400">
																working dir
															</p>
															<p class="mt-1 font-mono text-black">
																{service().working_dir || "default"}
															</p>
														</div>
														<div>
															<p class="text-[10px] uppercase tracking-wide text-neutral-400">
																registry
															</p>
															<p class="mt-1">
																{formatServiceRegistry(service())}
															</p>
														</div>
														<Show
															when={
																service().entrypoint.length > 0 ||
																service().command.length > 0
															}
														>
															<div class="space-y-2 text-xs text-neutral-500 font-mono">
																<Show when={service().entrypoint.length > 0}>
																	<p>
																		entrypoint {service().entrypoint.join(" ")}
																	</p>
																</Show>
																<Show when={service().command.length > 0}>
																	<p>cmd {service().command.join(" ")}</p>
																</Show>
															</div>
														</Show>
													</div>
												</section>

												<section class="border border-neutral-200 p-4">
													<h4 class="text-xs uppercase tracking-wide text-neutral-400">
														storage
													</h4>
													<Show
														when={service().mounts.length > 0}
														fallback={
															<p class="mt-4 text-sm text-neutral-500">
																no persistent mounts configured
															</p>
														}
													>
														<div class="mt-4 space-y-3">
															<div class="flex flex-wrap gap-2 text-xs">
																<For each={service().mounts}>
																	{(mount) => (
																		<span class="border border-neutral-200 px-2 py-1 text-neutral-600 font-mono">
																			{mount.name}:{mount.target}
																			{mount.read_only ? ":ro" : ""}
																		</span>
																	)}
																</For>
															</div>
															<div class="flex flex-wrap items-center gap-2 text-xs">
																<button
																	onClick={() =>
																		void downloadServiceMounts(service().name)
																	}
																	disabled={
																		serviceMountAction()?.service ===
																		service().name
																	}
																	class="border border-neutral-300 px-2 py-1 text-neutral-700 hover:border-neutral-400 disabled:opacity-50"
																>
																	{serviceMountAction()?.service ===
																		service().name &&
																	serviceMountAction()?.kind === "backup"
																		? "backing up..."
																		: "backup mounts"}
																</button>
																<label
																	class={`border px-2 py-1 ${
																		serviceMountAction()?.service ===
																		service().name
																			? "border-neutral-200 text-neutral-300 cursor-not-allowed"
																			: "border-neutral-300 text-neutral-700 hover:border-neutral-400 cursor-pointer"
																	}`}
																>
																	{serviceMountAction()?.service ===
																		service().name &&
																	serviceMountAction()?.kind === "restore"
																		? "restoring..."
																		: "restore mounts"}
																	<input
																		type="file"
																		accept=".tar,application/x-tar"
																		class="hidden"
																		disabled={
																			serviceMountAction()?.service ===
																			service().name
																		}
																		onChange={(event) => {
																			const input = event.currentTarget;
																			void restoreServiceMounts(
																				service().name,
																				input.files,
																			).finally(() => {
																				input.value = "";
																			});
																		}}
																	/>
																</label>
															</div>
															<Show
																when={
																	serviceMountActionError()?.service ===
																	service().name
																}
															>
																<p class="text-xs text-neutral-500">
																	{serviceMountActionError()?.message}
																</p>
															</Show>
														</div>
													</Show>
												</section>
											</div>
										</div>
									)}
								</Show>
							</div>
						</Show>

						{/* logs panel */}
						<Show when={showLogs()}>
							<div class="border border-neutral-200 mb-8">
								<div class="border-b border-neutral-200 px-5 py-3 flex justify-between items-center">
									<div class="flex items-center gap-3">
										<h2 class="text-sm font-serif text-black">
											container logs
										</h2>
										<div class="flex items-center gap-2">
											<span
												class={`w-1.5 h-1.5 ${logsConnected() ? "bg-black" : "bg-neutral-300"}`}
											></span>
											<span class="text-xs text-neutral-500">
												{logsConnected() ? "live" : "disconnected"}
											</span>
										</div>
									</div>
									<button
										onClick={() => setLogs([])}
										class="text-xs text-neutral-500 hover:text-black"
									>
										clear
									</button>
								</div>
								<div
									ref={logsRef}
									class="p-4 h-72 overflow-y-auto font-mono text-xs bg-neutral-50"
								>
									<Show when={logs().length === 0}>
										<p class="text-neutral-400">
											{logsConnected()
												? "waiting for logs..."
												: "connecting..."}
										</p>
									</Show>
									<For each={logs()}>
										{(line) => (
											<div
												class="text-neutral-700 leading-relaxed whitespace-pre-wrap break-all"
												innerHTML={parseAnsi(line)}
											></div>
										)}
									</For>
								</div>
							</div>
						</Show>

						{/* container monitor */}
						<div class="border border-neutral-200 mb-8">
							<div class="border-b border-neutral-200 px-5 py-3 flex items-center justify-between">
								<div>
									<h2 class="text-sm font-serif text-black">
										container monitor
									</h2>
									<p class="text-xs text-neutral-500 mt-1">
										health, metrics, logs, volumes
									</p>
								</div>
								<Show when={appContainers().length > 0}>
									<select
										value={selectedContainer()}
										onChange={(e) =>
											setSelectedContainer(e.currentTarget.value)
										}
										class="px-2 py-1.5 border border-neutral-300 text-xs text-neutral-700"
									>
										<For each={appContainers()}>
											{(container) => (
												<option value={container.id}>{container.name}</option>
											)}
										</For>
									</select>
								</Show>
							</div>
							<div class="p-5">
								<Show when={appContainers().length > 0}>
									<ContainerMonitor containerId={selectedContainer()} />
								</Show>
								<Show when={appContainers().length === 0}>
									<div class="border border-dashed border-neutral-200 p-8 text-center text-neutral-400 text-sm">
										no running containers for this group
									</div>
								</Show>
							</div>
						</div>

						{/* deployments */}
						<div class="border border-neutral-200">
							<div class="border-b border-neutral-200 px-5 py-3">
								<h2 class="text-sm font-serif text-black">deployments</h2>
							</div>

							<Show when={deployments.loading}>
								<div class="p-5 animate-pulse space-y-3">
									<div class="h-10 bg-neutral-50"></div>
									<div class="h-10 bg-neutral-50"></div>
								</div>
							</Show>

							<Show when={!deployments.loading && deployments()?.length === 0}>
								<div class="p-8 text-center text-neutral-400 text-sm">
									no deployments yet
								</div>
							</Show>

							<Show
								when={
									!deployments.loading &&
									deployments() &&
									deployments()!.length > 0
								}
							>
								<div class="divide-y divide-neutral-200">
									<For each={deployments()}>
										{(deployment) => (
											<div class="px-5 py-4 flex items-center justify-between">
												<div class="flex items-center gap-4">
													<span
														class={`w-2 h-2 ${statusIndicator(deployment.status)}`}
													></span>
													<div>
														<p class="text-black font-mono text-sm">
															{deployment.commit_sha.substring(0, 8)}
														</p>
														<p class="text-neutral-500 text-xs mt-0.5 truncate max-w-md">
															{deployment.commit_message || "no message"}
														</p>
													</div>
												</div>
												<div class="flex items-center gap-4 text-xs">
													<span class="text-neutral-500">
														{deployment.status}
													</span>
													<span class="text-neutral-400">
														{new Date(deployment.created_at).toLocaleString()}
													</span>
													<button
														onClick={() => openDeploymentLogs(deployment)}
														class="px-2 py-1 border border-neutral-300 text-neutral-600 hover:text-black hover:border-neutral-400 transition-colors"
													>
														logs
													</button>
												</div>
											</div>
										)}
									</For>
								</div>
							</Show>
						</div>
					</div>
				</Show>
				{/* edit modal */}
				<Show when={editing()}>
					<div class="fixed inset-0 bg-white/90 flex items-center justify-center z-50">
						<div class="bg-white border border-neutral-300 w-full max-w-6xl max-h-[90vh] flex flex-col">
							<div class="border-b border-neutral-200 px-6 py-4 flex justify-between items-center">
								<h2 class="text-lg font-serif text-black">group settings</h2>
								<button
									onClick={() => setEditing(false)}
									class="text-neutral-400 hover:text-black"
								>
									<svg
										class="h-5 w-5"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M6 18L18 6M6 6l12 12"
										/>
									</svg>
								</button>
							</div>

							<div class="flex-1 overflow-y-auto p-6 space-y-6">
								{/* source settings */}
								<section class="border border-neutral-200 p-4">
									<h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-4">
										source
									</h3>

									<div class="grid grid-cols-2 gap-4">
										<div>
											<label class="block text-xs text-neutral-500 mb-2">
												repository url
											</label>
											<input
												type="text"
												value={editForm().github_url}
												onInput={(e) =>
													setEditForm((prev) => ({
														...prev,
														github_url: e.currentTarget.value,
													}))
												}
												class="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 text-white focus:border-neutral-400 focus:outline-none text-sm font-mono"
											/>
										</div>
										<div>
											<label class="block text-xs text-neutral-500 mb-2">
												branch
											</label>
											<input
												type="text"
												value={editForm().branch}
												onInput={(e) =>
													setEditForm((prev) => ({
														...prev,
														branch: e.currentTarget.value,
													}))
												}
												class="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 text-white focus:border-neutral-400 focus:outline-none text-sm font-mono"
											/>
										</div>
									</div>
								</section>

								<EnvVarEditor
									envVars={editForm().env_vars}
									theme="dark"
									onChange={(envVars) =>
										setEditForm((previous) => ({
											...previous,
											env_vars: envVars,
										}))
									}
								/>

								<section class="border border-neutral-200 p-4">
									<div class="flex justify-between items-center mb-4">
										<div>
											<h3 class="text-xs text-neutral-500 uppercase tracking-wider">
												services
											</h3>
											<p class="text-xs text-neutral-400 mt-2">
												define render-style service types for this group. custom
												domains now belong to each web service card.
											</p>
										</div>
										<div class="flex flex-wrap gap-2">
											<For each={serviceTypeOptions}>
												{(serviceType) => (
													<button
														type="button"
														onClick={() => addEditService(serviceType)}
														class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
													>
														add {serviceTypeLabel(serviceType)}
													</button>
												)}
											</For>
										</div>
									</div>

									<div class="mb-4 grid gap-3 md:grid-cols-3">
										<For each={serviceTypeOptions}>
											{(serviceType) => (
												<div class="border border-neutral-200 bg-neutral-50 px-3 py-3">
													<p class="text-xs uppercase tracking-wide text-neutral-500">
														{serviceTypeLabel(serviceType)}
													</p>
													<p class="mt-2 text-xs leading-relaxed text-neutral-500">
														{serviceType === "web_service"
															? "public url, http routing, and optional custom domains"
															: serviceType === "private_service"
																? "internal-only service that other group services can reach"
																: "no inbound port, built for queues, cron jobs, and workers"}
													</p>
												</div>
											)}
										</For>
									</div>

									<For each={editForm().services}>
										{(service, index) => (
											<ServiceForm
												service={service}
												index={index()}
												allServices={editForm().services}
												onUpdate={updateEditService}
												onRemove={removeEditService}
											/>
										)}
									</For>

									<Show when={editForm().services.length === 0}>
										<div class="text-center py-8 text-neutral-400 text-sm border border-dashed border-neutral-200">
											no services configured
										</div>
									</Show>
								</section>
							</div>

							<Show when={editError()}>
								<div class="border-t border-neutral-200 px-6 py-4">
									<div class="border border-neutral-300 bg-neutral-50 text-neutral-700 px-4 py-2 text-sm">
										{editError()}
									</div>
								</div>
							</Show>
							<div class="border-t border-neutral-200 px-6 py-4 flex gap-2">
								<button
									onClick={() => setEditing(false)}
									class="flex-1 px-4 py-2 border border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400 transition-colors text-sm"
								>
									cancel
								</button>
								<button
									onClick={updateApp}
									disabled={saving()}
									class="flex-1 px-4 py-2 bg-black text-white hover:bg-neutral-800 disabled:opacity-50 transition-colors text-sm"
								>
									{saving() ? "saving..." : "save changes"}
								</button>
							</div>
						</div>
					</div>
				</Show>

				{/* deployment logs modal */}
				<Show when={selectedDeployment()}>
					<div class="fixed inset-0 bg-white/90 flex items-center justify-center z-50">
						<div class="bg-white border border-neutral-300 w-full max-w-4xl max-h-[90vh] flex flex-col">
							<div class="border-b border-neutral-200 px-6 py-4 flex justify-between items-center">
								<div>
									<h2 class="text-lg font-serif text-black">deployment logs</h2>
									<p class="text-xs text-neutral-500 mt-1 font-mono">
										{selectedDeployment()!.commit_sha.substring(0, 8)} -{" "}
										{selectedDeployment()!.status}
									</p>
								</div>
								<div class="flex items-center gap-4">
									<Show when={deploymentLogsConnected()}>
										<div class="flex items-center gap-2">
											<span class="w-1.5 h-1.5 bg-black"></span>
											<span class="text-xs text-neutral-500">live</span>
										</div>
									</Show>
									<button
										onClick={closeDeploymentLogs}
										class="text-neutral-400 hover:text-black"
									>
										<svg
											class="h-5 w-5"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M6 18L18 6M6 6l12 12"
											/>
										</svg>
									</button>
								</div>
							</div>
							<div
								ref={deploymentLogsRef}
								class="flex-1 p-4 overflow-y-auto font-mono text-xs bg-neutral-50 min-h-[300px] max-h-[60vh]"
							>
								<Show
									when={
										deploymentLogsLoading() && deploymentLogs().length === 0
									}
								>
									<p class="text-neutral-400">loading logs...</p>
								</Show>
								<Show
									when={
										!deploymentLogsLoading() && deploymentLogs().length === 0
									}
								>
									<p class="text-neutral-400">no logs available</p>
								</Show>
								<Show
									when={
										!deploymentLogsConnected() &&
										deploymentLogHasMore() &&
										deploymentLogs().length > 0
									}
								>
									<div class="mb-4 text-center">
										<button
											onClick={loadMoreLogs}
											disabled={deploymentLogsLoading()}
											class="text-xs text-neutral-500 hover:text-black border border-neutral-200 px-3 py-1 bg-white hover:border-neutral-400 transition-colors disabled:opacity-50"
										>
											{deploymentLogsLoading()
												? "loading..."
												: "load older logs"}
										</button>
									</div>
								</Show>
								<For each={deploymentLogs()}>
									{(line) => (
										<div
											class="text-neutral-700 leading-relaxed whitespace-pre-wrap break-all"
											innerHTML={parseAnsi(line)}
										></div>
									)}
								</For>
							</div>
							<div class="border-t border-neutral-200 px-6 py-3 flex justify-between items-center text-xs text-neutral-500">
								<div>
									<span>
										started:{" "}
										{new Date(
											selectedDeployment()!.created_at,
										).toLocaleString()}
									</span>
									<Show when={selectedDeployment()!.finished_at}>
										<span class="mx-2">|</span>
										<span>
											finished:{" "}
											{new Date(
												selectedDeployment()!.finished_at!,
											).toLocaleString()}
										</span>
									</Show>
								</div>
								<button
									onClick={() => setDeploymentLogs([])}
									class="text-neutral-500 hover:text-black"
								>
									clear
								</button>
							</div>
						</div>
					</div>
				</Show>
			</div>
		</ErrorBoundary>
	);
};

export default AppDetail;
