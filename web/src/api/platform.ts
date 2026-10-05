import { download, request } from "./http";
import type { Service, ServiceDeployment } from "./services";

// ---- metrics -------------------------------------------------------------

export type ContainerMetrics = {
	container_id: string;
	name: string;
	cpu_percent: number;
	memory_used_bytes: number;
	memory_limit_bytes: number;
	network_rx_bytes: number;
	network_tx_bytes: number;
	block_read_bytes: number;
	block_write_bytes: number;
	pids: number;
};

export type ServiceMetrics = {
	containers: ContainerMetrics[];
	collected_at: string;
};

export const getServiceMetrics = (id: string) =>
	request<ServiceMetrics>("GET", `/api/services/${encodeURIComponent(id)}/metrics`);

export type HostStats = {
	cpu_percent: number;
	memory_used_bytes: number;
	memory_total_bytes: number;
	network_rx_bytes: number;
	network_tx_bytes: number;
	load_avg: [number, number, number];
	uptime_seconds: number;
	disk_used_bytes?: number;
	disk_total_bytes?: number;
	cpu_count?: number;
};

export const getHostStats = () => request<HostStats>("GET", "/api/system/stats");

export type SystemInfo = {
	version: string;
	hostname: string;
	os: string;
	kernel: string;
	docker_version: string;
	containers_running: number;
	containers_total: number;
	images: number;
	base_domain: string;
	public_ip: string | null;
};

export const getSystemInfo = () => request<SystemInfo>("GET", "/api/system/info");

// ---- maintenance ---------------------------------------------------------

export type DiskUsageBucket = {
	count: number;
	size_bytes: number;
	reclaimable_bytes: number;
};

export type DiskUsage = {
	images: DiskUsageBucket;
	containers: DiskUsageBucket;
	volumes: DiskUsageBucket;
	build_cache: DiskUsageBucket;
};

export const getDiskUsage = () => request<DiskUsage>("GET", "/api/system/disk-usage");

export type CleanupOptions = { images: boolean; build_cache: boolean; containers: boolean };
export type CleanupResult = { reclaimed_bytes: number; images_deleted: number };

export const runCleanup = (options: CleanupOptions) =>
	request<CleanupResult>("POST", "/api/system/cleanup", options);

export const downloadBackup = () =>
	download("/api/system/backup", `containr-backup-${new Date().toISOString()}.sqlite3`);

// ---- accounts ------------------------------------------------------------

export const changePassword = (current_password: string, new_password: string) =>
	request<void>("POST", "/api/auth/password", { current_password, new_password });

export const deleteUser = (id: string) =>
	request<void>("DELETE", `/api/admin/users/${encodeURIComponent(id)}`);

// ---- registries ----------------------------------------------------------

export type Registry = {
	id: string;
	server: string;
	username: string;
	created_at: string;
};

export const listRegistries = () => request<Registry[]>("GET", "/api/registries");

export const createRegistry = (server: string, username: string, password: string) =>
	request<Registry>("POST", "/api/registries", { server, username, password });

export const deleteRegistry = (id: string) =>
	request<void>("DELETE", `/api/registries/${encodeURIComponent(id)}`);

// ---- deploy methods ------------------------------------------------------

export const deployTarball = (id: string, file: File) => {
	const form = new FormData();
	form.append("file", file, file.name);
	return request<ServiceDeployment>(
		"POST",
		`/api/services/${encodeURIComponent(id)}/deploy/upload`,
		form,
	);
};

export const deployDockerfile = (id: string, dockerfile: string) =>
	request<ServiceDeployment>("POST", `/api/services/${encodeURIComponent(id)}/deploy/dockerfile`, {
		dockerfile,
	});

/** real value of a secret variable; settings responses only carry a mask */
export const revealEnvVar = (id: string, key: string, scope: "service" | "shared" = "service") =>
	request<{ key: string; value: string }>(
		"POST",
		`/api/services/${encodeURIComponent(id)}/env/reveal`,
		{ key, scope },
	);

/** a short-lived pass for a service behind the containr login */
export const createGatePass = (host: string, returnTo: string) =>
	request<{ redirect_url: string }>("POST", "/api/gate/pass", { host, return_to: returnTo });

export const moveService = (id: string, groupId: string | null) =>
	request<Service>("POST", `/api/services/${encodeURIComponent(id)}/move`, {
		group_id: groupId,
	});

// ---- service create shapes ----------------------------------------------

export type EnvVarInput = { key: string; value: string; secret?: boolean };

export type MountInput = {
	name: string;
	target: string;
	read_only?: boolean | null;
	host_path?: string | null;
};

export type PortMapping = {
	host_port: number;
	container_port: number;
	protocol?: "tcp" | "udp";
};

export type ServiceInput = {
	name: string;
	image?: string | null;
	service_type?: "web_service" | "private_service" | "background_worker" | "cron_job";
	port: number;
	expose_http?: boolean;
	domains?: string[];
	http_only_domains?: string[];
	additional_ports?: number[];
	replicas?: number;
	memory_limit_mb?: number | null;
	cpu_limit?: number | null;
	depends_on?: string[];
	health_check?: {
		path: string;
		interval_secs?: number;
		timeout_secs?: number;
		retries?: number;
	} | null;
	restart_policy?: "never" | "always" | "on-failure" | "unless-stopped";
	registry_auth?: { server?: string | null; username?: string; password?: string } | null;
	env_vars?: EnvVarInput[];
	build_context?: string | null;
	dockerfile_path?: string | null;
	build_target?: string | null;
	build_args?: EnvVarInput[];
	command?: string[] | null;
	entrypoint?: string[] | null;
	working_dir?: string | null;
	schedule?: string | null;
	mounts?: MountInput[];
	notes?: string | null;
	basic_auth?: { username: string; password?: string } | null;
	/** require a containr login before the proxy forwards to the service */
	login_gate?: { scope: "owner" | "all_users" } | null;
	port_mappings?: PortMapping[];
};

export type CreateRequest =
	| {
			source: "git_repository";
			name: string;
			github_url: string;
			branch?: string;
			env_vars?: EnvVarInput[];
			service: ServiceInput;
			rollout_strategy?: "stop_first" | "start_first";
			group_id?: string;
			/** false creates the service without deploying it yet */
			deploy?: boolean;
	  }
	| {
			source: "template";
			name: string;
			template: string;
			version?: string;
			memory_limit_mb?: number;
			cpu_limit?: number;
			group_id?: string;
	  }
	| {
			source: "stack";
			name: string;
			env_vars?: EnvVarInput[];
			services: ServiceInput[];
			group_id?: string;
	  };

export const createServiceRequest = (body: CreateRequest) =>
	request<Service>("POST", "/api/services", body);

// ---- projects ------------------------------------------------------------

export type Project = {
	id: string;
	name: string;
	network_name: string;
	service_count: number;
	managed_count: number;
	created_at: string;
	updated_at: string;
};

export const listProjects = () => request<Project[]>("GET", "/api/projects");

export const renameProject = (id: string, name: string) =>
	request<Project>("PATCH", `/api/projects/${encodeURIComponent(id)}`, { name });

// ---- containers ----------------------------------------------------------

export type VolumeEntry = {
	name: string;
	path: string;
	is_dir: boolean;
	size_bytes: number;
	modified_at: string | null;
};

export type ContainerMount = {
	destination: string;
	mount_type: string;
	name: string | null;
	read_only: boolean;
};

const containerPath = (id: string, suffix: string) =>
	`/api/containers/${encodeURIComponent(id)}${suffix}`;

export const listContainerMounts = (id: string) =>
	request<ContainerMount[]>("GET", containerPath(id, "/mounts"));

const volumeQuery = (mount: string, path?: string) => {
	const params = new URLSearchParams({ mount });
	if (path) params.set("path", path);
	return params.toString();
};

export const listVolumeEntries = (id: string, mount: string, path?: string) =>
	request<VolumeEntry[]>("GET", `${containerPath(id, "/files")}?${volumeQuery(mount, path)}`);

export const deleteVolumeEntry = (id: string, mount: string, path: string) =>
	request<void>("DELETE", `${containerPath(id, "/files")}?${volumeQuery(mount, path)}`);

export const createVolumeDirectory = (id: string, mount: string, path: string) =>
	request<void>("POST", `${containerPath(id, "/files/mkdir")}?${volumeQuery(mount, path)}`);

export const uploadVolumeFile = (id: string, mount: string, dir: string, file: File) => {
	const form = new FormData();
	form.append("file", file, file.name);
	return request<void>(
		"POST",
		`${containerPath(id, "/files/upload")}?${volumeQuery(mount, dir || undefined)}`,
		form,
	);
};

export const downloadVolumeEntry = (id: string, mount: string, path: string, name: string) =>
	download(`${containerPath(id, "/files/download")}?${volumeQuery(mount, path)}`, name);

export const issueExecToken = (id: string) =>
	request<{ token: string; expires_at: string }>("POST", containerPath(id, "/exec/token"));

export const execSocketUrl = (
	id: string,
	token: string,
	shell: string,
	cols: number,
	rows: number,
) => {
	const scheme = window.location.protocol === "https:" ? "wss" : "ws";
	const params = new URLSearchParams({
		token,
		shell,
		cols: String(cols),
		rows: String(rows),
	});
	return `${scheme}://${window.location.host}${containerPath(id, "/exec/ws")}?${params}`;
};
