import { components } from "../api";
import { Service, createEmptyService } from "../components/ServiceForm";

export const secretMask = "********";

type ServiceResponse = components["schemas"]["ServiceResponse"];

export interface EditableEnvVar {
	key: string;
	value: string;
	secret: boolean;
}

export function createPrimaryService(): Service {
	const service = createEmptyService();
	service.name = "web";
	service.expose_http = true;
	return service;
}

export function ensureSinglePublicHttpService(services: Service[]): Service[] {
	if (services.length === 0) {
		return services;
	}

	let exposedIndex = services.findIndex((service) => service.expose_http);
	if (exposedIndex < 0) {
		exposedIndex = 0;
	}

	return services.map((service, index) => ({
		...service,
		expose_http: index === exposedIndex,
	}));
}

export function mapServiceResponseToForm(service: ServiceResponse): Service {
	return {
		name: service.name,
		image: service.image,
		port: service.port,
		expose_http: service.expose_http,
		additional_ports: [...service.additional_ports],
		replicas: service.replicas,
		memory_limit_mb: service.memory_limit_mb ?? null,
		cpu_limit: service.cpu_limit ?? null,
		depends_on: [...service.depends_on],
		health_check_path: service.health_check?.path ?? "",
		health_check_interval_secs: service.health_check?.interval_secs ?? 30,
		health_check_timeout_secs: service.health_check?.timeout_secs ?? 5,
		health_check_retries: service.health_check?.retries ?? 3,
		restart_policy: normalizeRestartPolicy(service.restart_policy),
		registry_auth: service.registry_auth
			? {
					server: service.registry_auth.server ?? "",
					username: service.registry_auth.username,
					password: secretMask,
				}
			: null,
		command: [...service.command],
		entrypoint: [...service.entrypoint],
		working_dir: service.working_dir ?? "",
		mounts: service.mounts.map((mount) => ({
			name: mount.name,
			target: mount.target,
			read_only: mount.read_only,
		})),
	};
}

export function mapServiceToRequest(service: Service) {
	const image = service.image.trim();
	const workingDir = service.working_dir.trim();
	const healthCheckPath = service.health_check_path.trim();
	const registryAuth =
		service.registry_auth &&
		(service.registry_auth.server.trim() ||
			service.registry_auth.username.trim() ||
			service.registry_auth.password.trim())
			? {
					server: service.registry_auth.server.trim() || null,
					username: service.registry_auth.username.trim() || null,
					password: service.registry_auth.password.trim() || null,
				}
			: null;

	return {
		name: service.name.trim(),
		image: image || null,
		port: service.port,
		expose_http: service.expose_http,
		additional_ports:
			service.additional_ports.length > 0 ? service.additional_ports : null,
		replicas: service.replicas,
		memory_limit_mb: service.memory_limit_mb,
		cpu_limit: service.cpu_limit,
		depends_on: service.depends_on.length > 0 ? service.depends_on : null,
		health_check: healthCheckPath
			? {
					path: healthCheckPath,
					interval_secs: service.health_check_interval_secs,
					timeout_secs: service.health_check_timeout_secs,
					retries: service.health_check_retries,
				}
			: null,
		restart_policy: normalizeRestartPolicy(service.restart_policy),
		registry_auth: registryAuth,
		command: service.command.length > 0 ? service.command : null,
		entrypoint: service.entrypoint.length > 0 ? service.entrypoint : null,
		working_dir: workingDir || null,
		mounts:
			service.mounts.length > 0
				? service.mounts.map((mount) => ({
						name: mount.name,
						target: mount.target,
						read_only: mount.read_only,
					}))
				: null,
	};
}

function normalizeRestartPolicy(value: string) {
	if (value === "onfailure") {
		return "on-failure";
	}

	return value;
}
