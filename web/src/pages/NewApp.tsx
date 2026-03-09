import { Component, createSignal, createResource, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import ServiceForm, {
	Service,
	createEmptyService,
} from "../components/ServiceForm";
import EnvVarEditor from "../components/EnvVarEditor";
import { api, components } from "../api";
import {
	EditableEnvVar,
	ensureSinglePublicHttpService,
	mapServiceToRequest,
} from "../utils/projectEditor";

type GithubAppStatus = components["schemas"]["GithubAppStatusResponse"];
type RepoInfo = components["schemas"]["RepoInfo"];

// fetch github app status
const fetchGithubApp = async (): Promise<GithubAppStatus> => {
	try {
		const { data, error } = await api.GET("/api/github/app");
		if (error) throw error;
		return data;
	} catch {
		return { configured: false, app: null, installations: [] };
	}
};

// fetch github app repos
const fetchGithubRepos = async (): Promise<RepoInfo[]> => {
	try {
		const { data, error } = await api.GET("/api/github/app/repos");
		if (error) throw error;
		return data.repos || [];
	} catch {
		return [];
	}
};

/**
 * new project creation page with multi-service support
 */
const NewApp: Component = () => {
	const [name, setName] = createSignal("");
	const [githubUrl, setGithubUrl] = createSignal("");
	const [branch, setBranch] = createSignal("main");
	const [domainsText, setDomainsText] = createSignal("");
	const [useMultiService, setUseMultiService] = createSignal(false);
	const [port, setPort] = createSignal("8080");
	const [singleContainerReplicas, setSingleContainerReplicas] =
		createSignal("1");
	const [services, setServices] = createSignal<Service[]>([]);
	const [envVars, setEnvVars] = createSignal<EditableEnvVar[]>([]);
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);
	const [useRepoPicker, setUseRepoPicker] = createSignal(true);
	const [repoFilter, setRepoFilter] = createSignal("");
	const navigate = useNavigate();

	const parseDomains = (value: string) => {
		const entries = value
			.split(/[\n,]+/)
			.map((entry) => entry.trim())
			.filter(Boolean);
		return Array.from(new Set(entries));
	};

	// github resources
	const [githubApp] = createResource(fetchGithubApp);
	const [githubRepos] = createResource(fetchGithubRepos);

	// check if github app has installations
	const hasGithubAccess = () => {
		const app = githubApp();
		return app?.configured && (app?.installations?.length ?? 0) > 0;
	};

	// filter repos
	const filteredRepos = () => {
		const repos = githubRepos() || [];
		const filter = repoFilter().toLowerCase();
		if (!filter) return repos;
		return repos.filter(
			(r) =>
				r.name.toLowerCase().includes(filter) ||
				r.full_name.toLowerCase().includes(filter),
		);
	};

	// handle repo selection
	const selectRepo = (repo: RepoInfo) => {
		setGithubUrl(repo.clone_url);
		setBranch(repo.default_branch);
	};

	const addService = () => {
		const currentServices = services();
		const service = createEmptyService();
		if (!currentServices.some((entry) => entry.expose_http)) {
			service.expose_http = true;
		}
		setServices([...currentServices, service]);
	};

	const updateService = (index: number, service: Service) => {
		const updated = [...services()];
		updated[index] = service;
		setServices(ensureSinglePublicHttpService(updated));
	};

	const removeService = (index: number) => {
		setServices(
			ensureSinglePublicHttpService(services().filter((_, i) => i !== index)),
		);
	};

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		setError("");
		setLoading(true);

		try {
			const domains = parseDomains(domainsText());
			const parsedPort = parseInt(port()) || 8080;
			const parsedReplicas = Math.max(
				1,
				parseInt(singleContainerReplicas()) || 1,
			);
			// build request body
			const body: any = {
				name: name(),
				github_url: githubUrl(),
				branch: branch() || "main",
				domains,
				domain: domains[0] || null,
			};
			if (envVars().length > 0) {
				body.env_vars = envVars();
			}

			if (useMultiService()) {
				if (services().length === 0) {
					throw new Error("add at least one service");
				}
				body.services = ensureSinglePublicHttpService(services()).map(
					mapServiceToRequest,
				);
			} else {
				if (parsedReplicas > 1) {
					body.services = [
						{
							name: "web",
							image: null,
							port: parsedPort,
							expose_http: true,
							additional_ports: null,
							replicas: parsedReplicas,
							memory_limit_mb: null,
							cpu_limit: null,
							depends_on: null,
							health_check: null,
							restart_policy: "always",
							registry_auth: null,
							command: null,
							entrypoint: null,
							working_dir: null,
							mounts: null,
						},
					];
				} else {
					// single-container mode (backward compat)
					body.port = parsedPort;
				}
			}

			const { data, error: apiError } = await api.POST("/api/projects", {
				body,
			});
			if (apiError) throw new Error("failed to create project");
			navigate(`/projects/${data.id}`);
		} catch (err: any) {
			setError(err.message);
		} finally {
			setLoading(false);
		}
	};

	return (
		<div class="max-w-2xl mx-auto">
			{/* header */}
			<div class="mb-10">
				<h1 class="text-2xl font-serif text-black">create new project</h1>
				<p class="text-neutral-500 mt-1 text-sm">
					connect a repository and define the services that belong to this
					project
				</p>
			</div>

			{/* form */}
			<div class="border border-neutral-200 p-8">
				{error() && (
					<div class="border border-neutral-300 bg-neutral-50 text-neutral-700 px-4 py-3 mb-6 text-sm">
						{error()}
					</div>
				)}

				<form onSubmit={handleSubmit} class="space-y-6">
					{/* project name */}
					<div>
						<label class="block text-neutral-600 text-sm mb-2">
							project name
						</label>
						<input
							type="text"
							value={name()}
							onInput={(e) => setName(e.currentTarget.value)}
							class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
							placeholder="my-awesome-project"
							required
						/>
						<p class="mt-1.5 text-xs text-neutral-400">
							lowercase letters, numbers, and hyphens only
						</p>
					</div>

					{/* repository source */}
					<div>
						<div class="flex items-center justify-between mb-2">
							<label class="text-neutral-600 text-sm">repository</label>
							<Show when={hasGithubAccess()}>
								<button
									type="button"
									onClick={() => setUseRepoPicker(!useRepoPicker())}
									class="text-xs text-neutral-500 hover:text-black"
								>
									{useRepoPicker() ? "enter url manually" : "pick from github"}
								</button>
							</Show>
						</div>

						{/* repo picker mode */}
						<Show when={hasGithubAccess() && useRepoPicker()}>
							<div class="border border-neutral-300">
								<div class="p-2 border-b border-neutral-200">
									<input
										type="text"
										value={repoFilter()}
										onInput={(e) => setRepoFilter(e.currentTarget.value)}
										placeholder="search repositories..."
										class="w-full px-2 py-1.5 text-sm border border-neutral-200 focus:outline-none focus:border-neutral-400"
									/>
								</div>
								<div class="max-h-48 overflow-y-auto">
									<Show when={githubRepos.loading}>
										<div class="p-4 text-center text-neutral-400 text-sm">
											loading repos...
										</div>
									</Show>
									<Show
										when={!githubRepos.loading && filteredRepos().length === 0}
									>
										<div class="p-4 text-center text-neutral-400 text-sm">
											no repos found
										</div>
									</Show>
									<For each={filteredRepos()}>
										{(repo) => (
											<button
												type="button"
												onClick={() => selectRepo(repo)}
												class={`w-full px-3 py-2 text-left text-sm hover:bg-neutral-50 flex items-center justify-between border-b border-neutral-100 last:border-0 ${githubUrl() === repo.clone_url ? "bg-neutral-100" : ""}`}
											>
												<div>
													<span class="text-black">{repo.name}</span>
													<span class="text-neutral-400 ml-2 text-xs">
														{repo.default_branch}
													</span>
												</div>
												<Show when={repo.private}>
													<span class="text-xs px-1.5 py-0.5 bg-neutral-200 text-neutral-600">
														private
													</span>
												</Show>
											</button>
										)}
									</For>
								</div>
							</div>
							<Show when={githubUrl()}>
								<p class="text-xs text-neutral-500 mt-2 font-mono">
									selected: {githubUrl()}
								</p>
							</Show>
						</Show>

						{/* manual url mode */}
						<Show when={!hasGithubAccess() || !useRepoPicker()}>
							<input
								type="url"
								value={githubUrl()}
								onInput={(e) => setGithubUrl(e.currentTarget.value)}
								class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
								placeholder="https://git.example.com/team/repo"
								required
							/>
							<Show when={!hasGithubAccess()}>
								<p class="text-xs text-neutral-400 mt-1.5">
									<a href="/settings" class="underline hover:text-black">
										set up github app
									</a>{" "}
									to access private repos
								</p>
							</Show>
						</Show>
					</div>

					{/* branch */}
					<div>
						<label class="block text-neutral-600 text-sm mb-2">branch</label>
						<input
							type="text"
							value={branch()}
							onInput={(e) => setBranch(e.currentTarget.value)}
							class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
							placeholder="main"
						/>
					</div>

					{/* domains */}
					<div>
						<label class="block text-neutral-600 text-sm mb-2">
							custom domains <span class="text-neutral-400">(optional)</span>
						</label>
						<textarea
							rows={3}
							value={domainsText()}
							onInput={(e) => setDomainsText(e.currentTarget.value)}
							class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm font-mono"
							placeholder="app.example.com&#10;www.app.example.com"
						/>
						<p class="mt-1.5 text-xs text-neutral-400">
							one per line or comma-separated. tls is provisioned automatically
							and http will be refused until ready
						</p>
					</div>

					<EnvVarEditor envVars={envVars()} onChange={setEnvVars} />

					{/* multi-service toggle */}
					<div class="border-t border-neutral-100 pt-6">
						<label class="flex items-center gap-3 cursor-pointer">
							<input
								type="checkbox"
								checked={useMultiService()}
								onChange={(e) => {
									setUseMultiService(e.currentTarget.checked);
									if (e.currentTarget.checked && services().length === 0) {
										addService();
									}
								}}
								class="w-4 h-4"
							/>
							<div>
								<span class="text-sm text-black">multi-service project</span>
								<p class="text-xs text-neutral-400">
									group multiple services with shared deploy settings
								</p>
							</div>
						</label>
					</div>

					{/* single container mode */}
					<Show when={!useMultiService()}>
						<div>
							<div class="grid grid-cols-2 gap-4">
								<div>
									<label class="block text-neutral-600 text-sm mb-2">
										application port
									</label>
									<input
										type="number"
										value={port()}
										onInput={(e) => setPort(e.currentTarget.value)}
										class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
										placeholder="8080"
									/>
									<p class="mt-1.5 text-xs text-neutral-400">
										the port your main service listens on inside the container
									</p>
								</div>
								<div>
									<label class="block text-neutral-600 text-sm mb-2">
										instance count
									</label>
									<input
										type="number"
										min="1"
										max="10"
										value={singleContainerReplicas()}
										onInput={(e) =>
											setSingleContainerReplicas(e.currentTarget.value)
										}
										class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
										placeholder="1"
									/>
									<p class="mt-1.5 text-xs text-neutral-400">
										values above 1 are deployed as a replicated `web` service.
									</p>
								</div>
							</div>
						</div>
					</Show>

					{/* multi-service mode */}
					<Show when={useMultiService()}>
						<div>
							<div class="flex justify-between items-center mb-4">
								<label class="text-sm text-neutral-600">services</label>
								<button
									type="button"
									onClick={addService}
									class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
								>
									+ add service
								</button>
							</div>

							<For each={services()}>
								{(service, index) => (
									<ServiceForm
										service={service}
										index={index()}
										allServices={services()}
										onUpdate={updateService}
										onRemove={removeService}
									/>
								)}
							</For>

							<Show when={services().length === 0}>
								<div class="text-center py-8 text-neutral-400 text-sm border border-dashed border-neutral-200">
									no services added. click "add service" to start.
								</div>
							</Show>
						</div>
					</Show>

					{/* submit */}
					<div class="flex gap-3 pt-2">
						<button
							type="submit"
							disabled={loading()}
							class="flex-1 px-4 py-2.5 bg-black text-white hover:bg-neutral-800 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
						>
							{loading() ? "creating..." : "create project"}
						</button>
						<button
							type="button"
							onClick={() => navigate("/projects")}
							class="px-4 py-2.5 border border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400 transition-colors text-sm"
						>
							cancel
						</button>
					</div>
				</form>
			</div>
		</div>
	);
};

export default NewApp;
