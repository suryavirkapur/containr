import {
	type Service,
} from "../components/ServiceForm";
import type { EditableKeyValueEntry } from "./keyValueEntries";

export const secretMask = "********";

export type EditableEnvVar = EditableKeyValueEntry;

export function mapServiceToRequest(service: Service) {
	const image = service.image.trim();
	const workingDir = service.working_dir.trim();
	const healthCheckPath = service.health_check_path.trim();
	const buildContext = service.build_context.trim();
	const dockerfilePath = service.dockerfile_path.trim();
	const buildTarget = service.build_target.trim();
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
		service_type: service.service_type,
		port: service.port,
		expose_http: service.expose_http,
		domains: service.domains.length > 0 ? service.domains : null,
		additional_ports: service.additional_ports.length > 0 ? service.additional_ports : null,
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
		env_vars: service.env_vars.length > 0 ? service.env_vars : null,
		build_context: buildContext || null,
		dockerfile_path: dockerfilePath || null,
		build_target: buildTarget || null,
		build_args: service.build_args.length > 0 ? service.build_args : null,
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
