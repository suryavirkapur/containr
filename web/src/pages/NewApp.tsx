import { Component, createResource, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";

import { api, components } from "../api";
import EnvVarEditor from "../components/EnvVarEditor";
import {
	type Service,
	type ServiceType,
	createServiceForType,
	applyServiceType,
	serviceTypeLabel,
	serviceTypeDescription,
} from "../components/ServiceForm";
import { type EditableEnvVar, mapServiceToRequest } from "../utils/projectEditor";
import { EditableKeyValueEntry } from "../utils/keyValueEntries";

type GithubAppStatus = components["schemas"]["GithubAppStatusResponse"];
type RepoInfo = components["schemas"]["RepoInfo"];

const fetchGithubApp = async (): Promise<GithubAppStatus> => {
	try {
		const { data, error } = await api.GET("/api/github/app");
		if (error) throw error;
		return data;
	} catch {
		return { configured: false, app: null, installations: [] };
	}
};

const fetchGithubRepos = async (): Promise<RepoInfo[]> => {
	try {
		const { data, error } = await api.GET("/api/github/app/repos");
		if (error) throw error;
		return data.repos || [];
	} catch {
		return [];
	}
};

function inferServiceName(sourceUrl: string) {
	const trimmed = sourceUrl.trim();
	if (!trimmed) return "";
	const cleaned = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
	const segments = cleaned.split(/[/:]/).filter(Boolean);
	return segments[segments.length - 1] || "";
}

const serviceTypeOptions: { type: ServiceType; icon: string }[] = [
	{ type: "web_service", icon: "🌐" },
	{ type: "private_service", icon: "🔒" },
	{ type: "background_worker", icon: "⚙" },
];

/// render-style single-service creation flow
const NewApp: Component = () => {
	const navigate = useNavigate();

	// service type (pre-selected to web_service)
	const [selectedType, setSelectedType] =
		createSignal<ServiceType>("web_service");
	const [service, setService] =
		createSignal<Service>(createServiceForType("web_service"));

	// source
	const [githubUrl, setGithubUrl] = createSignal("");
	const [branch, setBranch] = createSignal("main");
	const [useRepoPicker, setUseRepoPicker] = createSignal(true);
	const [repoFilter, setRepoFilter] = createSignal("");

	// shared env vars
	const [envVars, setEnvVars] = createSignal<EditableEnvVar[]>([]);

	// ui state
	const [showAdvanced, setShowAdvanced] = createSignal(false);
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);

	const [githubApp] = createResource(fetchGithubApp);
	const [githubRepos] = createResource(fetchGithubRepos);

	const hasGithubAccess = () => {
		const app = githubApp();
		return app?.configured && (app?.installations?.length ?? 0) > 0;
	};

	const filteredRepos = () => {
		const repos = githubRepos() || [];
		const filter = repoFilter().toLowerCase();
		if (!filter) return repos;
		return repos.filter(
			(repo) =>
				repo.name.toLowerCase().includes(filter) ||
				repo.full_name.toLowerCase().includes(filter),
		);
	};

	const applyRepoSelection = (repoUrl: string, defaultBranch?: string) => {
		setGithubUrl(repoUrl);
		if (defaultBranch) setBranch(defaultBranch);
		// auto-fill service name from repo name if empty
		if (!service().name.trim()) {
			const inferred = inferServiceName(repoUrl);
			if (inferred) {
				setService({ ...service(), name: inferred });
			}
		}
	};

	const switchServiceType = (serviceType: ServiceType) => {
		setSelectedType(serviceType);
		setService(applyServiceType(service(), serviceType));
	};

	const updateField = <K extends keyof Service>(
		field: K,
		value: Service[K],
	) => {
		setService({ ...service(), [field]: value });
	};

	const expectsInboundPort = () =>
		selectedType() !== "background_worker";

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		setError("");
		setLoading(true);

		try {
			const svc = service();
			if (!svc.name.trim()) {
				throw new Error("service name is required");
			}

			const { data, error: apiError } = await api.POST("/api/projects", {
				body: {
					name: svc.name.trim(),
					github_url: githubUrl().trim(),
					branch: branch().trim() || "main",
					env_vars: envVars().length > 0 ? envVars() : null,
					services: [mapServiceToRequest(svc)],
				},
			});

			if (apiError) throw apiError;
			navigate(`/projects/${data.id}`);
		} catch (err: any) {
			setError(err?.error || err?.message || "failed to create service");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div class="mx-auto max-w-3xl">
			<div class="mb-10">
				<h1 class="text-2xl font-serif text-black">new service</h1>
				<p class="mt-1 text-sm text-neutral-500">
					connect a repository, configure your service, and deploy
				</p>
			</div>

			<Show when={error()}>
				<div class="mb-6 border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
					{error()}
				</div>
			</Show>

			<form onSubmit={handleSubmit} class="space-y-6">
				{/* step 1: service type */}
				<section class="border border-neutral-200 bg-white p-6">
					<h2 class="mb-1 text-sm font-serif text-black">
						service type
					</h2>
					<p class="mb-4 text-xs text-neutral-500">
						choose what kind of service you are deploying
					</p>

					<div class="grid gap-3 md:grid-cols-3">
						<For each={serviceTypeOptions}>
							{(option) => (
								<button
									type="button"
									onClick={() => switchServiceType(option.type)}
									class={`border px-4 py-4 text-left transition-colors ${selectedType() === option.type
											? "border-black bg-black text-white"
											: "border-neutral-200 bg-white text-black hover:border-neutral-400"
										}`}
								>
									<div class="flex items-center gap-2">
										<span class="text-base">{option.icon}</span>
										<span class="text-xs uppercase tracking-wide">
											{serviceTypeLabel(option.type)}
										</span>
									</div>
									<p
										class={`mt-2 text-xs leading-relaxed ${selectedType() === option.type
												? "text-neutral-300"
												: "text-neutral-500"
											}`}
									>
										{serviceTypeDescription(option.type)}
									</p>
								</button>
							)}
						</For>
					</div>
				</section>

				{/* step 2: source + basic config */}
				<section class="border border-neutral-200 bg-white p-6">
					<div class="mb-4 flex flex-wrap items-start justify-between gap-4">
						<div>
							<h2 class="text-sm font-serif text-black">
								source & configuration
							</h2>
							<p class="mt-1 text-xs text-neutral-500">
								connect a repository and configure the basics
							</p>
						</div>
						<Show when={hasGithubAccess()}>
							<button
								type="button"
								onClick={() => setUseRepoPicker(!useRepoPicker())}
								class="border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-400"
							>
								{useRepoPicker()
									? "enter url manually"
									: "pick from github"}
							</button>
						</Show>
					</div>

					<div class="space-y-4">
						{/* repository */}
						<div>
							<label class="mb-2 block text-xs text-neutral-600">
								repository
							</label>
							<Show when={hasGithubAccess() && useRepoPicker()}>
								<div class="border border-neutral-300">
									<div class="border-b border-neutral-200 p-2">
										<input
											type="text"
											value={repoFilter()}
											onInput={(e) =>
												setRepoFilter(e.currentTarget.value)
											}
											placeholder="search repositories..."
											class="w-full border border-neutral-200 px-2 py-1.5 text-sm focus:border-neutral-400 focus:outline-none"
										/>
									</div>
									<div class="max-h-56 overflow-y-auto">
										<Show when={githubRepos.loading}>
											<div class="p-4 text-center text-sm text-neutral-400">
												loading repos...
											</div>
										</Show>
										<Show
											when={
												!githubRepos.loading &&
												filteredRepos().length === 0
											}
										>
											<div class="p-4 text-center text-sm text-neutral-400">
												no repos found
											</div>
										</Show>
										<For each={filteredRepos()}>
											{(repo) => (
												<button
													type="button"
													onClick={() =>
														applyRepoSelection(
															repo.clone_url,
															repo.default_branch,
														)
													}
													class={`flex w-full items-center justify-between border-b border-neutral-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-neutral-50 ${githubUrl() === repo.clone_url
															? "bg-neutral-100"
															: ""
														}`}
												>
													<div>
														<span class="text-black">
															{repo.name}
														</span>
														<span class="ml-2 text-xs text-neutral-400">
															{repo.default_branch}
														</span>
													</div>
													<Show when={repo.private}>
														<span class="bg-neutral-200 px-1.5 py-0.5 text-xs text-neutral-600">
															private
														</span>
													</Show>
												</button>
											)}
										</For>
									</div>
								</div>
							</Show>

							<Show when={!hasGithubAccess() || !useRepoPicker()}>
								<input
									type="url"
									value={githubUrl()}
									onInput={(e) =>
										applyRepoSelection(e.currentTarget.value)
									}
									class="w-full border border-neutral-300 bg-white px-3 py-2.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="https://github.com/acme/app"
									required
								/>
								<Show when={!hasGithubAccess()}>
									<p class="mt-1.5 text-xs text-neutral-400">
										<a
											href="/settings"
											class="underline hover:text-black"
										>
											set up github app
										</a>{" "}
										to browse and deploy private repositories
									</p>
								</Show>
							</Show>
						</div>

						{/* service name + branch */}
						<div class="grid gap-4 md:grid-cols-2">
							<div>
								<label class="mb-2 block text-xs text-neutral-600">
									service name
								</label>
								<input
									type="text"
									value={service().name}
									onInput={(e) =>
										updateField("name", e.currentTarget.value)
									}
									class="w-full border border-neutral-300 bg-white px-3 py-2.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="my-api"
									required
								/>
							</div>
							<div>
								<label class="mb-2 block text-xs text-neutral-600">
									branch
								</label>
								<input
									type="text"
									value={branch()}
									onInput={(e) =>
										setBranch(e.currentTarget.value)
									}
									class="w-full border border-neutral-300 bg-white px-3 py-2.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="main"
								/>
							</div>
						</div>

						{/* expose to web checkbox + port */}
						<Show when={selectedType() !== "background_worker"}>
							<div class="border border-neutral-200 bg-neutral-50 px-4 py-4">
								<label class="flex items-center gap-3 cursor-pointer">
									<input
										type="checkbox"
										checked={service().expose_http}
										onChange={(e) => {
											const checked = e.currentTarget.checked;
											updateField("expose_http", checked);
											if (checked) {
												updateField(
													"service_type",
													"web_service",
												);
												setSelectedType("web_service");
											} else {
												updateField(
													"service_type",
													"private_service",
												);
												setSelectedType("private_service");
											}
										}}
										class="h-4 w-4 border border-neutral-400 accent-black"
									/>
									<div>
										<span class="text-sm text-black">
											expose to web
										</span>
										<p class="text-xs text-neutral-500">
											give this service a public url with https.
											uncheck to keep it internal-only.
										</p>
									</div>
								</label>
							</div>
						</Show>

						{/* port */}
						<Show when={expectsInboundPort()}>
							<div class="max-w-xs">
								<label class="mb-2 block text-xs text-neutral-600">
									port
								</label>
								<input
									type="number"
									value={service().port}
									onInput={(e) =>
										updateField(
											"port",
											parseInt(e.currentTarget.value, 10) ||
											8080,
										)
									}
									class="w-full border border-neutral-300 bg-white px-3 py-2.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="8080"
								/>
								<p class="mt-1 text-xs text-neutral-400">
									the port your application listens on
								</p>
							</div>
						</Show>
					</div>
				</section>

				{/* step 3: advanced (collapsed) */}
				<section class="border border-neutral-200 bg-white">
					<button
						type="button"
						onClick={() => setShowAdvanced(!showAdvanced())}
						class="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-neutral-50 transition-colors"
					>
						<div>
							<h2 class="text-sm font-serif text-black">
								advanced settings
							</h2>
							<p class="mt-0.5 text-xs text-neutral-500">
								environment variables, build config, runtime, and
								storage
							</p>
						</div>
						<svg
							class={`h-4 w-4 text-neutral-400 transition-transform ${showAdvanced() ? "rotate-180" : ""
								}`}
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M19 9l-7 7-7-7"
							/>
						</svg>
					</button>

					<Show when={showAdvanced()}>
						<div class="space-y-6 border-t border-neutral-100 px-6 py-6">
							{/* shared environment variables */}
							<EnvVarEditor
								envVars={envVars()}
								onChange={setEnvVars}
								title="environment variables"
								description="available to this service at runtime"
								emptyText="no environment variables configured"
								addLabel="add variable"
							/>

							{/* docker image override */}
							<div>
								<label class="mb-1 block text-xs text-neutral-600">
									docker image (optional)
								</label>
								<input
									type="text"
									value={service().image}
									onInput={(e) =>
										updateField("image", e.currentTarget.value)
									}
									class="w-full border border-neutral-300 bg-white px-3 py-2.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
									placeholder="ghcr.io/acme/worker:latest"
								/>
								<p class="mt-1 text-xs text-neutral-400">
									leave empty to build from the repository.
									set an image to deploy a prebuilt container.
								</p>
							</div>

							{/* build settings */}
							<div>
								<h3 class="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
									build
								</h3>
								<div class="grid gap-3 md:grid-cols-3">
									<div>
										<label class="mb-1 block text-xs text-neutral-600">
											build context
										</label>
										<input
											type="text"
											value={service().build_context}
											onInput={(e) =>
												updateField(
													"build_context",
													e.currentTarget.value,
												)
											}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
											placeholder="."
										/>
									</div>
									<div>
										<label class="mb-1 block text-xs text-neutral-600">
											dockerfile path
										</label>
										<input
											type="text"
											value={service().dockerfile_path}
											onInput={(e) =>
												updateField(
													"dockerfile_path",
													e.currentTarget.value,
												)
											}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
											placeholder="Dockerfile"
										/>
									</div>
									<div>
										<label class="mb-1 block text-xs text-neutral-600">
											build target
										</label>
										<input
											type="text"
											value={service().build_target}
											onInput={(e) =>
												updateField(
													"build_target",
													e.currentTarget.value,
												)
											}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
											placeholder="runtime"
										/>
									</div>
								</div>

								<div class="mt-3">
									<EnvVarEditor
										envVars={service().build_args}
										onChange={(args: EditableKeyValueEntry[]) =>
											updateField("build_args", args)
										}
										title="build arguments"
										description="docker build args passed during build"
										emptyText="no build arguments"
										addLabel="add build arg"
									/>
								</div>
							</div>

							{/* runtime settings */}
							<div>
								<h3 class="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
									runtime
								</h3>
								<div class="grid gap-3 md:grid-cols-2">
									<div>
										<label class="mb-1 block text-xs text-neutral-600">
											replicas
										</label>
										<input
											type="number"
											min="1"
											max="10"
											value={service().replicas}
											onInput={(e) =>
												updateField(
													"replicas",
													parseInt(
														e.currentTarget.value,
														10,
													) || 1,
												)
											}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
										/>
									</div>
									<div>
										<label class="mb-1 block text-xs text-neutral-600">
											restart policy
										</label>
										<select
											value={service().restart_policy}
											onChange={(e) =>
												updateField(
													"restart_policy",
													e.currentTarget.value,
												)
											}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black focus:border-black focus:outline-none"
										>
											<option value="always">always</option>
											<option value="on-failure">
												on failure
											</option>
											<option value="never">never</option>
										</select>
									</div>
									<div>
										<label class="mb-1 block text-xs text-neutral-600">
											memory (mb)
										</label>
										<input
											type="number"
											value={service().memory_limit_mb || ""}
											onInput={(e) => {
												const val = e.currentTarget.value;
												updateField(
													"memory_limit_mb",
													val ? parseInt(val, 10) : null,
												);
											}}
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
											placeholder="512"
										/>
									</div>
									<div>
										<label class="mb-1 block text-xs text-neutral-600">
											cpu cores
										</label>
										<input
											type="number"
											value={service().cpu_limit || ""}
											onInput={(e) => {
												const val = e.currentTarget.value;
												updateField(
													"cpu_limit",
													val ? parseFloat(val) : null,
												);
											}}
											step="0.1"
											class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
											placeholder="1.0"
										/>
									</div>
								</div>

								{/* health checks */}
								<Show when={expectsInboundPort()}>
									<div class="mt-3 grid gap-3 md:grid-cols-2">
										<div>
											<label class="mb-1 block text-xs text-neutral-600">
												health check path
											</label>
											<input
												type="text"
												value={service().health_check_path}
												onInput={(e) =>
													updateField(
														"health_check_path",
														e.currentTarget.value,
													)
												}
												class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
												placeholder="/health"
											/>
										</div>
										<div>
											<label class="mb-1 block text-xs text-neutral-600">
												health interval (s)
											</label>
											<input
												type="number"
												min="1"
												value={
													service()
														.health_check_interval_secs
												}
												onInput={(e) =>
													updateField(
														"health_check_interval_secs",
														parseInt(
															e.currentTarget.value,
															10,
														) || 30,
													)
												}
												class="w-full border border-neutral-300 bg-white px-2 py-1.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
											/>
										</div>
									</div>
								</Show>
							</div>

							{/* service-specific env vars */}
							<EnvVarEditor
								envVars={service().env_vars}
								onChange={(vars: EditableKeyValueEntry[]) =>
									updateField("env_vars", vars)
								}
								title="service environment"
								description="service-specific variables, merged with the ones above"
								emptyText="no service-specific variables"
								addLabel="add service variable"
							/>
						</div>
					</Show>
				</section>

				{/* deploy button */}
				<div class="flex gap-3">
					<button
						type="submit"
						disabled={loading()}
						class="flex-1 bg-black px-4 py-3 text-sm text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{loading()
							? "creating and deploying..."
							: "create and deploy"}
					</button>
					<button
						type="button"
						onClick={() => navigate("/projects")}
						class="border border-neutral-300 px-4 py-3 text-sm text-neutral-700 transition-colors hover:border-neutral-400 hover:text-black"
					>
						cancel
					</button>
				</div>
			</form>
		</div>
	);
};

export default NewApp;
