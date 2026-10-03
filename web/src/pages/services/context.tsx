import { type Accessor, createContext, type Resource, useContext } from "solid-js";
import type { ServiceInput } from "../../api/platform";
import type { Service, ServiceSettings, UpdateServiceBody } from "../../api/services";

export type ServiceContextValue = {
	id: Accessor<string>;
	service: Resource<Service>;
	settings: Resource<ServiceSettings | null>;
	isApp: Accessor<boolean>;
	refetch: () => Promise<void>;
	/** saves a partial update to the app service and refreshes local state */
	save: (body: UpdateServiceBody | Record<string, unknown>, message?: string) => Promise<boolean>;
	/** builds a full service request from current settings plus overrides */
	serviceRequest: (patch?: Partial<ServiceInput>) => ServiceInput | null;
};

export const ServiceContext = createContext<ServiceContextValue>();

export const useService = () => {
	const value = useContext(ServiceContext);
	if (!value) throw new Error("useService must be used inside a service page");
	return value;
};

type SettingsService = ServiceSettings["service"];

/** converts the settings response shape back into a request shape */
export const toServiceInput = (
	current: SettingsService,
	patch: Partial<ServiceInput> = {},
): ServiceInput => {
	const extra = current as SettingsService & {
		notes?: string | null;
		basic_auth?: { username: string } | null;
		port_mappings?: ServiceInput["port_mappings"];
	};
	const base: ServiceInput = {
		name: current.name,
		image: current.image ?? null,
		service_type: current.service_type as ServiceInput["service_type"],
		port: current.port,
		expose_http: current.expose_http,
		domains: current.domains,
		http_only_domains: current.http_only_domains,
		additional_ports: current.additional_ports,
		replicas: current.replicas,
		memory_limit_mb: current.memory_limit_mb ?? null,
		cpu_limit: current.cpu_limit ?? null,
		depends_on: current.depends_on,
		health_check: current.health_check
			? {
					path: current.health_check.path,
					interval_secs: current.health_check.interval_secs,
					timeout_secs: current.health_check.timeout_secs,
					retries: current.health_check.retries,
				}
			: null,
		restart_policy: current.restart_policy as ServiceInput["restart_policy"],
		registry_auth: current.registry_auth
			? {
					server: current.registry_auth.server ?? null,
					username: current.registry_auth.username,
					password: current.registry_auth.password,
				}
			: null,
		env_vars: current.env_vars.map((env) => ({
			key: env.key,
			value: env.value,
			secret: env.secret,
		})),
		build_context: current.build_context ?? null,
		dockerfile_path: current.dockerfile_path ?? null,
		build_target: current.build_target ?? null,
		build_args: current.build_args.map((arg) => ({
			key: arg.key,
			value: arg.value,
			secret: arg.secret,
		})),
		command: current.command ?? null,
		entrypoint: current.entrypoint ?? null,
		working_dir: current.working_dir ?? null,
		schedule: current.schedule ?? null,
		mounts: current.mounts.map((mount) => ({ ...mount })),
	};
	// only forward the newer fields when the server knows about them, so an
	// older api never sees unexpected keys
	if ("notes" in extra) base.notes = extra.notes ?? null;
	if ("port_mappings" in extra) base.port_mappings = extra.port_mappings ?? [];
	if ("basic_auth" in extra && extra.basic_auth)
		base.basic_auth = { username: extra.basic_auth.username };
	return { ...base, ...patch };
};
