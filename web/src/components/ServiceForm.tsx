import { Component, createMemo, createSignal, For, Show } from "solid-js";

import EnvVarEditor from "./EnvVarEditor";
import { Badge, Button, Card } from "./ui";
import { EditableKeyValueEntry } from "../utils/keyValueEntries";

export type ServiceType = "web_service" | "private_service" | "background_worker" | "cron_job";

export function normalizeServiceType(serviceType: string | null | undefined): ServiceType {
	switch (serviceType) {
		case "web_service":
		case "private_service":
		case "background_worker":
		case "cron_job":
			return serviceType;
		default:
			return "private_service";
	}
}

/**
 * service configuration for multi-container apps
 */
export interface Service {
	name: string;
	image: string;
	service_type: ServiceType;
	port: number;
	expose_http: boolean;
	domains: string[];
	additional_ports: number[];
	replicas: number;
	memory_limit_mb: number | null;
	cpu_limit: number | null;
	depends_on: string[];
	health_check_path: string;
	health_check_interval_secs: number;
	health_check_timeout_secs: number;
	health_check_retries: number;
	restart_policy: string;
	registry_auth: ServiceRegistryAuth | null;
	env_vars: EditableKeyValueEntry[];
	build_context: string;
	dockerfile_path: string;
	build_target: string;
	build_args: EditableKeyValueEntry[];
	command: string[];
	entrypoint: string[];
	working_dir: string;
	mounts: ServiceMount[];
}

export interface ServiceRegistryAuth {
	server: string;
	username: string;
	password: string;
}

export interface ServiceMount {
	name: string;
	target: string;
	read_only: boolean;
}

/**
 * creates an empty service with defaults
 */
export function createEmptyService(): Service {
	return {
		name: "",
		image: "",
		service_type: "private_service",
		port: 8080,
		expose_http: false,
		domains: [],
		additional_ports: [],
		replicas: 1,
		memory_limit_mb: null,
		cpu_limit: null,
		depends_on: [],
		health_check_path: "",
		health_check_interval_secs: 30,
		health_check_timeout_secs: 5,
		health_check_retries: 3,
		restart_policy: "always",
		registry_auth: null,
		env_vars: [],
		build_context: "",
		dockerfile_path: "",
		build_target: "",
		build_args: [],
		command: [],
		entrypoint: [],
		working_dir: "",
		mounts: [],
	};
}

export function serviceTypeLabel(serviceType: string | null | undefined) {
	switch (normalizeServiceType(serviceType)) {
		case "web_service":
			return "web service";
		case "private_service":
			return "private service";
		case "background_worker":
			return "background worker";
		case "cron_job":
			return "cron job";
	}
}

export function serviceTypeDescription(serviceType: string | null | undefined) {
	switch (normalizeServiceType(serviceType)) {
		case "web_service":
			return "public url, routed http traffic, and optional custom domains";
		case "private_service":
			return "internal-only service with a stable network address inside the group";
		case "background_worker":
			return "no inbound traffic, intended for queues, jobs, and long-running workers";
		case "cron_job":
			return "scheduled execution with no inbound traffic and a cron expression";
	}
}

export function applyServiceType(service: Service, serviceType: ServiceType): Service {
	const next: Service = {
		...service,
		service_type: serviceType,
		expose_http: serviceType === "web_service",
	};

	if (serviceType === "background_worker" || serviceType === "cron_job") {
		next.port = 0;
		next.health_check_path = "";
	} else if (next.port === 0) {
		next.port = 8080;
	}

	if (serviceType !== "web_service") {
		next.domains = [];
	}

	return next;
}

export function createServiceForType(serviceType: ServiceType): Service {
	return applyServiceType(createEmptyService(), serviceType);
}

interface ServiceFormProps {
	service: Service;
	index: number;
	allServices: Service[];
	onUpdate: (index: number, service: Service) => void;
	onRemove: (index: number) => void;
	allowRemove?: boolean;
	showServiceTypePicker?: boolean;
}

/**
 * form for configuring a single container service
 */
const ServiceForm: Component<ServiceFormProps> = (props) => {
	const [activeTab, setActiveTab] = createSignal<"overview" | "build" | "runtime" | "storage">(
		"overview",
	);

	const isRepositoryBuild = createMemo(() => props.service.image.trim().length === 0);
	const expectsInboundPort = createMemo(
		() =>
			props.service.service_type !== "background_worker" &&
			props.service.service_type !== "cron_job",
	);

	const argsToText = (value: string[]) => value.join("\n");

	const textToArgs = (value: string) =>
		value
			.split("\n")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);

	const portsToText = (value: number[]) => value.join("\n");

	const textToPorts = (value: string) =>
		value
			.split("\n")
			.map((entry) => parseInt(entry.trim(), 10))
			.filter((entry) => Number.isInteger(entry) && entry > 0 && entry <= 65535);

	const domainsToText = (value: string[]) => value.join("\n");

	const textToDomains = (value: string) =>
		Array.from(
			new Set(
				value
					.split(/[\n,]+/)
					.map((entry) => entry.trim().toLowerCase())
					.filter((entry) => entry.length > 0),
			),
		);

	const updateField = <K extends keyof Service>(field: K, value: Service[K]) => {
		props.onUpdate(props.index, { ...props.service, [field]: value });
	};

	const availableDependencies = () =>
		props.allServices
			.filter((_, i) => i !== props.index)
			.map((service) => service.name)
			.filter((name) => name.length > 0);

	const toggleDependency = (dep: string) => {
		const current = props.service.depends_on;
		const updated = current.includes(dep)
			? current.filter((item) => item !== dep)
			: [...current, dep];
		updateField("depends_on", updated);
	};

	const addMount = () => {
		updateField("mounts", [
			...props.service.mounts,
			{
				name: "",
				target: "",
				read_only: false,
			},
		]);
	};

	const updateMount = (mountIndex: number, field: keyof ServiceMount, value: string | boolean) => {
		const updated = [...props.service.mounts];
		updated[mountIndex] = {
			...updated[mountIndex],
			[field]: value,
		};
		updateField("mounts", updated);
	};

	const removeMount = (mountIndex: number) => {
		updateField(
			"mounts",
			props.service.mounts.filter((_, index) => index !== mountIndex),
		);
	};

	const enableRegistryAuth = () => {
		updateField("registry_auth", {
			server: "",
			username: "",
			password: "",
		});
	};

	const updateRegistryAuth = (field: keyof ServiceRegistryAuth, value: string) => {
		const current = props.service.registry_auth || {
			server: "",
			username: "",
			password: "",
		};
		updateField("registry_auth", {
			...current,
			[field]: value,
		});
	};

	const tabClass = (tab: "overview" | "build" | "runtime" | "storage") =>
		activeTab() === tab
			? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
			: "border-[var(--border)] bg-[var(--muted)] text-[var(--muted-foreground)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]";

	const modeLabel = () => (isRepositoryBuild() ? "repo build" : "prebuilt image");

	const selectServiceType = (serviceType: ServiceType) => {
		props.onUpdate(props.index, applyServiceType(props.service, serviceType));
	};

	return (
		<Card class="mb-4 overflow-hidden">
			<div class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] bg-[var(--muted)] px-4 py-4">
				<div>
					<div class="flex items-center gap-3">
						<span class="text-sm font-medium text-[var(--foreground)]">
							{props.service.name || `service ${props.index + 1}`}
						</span>
						<Badge variant="secondary">{serviceTypeLabel(props.service.service_type)}</Badge>
						<Badge variant="outline">{modeLabel()}</Badge>
					</div>
					<div class="mt-2 flex flex-wrap gap-2 text-xs text-[var(--muted-foreground)]">
						<span class="border border-[var(--border)] px-2 py-1 font-mono">
							{expectsInboundPort() ? `:${props.service.port}` : "no inbound port"}
						</span>
						<span class="border border-[var(--border)] px-2 py-1">
							{props.service.replicas} replica
							{props.service.replicas === 1 ? "" : "s"}
						</span>
						<span class="border border-[var(--border)] px-2 py-1">
							{props.service.env_vars.length} env
						</span>
						<Show when={props.service.domains.length > 0}>
							<span class="border border-[var(--border)] px-2 py-1">
								{props.service.domains.length} domain
								{props.service.domains.length === 1 ? "" : "s"}
							</span>
						</Show>
						<Show when={props.service.mounts.length > 0}>
							<span class="border border-[var(--border)] px-2 py-1">
								{props.service.mounts.length} mount
								{props.service.mounts.length === 1 ? "" : "s"}
							</span>
						</Show>
					</div>
				</div>
				<Show when={props.allowRemove !== false}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => props.onRemove(props.index)}
					>
						remove
					</Button>
				</Show>
			</div>

			<div class="border-b border-[var(--border)] px-4 py-3">
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						onClick={() => setActiveTab("overview")}
						class={`border px-3 py-1 text-xs transition-colors ${tabClass("overview")}`}
					>
						overview
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("build")}
						class={`border px-3 py-1 text-xs transition-colors ${tabClass("build")}`}
					>
						build
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("runtime")}
						class={`border px-3 py-1 text-xs transition-colors ${tabClass("runtime")}`}
					>
						runtime
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("storage")}
						class={`border px-3 py-1 text-xs transition-colors ${tabClass("storage")}`}
					>
						storage
					</button>
				</div>
			</div>

			<div class="p-4">
				<Show when={activeTab() === "overview"}>
					<div class="grid gap-4 md:grid-cols-2">
						<Show when={props.showServiceTypePicker !== false}>
							<div class="md:col-span-2">
								<label class="mb-2 block text-xs text-neutral-600">service type</label>
								<div class="grid gap-2 md:grid-cols-4">
									<For
										each={
											[
												"web_service",
												"private_service",
												"background_worker",
												"cron_job",
											] as ServiceType[]
										}
									>
										{(serviceType) => (
											<button
												type="button"
												onClick={() => selectServiceType(serviceType)}
												class={`border px-3 py-3 text-left transition-colors ${
													props.service.service_type === serviceType
														? "border-black bg-black text-white"
														: "border-neutral-200 bg-white text-black hover:border-neutral-400"
												}`}
											>
												<p class="text-xs uppercase tracking-wide">
													{serviceTypeLabel(serviceType)}
												</p>
												<p
													class={`mt-2 text-xs leading-relaxed ${
														props.service.service_type === serviceType
															? "text-neutral-200"
															: "text-neutral-500"
													}`}
												>
													{serviceTypeDescription(serviceType)}
												</p>
											</button>
										)}
									</For>
								</div>
							</div>
						</Show>

						<div>
							<label class="mb-1 block text-xs text-neutral-600">name</label>
							<input
								type="text"
								value={props.service.name}
								onInput={(event) => updateField("name", event.currentTarget.value)}
								class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
								placeholder="web"
								required
							/>
						</div>

						<Show when={expectsInboundPort()}>
							<div>
								<label class="mb-1 block text-xs text-neutral-600">port</label>
								<input
									type="number"
									value={props.service.port}
									onInput={(event) =>
										updateField("port", parseInt(event.currentTarget.value, 10) || 8080)
									}
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="8080"
								/>
							</div>
						</Show>

						<div class="md:col-span-2 border border-neutral-200 bg-neutral-50 px-3 py-3">
							<p class="text-xs text-neutral-600">
								{props.service.service_type === "web_service"
									? "public web service with its own generated service subdomain and optional custom domains."
									: props.service.service_type === "private_service"
										? "internal-only service with no public url but a stable group network address."
										: props.service.service_type === "background_worker"
											? "background worker with no inbound traffic and no routed url."
											: "cron job with scheduled runs and no routed url."}
							</p>
						</div>

						<Show when={props.service.service_type === "web_service"}>
							<div class="md:col-span-2">
								<label class="mb-1 block text-xs text-neutral-600">custom domains</label>
								<textarea
									value={domainsToText(props.service.domains)}
									onInput={(event) =>
										updateField("domains", textToDomains(event.currentTarget.value))
									}
									rows="3"
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder={"api.example.com\nwww.example.com"}
								/>
								<p class="mt-1 text-xs text-neutral-400">
									each web service always gets its own generated service subdomain. add custom
									domains here when this service should also answer on your domains.
								</p>
							</div>
						</Show>

						<div>
							<label class="mb-1 block text-xs text-neutral-600">additional ports</label>
							<textarea
								value={portsToText(props.service.additional_ports)}
								onInput={(event) =>
									updateField("additional_ports", textToPorts(event.currentTarget.value))
								}
								rows="3"
								class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
								placeholder={"9000\n9001"}
							/>
							<p class="mt-1 text-xs text-neutral-400">
								internal-only container ports beyond the primary service port
							</p>
						</div>

						<div>
							<label class="mb-1 block text-xs text-neutral-600">replicas</label>
							<input
								type="number"
								min="1"
								max="10"
								value={props.service.replicas}
								onInput={(event) =>
									updateField("replicas", parseInt(event.currentTarget.value, 10) || 1)
								}
								class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
							/>
						</div>

						<div class="md:col-span-2">
							<label class="mb-1 block text-xs text-neutral-600">depends on</label>
							<Show
								when={availableDependencies().length > 0}
								fallback={<span class="text-xs text-neutral-400">no other services</span>}
							>
								<div class="flex flex-wrap gap-1">
									<For each={availableDependencies()}>
										{(dep) => (
											<button
												type="button"
												onClick={() => toggleDependency(dep)}
												class={`border px-2 py-0.5 text-xs ${
													props.service.depends_on.includes(dep)
														? "border-black bg-black text-white"
														: "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
												}`}
											>
												{dep}
											</button>
										)}
									</For>
								</div>
							</Show>
						</div>
					</div>
				</Show>

				<Show when={activeTab() === "build"}>
					<div class="space-y-4">
						<div class="grid gap-4 md:grid-cols-2">
							<div class="md:col-span-2">
								<label class="mb-1 block text-xs text-neutral-600">docker image</label>
								<input
									type="text"
									value={props.service.image}
									onInput={(event) => updateField("image", event.currentTarget.value)}
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="ghcr.io/acme/worker:latest"
								/>
								<p class="mt-1 text-xs text-neutral-400">
									leave empty to build from the linked repository. set an image when this service
									should deploy a prebuilt container instead.
								</p>
							</div>

							<div>
								<label class="mb-1 block text-xs text-neutral-600">build context</label>
								<input
									type="text"
									value={props.service.build_context}
									onInput={(event) => updateField("build_context", event.currentTarget.value)}
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="."
								/>
							</div>

							<div>
								<label class="mb-1 block text-xs text-neutral-600">dockerfile path</label>
								<input
									type="text"
									value={props.service.dockerfile_path}
									onInput={(event) => updateField("dockerfile_path", event.currentTarget.value)}
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="Dockerfile"
								/>
							</div>

							<div>
								<label class="mb-1 block text-xs text-neutral-600">build target</label>
								<input
									type="text"
									value={props.service.build_target}
									onInput={(event) => updateField("build_target", event.currentTarget.value)}
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="runtime"
								/>
							</div>

							<div class="border border-neutral-200 bg-neutral-50 px-3 py-3 text-xs text-neutral-500">
								<p>
									{isRepositoryBuild()
										? "this service will build from the repository on each deployment."
										: "build settings are ignored while a fixed image is set."}
								</p>
							</div>
						</div>

						<EnvVarEditor
							envVars={props.service.build_args}
							onChange={(buildArgs) => updateField("build_args", buildArgs)}
							title="build arguments"
							description="docker build args passed when containr builds this service from source"
							emptyText="no build arguments configured"
							addLabel="add build argument"
							bulkHint=".env format works. existing secret build args keep their secret flag."
						/>
					</div>
				</Show>

				<Show when={activeTab() === "runtime"}>
					<div class="space-y-4">
						<EnvVarEditor
							envVars={props.service.env_vars}
							onChange={(envVars) => updateField("env_vars", envVars)}
							title="service environment"
							description="applies only to this service. shared group env vars are merged in automatically."
							emptyText="no service-specific environment variables configured"
							addLabel="add service variable"
						/>

						<div class="grid gap-4 md:grid-cols-2">
							<div>
								<label class="mb-1 block text-xs text-neutral-600">memory (mb)</label>
								<input
									type="number"
									value={props.service.memory_limit_mb || ""}
									onInput={(event) => {
										const value = event.currentTarget.value;
										updateField("memory_limit_mb", value ? parseInt(value, 10) : null);
									}}
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="512"
								/>
							</div>

							<div>
								<label class="mb-1 block text-xs text-neutral-600">cpu cores</label>
								<input
									type="number"
									value={props.service.cpu_limit || ""}
									onInput={(event) => {
										const value = event.currentTarget.value;
										updateField("cpu_limit", value ? parseFloat(value) : null);
									}}
									step="0.1"
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="1.0"
								/>
							</div>

							<Show when={expectsInboundPort()}>
								<>
									<div>
										<label class="mb-1 block text-xs text-neutral-600">health check path</label>
										<input
											type="text"
											value={props.service.health_check_path}
											onInput={(event) =>
												updateField("health_check_path", event.currentTarget.value)
											}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
											placeholder="/health"
										/>
									</div>

									<div>
										<label class="mb-1 block text-xs text-neutral-600">health interval (s)</label>
										<input
											type="number"
											min="1"
											value={props.service.health_check_interval_secs}
											onInput={(event) =>
												updateField(
													"health_check_interval_secs",
													parseInt(event.currentTarget.value, 10) || 30,
												)
											}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
										/>
									</div>

									<div>
										<label class="mb-1 block text-xs text-neutral-600">health timeout (s)</label>
										<input
											type="number"
											min="1"
											value={props.service.health_check_timeout_secs}
											onInput={(event) =>
												updateField(
													"health_check_timeout_secs",
													parseInt(event.currentTarget.value, 10) || 5,
												)
											}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
										/>
									</div>

									<div>
										<label class="mb-1 block text-xs text-neutral-600">health retries</label>
										<input
											type="number"
											min="1"
											value={props.service.health_check_retries}
											onInput={(event) =>
												updateField(
													"health_check_retries",
													parseInt(event.currentTarget.value, 10) || 3,
												)
											}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
										/>
									</div>
								</>
							</Show>

							<Show when={!expectsInboundPort()}>
								<div class="md:col-span-2 border border-neutral-200 bg-neutral-50 px-3 py-3 text-xs text-neutral-500">
									background workers and cron jobs do not use http health checks unless you switch
									them to a web or private service.
								</div>
							</Show>

							<div>
								<label class="mb-1 block text-xs text-neutral-600">restart policy</label>
								<select
									value={props.service.restart_policy}
									onChange={(event) => updateField("restart_policy", event.currentTarget.value)}
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black focus:border-black focus:outline-none"
								>
									<option value="always">always</option>
									<option value="on-failure">on failure</option>
									<option value="never">never</option>
								</select>
							</div>

							<div class="md:col-span-2">
								<label class="mb-1 block text-xs text-neutral-600">command args</label>
								<textarea
									value={argsToText(props.service.command)}
									onInput={(event) => updateField("command", textToArgs(event.currentTarget.value))}
									rows="3"
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder={"npm\nrun\nstart"}
								/>
							</div>

							<div class="md:col-span-2">
								<label class="mb-1 block text-xs text-neutral-600">entrypoint</label>
								<textarea
									value={argsToText(props.service.entrypoint)}
									onInput={(event) =>
										updateField("entrypoint", textToArgs(event.currentTarget.value))
									}
									rows="2"
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder={"/usr/bin/env"}
								/>
							</div>

							<div class="md:col-span-2">
								<label class="mb-1 block text-xs text-neutral-600">working directory</label>
								<input
									type="text"
									value={props.service.working_dir}
									onInput={(event) => updateField("working_dir", event.currentTarget.value)}
									class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="/workspace"
								/>
							</div>

							<div class="md:col-span-2 border-t border-neutral-100 pt-3">
								<div class="mb-3 flex items-center justify-between">
									<label class="block text-xs text-neutral-600">private registry auth</label>
									<Show
										when={props.service.registry_auth}
										fallback={
											<button
												type="button"
												onClick={enableRegistryAuth}
												class="border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:border-neutral-400"
											>
												configure auth
											</button>
										}
									>
										<button
											type="button"
											onClick={() => updateField("registry_auth", null)}
											class="text-xs text-neutral-500 hover:text-black"
										>
											clear auth
										</button>
									</Show>
								</div>

								<Show
									when={props.service.registry_auth}
									fallback={
										<p class="text-xs text-neutral-400">
											use this when the service image comes from a private registry
										</p>
									}
								>
									<div class="grid gap-3 lg:grid-cols-3">
										<div>
											<label class="mb-1 block text-xs text-neutral-600">registry server</label>
											<input
												type="text"
												value={props.service.registry_auth?.server || ""}
												onInput={(event) => updateRegistryAuth("server", event.currentTarget.value)}
												class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
												placeholder="ghcr.io"
											/>
										</div>
										<div>
											<label class="mb-1 block text-xs text-neutral-600">username</label>
											<input
												type="text"
												value={props.service.registry_auth?.username || ""}
												onInput={(event) =>
													updateRegistryAuth("username", event.currentTarget.value)
												}
												class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
												placeholder="registry user"
											/>
										</div>
										<div>
											<label class="mb-1 block text-xs text-neutral-600">password</label>
											<input
												type="password"
												value={props.service.registry_auth?.password || ""}
												onInput={(event) =>
													updateRegistryAuth("password", event.currentTarget.value)
												}
												class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
												placeholder="password"
											/>
										</div>
									</div>
								</Show>
							</div>
						</div>
					</div>
				</Show>

				<Show when={activeTab() === "storage"}>
					<div class="border-t border-neutral-100 pt-3">
						<div class="mb-3 flex items-center justify-between">
							<label class="block text-xs text-neutral-600">persistent mounts</label>
							<button
								type="button"
								onClick={addMount}
								class="border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:border-neutral-400"
							>
								add mount
							</button>
						</div>

						<Show
							when={props.service.mounts.length > 0}
							fallback={<p class="text-xs text-neutral-400">no mounts configured</p>}
						>
							<div class="space-y-3">
								<For each={props.service.mounts}>
									{(mount, mountIndex) => (
										<div class="border border-neutral-200 p-3">
											<div class="grid gap-3 md:grid-cols-3">
												<div>
													<label class="mb-1 block text-xs text-neutral-600">name</label>
													<input
														type="text"
														value={mount.name}
														onInput={(event) =>
															updateMount(mountIndex(), "name", event.currentTarget.value)
														}
														class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
														placeholder="data"
													/>
												</div>
												<div class="col-span-2">
													<label class="mb-1 block text-xs text-neutral-600">target path</label>
													<input
														type="text"
														value={mount.target}
														onInput={(event) =>
															updateMount(mountIndex(), "target", event.currentTarget.value)
														}
														class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
														placeholder="/data"
													/>
												</div>
											</div>
											<div class="mt-3 flex items-center justify-between">
												<label class="flex items-center gap-2 text-xs text-neutral-600">
													<input
														type="checkbox"
														checked={mount.read_only}
														onChange={(event) =>
															updateMount(mountIndex(), "read_only", event.currentTarget.checked)
														}
														class="border border-neutral-300"
													/>
													read only
												</label>
												<button
													type="button"
													onClick={() => removeMount(mountIndex())}
													class="text-xs text-neutral-500 hover:text-black"
												>
													remove
												</button>
											</div>
										</div>
									)}
								</For>
							</div>
						</Show>
					</div>
				</Show>
			</div>
		</Card>
	);
};

export default ServiceForm;
