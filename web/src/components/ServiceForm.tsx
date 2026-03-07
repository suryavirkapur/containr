import { Component, createSignal, For, Show } from "solid-js";

/**
 * service configuration for multi-container apps
 */
export interface Service {
	name: string;
	image: string;
	port: number;
	additional_ports: number[];
	replicas: number;
	memory_limit_mb: number | null;
	cpu_limit: number | null;
	depends_on: string[];
	health_check_path: string;
	restart_policy: string;
	registry_auth: ServiceRegistryAuth | null;
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
		port: 8080,
		additional_ports: [],
		replicas: 1,
		memory_limit_mb: null,
		cpu_limit: null,
		depends_on: [],
		health_check_path: "",
		restart_policy: "always",
		registry_auth: null,
		command: [],
		entrypoint: [],
		working_dir: "",
		mounts: [],
	};
}

interface ServiceFormProps {
	service: Service;
	index: number;
	allServices: Service[];
	onUpdate: (index: number, service: Service) => void;
	onRemove: (index: number) => void;
}

/**
 * form for configuring a single container service
 */
const ServiceForm: Component<ServiceFormProps> = (props) => {
	const [showAdvanced, setShowAdvanced] = createSignal(false);

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
			.filter(
				(entry) => Number.isInteger(entry) && entry > 0 && entry <= 65535,
			);

	const updateField = <K extends keyof Service>(
		field: K,
		value: Service[K],
	) => {
		props.onUpdate(props.index, { ...props.service, [field]: value });
	};

	const availableDependencies = () =>
		props.allServices
			.filter((_, i) => i !== props.index)
			.map((s) => s.name)
			.filter((n) => n.length > 0);

	const toggleDependency = (dep: string) => {
		const current = props.service.depends_on;
		const updated = current.includes(dep)
			? current.filter((d) => d !== dep)
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

	const updateMount = (
		mountIndex: number,
		field: keyof ServiceMount,
		value: string | boolean,
	) => {
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

	const updateRegistryAuth = (
		field: keyof ServiceRegistryAuth,
		value: string,
	) => {
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

	return (
		<div class="border border-neutral-200 p-4 mb-4">
			<div class="flex justify-between items-center mb-4">
				<span class="text-sm font-medium text-black">
					service {props.index + 1}
				</span>
				<button
					type="button"
					onClick={() => props.onRemove(props.index)}
					class="text-neutral-400 hover:text-neutral-600 text-sm"
				>
					remove
				</button>
			</div>

			<div class="grid grid-cols-2 gap-4">
				{/* service name */}
				<div>
					<label class="block text-neutral-600 text-xs mb-1">name</label>
					<input
						type="text"
						value={props.service.name}
						onInput={(e) => updateField("name", e.currentTarget.value)}
						class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
						placeholder="web"
						required
					/>
				</div>

				{/* port */}
				<div>
					<label class="block text-neutral-600 text-xs mb-1">port</label>
					<input
						type="number"
						value={props.service.port}
						onInput={(e) =>
							updateField("port", parseInt(e.currentTarget.value) || 8080)
						}
						class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
						placeholder="8080"
					/>
				</div>

				<div>
					<label class="block text-neutral-600 text-xs mb-1">
						additional ports
					</label>
					<textarea
						value={portsToText(props.service.additional_ports)}
						onInput={(e) =>
							updateField(
								"additional_ports",
								textToPorts(e.currentTarget.value),
							)
						}
						rows="3"
						class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm font-mono"
						placeholder={"9000\n9001"}
					/>
					<p class="mt-1 text-xs text-neutral-400">
						optional extra container ports for internal network access.
					</p>
				</div>

				{/* image */}
				<div class="col-span-2">
					<label class="block text-neutral-600 text-xs mb-1">
						docker image{" "}
						<span class="text-neutral-400">
							(leave empty to use built image)
						</span>
					</label>
					<input
						type="text"
						value={props.service.image}
						onInput={(e) => updateField("image", e.currentTarget.value)}
						class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
						placeholder="postgres:15 or leave empty"
					/>
				</div>

				{/* replicas */}
				<div>
					<label class="block text-neutral-600 text-xs mb-1">replicas</label>
					<input
						type="number"
						value={props.service.replicas}
						onInput={(e) =>
							updateField("replicas", parseInt(e.currentTarget.value) || 1)
						}
						min="1"
						max="10"
						class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
					/>
				</div>

				{/* dependencies */}
				<div>
					<label class="block text-neutral-600 text-xs mb-1">depends on</label>
					<Show
						when={availableDependencies().length > 0}
						fallback={
							<span class="text-xs text-neutral-400">no other services</span>
						}
					>
						<div class="flex flex-wrap gap-1">
							<For each={availableDependencies()}>
								{(dep) => (
									<button
										type="button"
										onClick={() => toggleDependency(dep)}
										class={`px-2 py-0.5 text-xs border ${
											props.service.depends_on.includes(dep)
												? "bg-black text-white border-black"
												: "bg-white text-neutral-600 border-neutral-300 hover:border-neutral-400"
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

			{/* advanced toggle */}
			<button
				type="button"
				onClick={() => setShowAdvanced(!showAdvanced())}
				class="mt-3 text-xs text-neutral-500 hover:text-neutral-700"
			>
				{showAdvanced() ? "▼ hide advanced" : "▶ show advanced"}
			</button>

			{/* advanced options */}
			<Show when={showAdvanced()}>
				<div class="mt-3 pt-3 border-t border-neutral-100 grid grid-cols-2 gap-4">
					{/* memory limit */}
					<div>
						<label class="block text-neutral-600 text-xs mb-1">
							memory (mb)
						</label>
						<input
							type="number"
							value={props.service.memory_limit_mb || ""}
							onInput={(e) => {
								const val = e.currentTarget.value;
								updateField("memory_limit_mb", val ? parseInt(val) : null);
							}}
							class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
							placeholder="512"
						/>
					</div>

					{/* cpu limit */}
					<div>
						<label class="block text-neutral-600 text-xs mb-1">cpu cores</label>
						<input
							type="number"
							value={props.service.cpu_limit || ""}
							onInput={(e) => {
								const val = e.currentTarget.value;
								updateField("cpu_limit", val ? parseFloat(val) : null);
							}}
							step="0.1"
							class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
							placeholder="1.0"
						/>
					</div>

					{/* health check path */}
					<div>
						<label class="block text-neutral-600 text-xs mb-1">
							health check path
						</label>
						<input
							type="text"
							value={props.service.health_check_path}
							onInput={(e) =>
								updateField("health_check_path", e.currentTarget.value)
							}
							class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
							placeholder="/health"
						/>
					</div>

					{/* restart policy */}
					<div>
						<label class="block text-neutral-600 text-xs mb-1">
							restart policy
						</label>
						<select
							value={props.service.restart_policy}
							onChange={(e) =>
								updateField("restart_policy", e.currentTarget.value)
							}
							class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black focus:outline-none focus:border-black text-sm"
						>
							<option value="always">always</option>
							<option value="on-failure">on failure</option>
							<option value="never">never</option>
						</select>
					</div>

					<div class="col-span-2">
						<label class="block text-neutral-600 text-xs mb-1">
							command args
						</label>
						<textarea
							value={argsToText(props.service.command)}
							onInput={(e) =>
								updateField("command", textToArgs(e.currentTarget.value))
							}
							rows="3"
							class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm font-mono"
							placeholder={"npm\nrun\nstart"}
						/>
						<p class="mt-1 text-xs text-neutral-400">
							one argument per line. leave empty to use the image default.
						</p>
					</div>

					<div class="col-span-2">
						<label class="block text-neutral-600 text-xs mb-1">
							entrypoint
						</label>
						<textarea
							value={argsToText(props.service.entrypoint)}
							onInput={(e) =>
								updateField("entrypoint", textToArgs(e.currentTarget.value))
							}
							rows="2"
							class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm font-mono"
							placeholder={"/usr/bin/env"}
						/>
					</div>

					<div class="col-span-2">
						<label class="block text-neutral-600 text-xs mb-1">
							working directory
						</label>
						<input
							type="text"
							value={props.service.working_dir}
							onInput={(e) => updateField("working_dir", e.currentTarget.value)}
							class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm font-mono"
							placeholder="/workspace"
						/>
					</div>

					<div class="col-span-2 border-t border-neutral-100 pt-3">
						<div class="flex items-center justify-between mb-3">
							<label class="block text-neutral-600 text-xs">
								private registry auth
							</label>
							<Show
								when={props.service.registry_auth}
								fallback={
									<button
										type="button"
										onClick={enableRegistryAuth}
										class="px-2 py-1 text-xs border border-neutral-300 text-neutral-600 hover:border-neutral-400"
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
							<div class="grid grid-cols-3 gap-3">
								<div>
									<label class="block text-neutral-600 text-xs mb-1">
										registry server
									</label>
									<input
										type="text"
										value={props.service.registry_auth?.server || ""}
										onInput={(e) =>
											updateRegistryAuth("server", e.currentTarget.value)
										}
										class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
										placeholder="ghcr.io"
									/>
								</div>
								<div>
									<label class="block text-neutral-600 text-xs mb-1">
										username
									</label>
									<input
										type="text"
										value={props.service.registry_auth?.username || ""}
										onInput={(e) =>
											updateRegistryAuth("username", e.currentTarget.value)
										}
										class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
										placeholder="registry user"
									/>
								</div>
								<div>
									<label class="block text-neutral-600 text-xs mb-1">
										password
									</label>
									<input
										type="password"
										value={props.service.registry_auth?.password || ""}
										onInput={(e) =>
											updateRegistryAuth("password", e.currentTarget.value)
										}
										class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
										placeholder="password"
									/>
								</div>
							</div>
						</Show>
					</div>

					<div class="col-span-2 border-t border-neutral-100 pt-3">
						<div class="flex items-center justify-between mb-3">
							<label class="block text-neutral-600 text-xs">
								persistent mounts
							</label>
							<button
								type="button"
								onClick={addMount}
								class="px-2 py-1 text-xs border border-neutral-300 text-neutral-600 hover:border-neutral-400"
							>
								add mount
							</button>
						</div>

						<Show
							when={props.service.mounts.length > 0}
							fallback={
								<p class="text-xs text-neutral-400">no mounts configured</p>
							}
						>
							<div class="space-y-3">
								<For each={props.service.mounts}>
									{(mount, mountIndex) => (
										<div class="border border-neutral-200 p-3">
											<div class="grid grid-cols-3 gap-3">
												<div>
													<label class="block text-neutral-600 text-xs mb-1">
														name
													</label>
													<input
														type="text"
														value={mount.name}
														onInput={(e) =>
															updateMount(
																mountIndex(),
																"name",
																e.currentTarget.value,
															)
														}
														class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
														placeholder="data"
													/>
												</div>
												<div class="col-span-2">
													<label class="block text-neutral-600 text-xs mb-1">
														target path
													</label>
													<input
														type="text"
														value={mount.target}
														onInput={(e) =>
															updateMount(
																mountIndex(),
																"target",
																e.currentTarget.value,
															)
														}
														class="w-full px-2 py-1.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
														placeholder="/data"
													/>
												</div>
											</div>
											<div class="flex items-center justify-between mt-3">
												<label class="flex items-center gap-2 text-xs text-neutral-600">
													<input
														type="checkbox"
														checked={mount.read_only}
														onChange={(e) =>
															updateMount(
																mountIndex(),
																"read_only",
																e.currentTarget.checked,
															)
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
				</div>
			</Show>
		</div>
	);
};

export default ServiceForm;
