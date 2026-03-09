import { Component, createResource, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";

import { api, components } from "../api";
import EnvVarEditor from "../components/EnvVarEditor";
import ServiceForm, {
	Service,
	ServiceType,
	createServiceForType,
	serviceTypeDescription,
	serviceTypeLabel,
} from "../components/ServiceForm";
import { EditableEnvVar, mapServiceToRequest } from "../utils/projectEditor";

type GithubAppStatus = components["schemas"]["GithubAppStatusResponse"];
type RepoInfo = components["schemas"]["RepoInfo"];

const serviceTypeOptions: ServiceType[] = [
	"web_service",
	"private_service",
	"background_worker",
];

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

function inferProjectName(sourceUrl: string) {
	const trimmed = sourceUrl.trim();
	if (!trimmed) {
		return "";
	}

	const cleaned = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
	const segments = cleaned.split(/[/:]/).filter(Boolean);
	return segments[segments.length - 1] || "";
}

function nextServiceName(services: Service[], serviceType: ServiceType) {
	const baseName =
		serviceType === "web_service"
			? "web"
			: serviceType === "private_service"
				? "private"
				: "worker";

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
 * render-style project creation flow
 */
const NewApp: Component = () => {
	const navigate = useNavigate();
	const [name, setName] = createSignal("");
	const [githubUrl, setGithubUrl] = createSignal("");
	const [branch, setBranch] = createSignal("main");
	const [services, setServices] = createSignal<Service[]>([]);
	const [envVars, setEnvVars] = createSignal<EditableEnvVar[]>([]);
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);
	const [useRepoPicker, setUseRepoPicker] = createSignal(true);
	const [repoFilter, setRepoFilter] = createSignal("");

	const applyRepoSelection = (repoUrl: string, defaultBranch?: string) => {
		setGithubUrl(repoUrl);
		if (defaultBranch) {
			setBranch(defaultBranch);
		}
		if (!name().trim()) {
			setName(inferProjectName(repoUrl));
		}
	};

	const [githubApp] = createResource(fetchGithubApp);
	const [githubRepos] = createResource(fetchGithubRepos);

	const hasGithubAccess = () => {
		const app = githubApp();
		return app?.configured && (app?.installations?.length ?? 0) > 0;
	};

	const filteredRepos = () => {
		const repos = githubRepos() || [];
		const filter = repoFilter().toLowerCase();
		if (!filter) {
			return repos;
		}

		return repos.filter(
			(repo) =>
				repo.name.toLowerCase().includes(filter) ||
				repo.full_name.toLowerCase().includes(filter),
		);
	};

	const addService = (serviceType: ServiceType) => {
		const nextService = createServiceForType(serviceType);
		nextService.name = nextServiceName(services(), serviceType);
		setServices([...services(), nextService]);
	};

	const updateService = (index: number, service: Service) => {
		const updated = [...services()];
		updated[index] = service;
		setServices(updated);
	};

	const removeService = (index: number) => {
		setServices(services().filter((_, serviceIndex) => serviceIndex !== index));
	};

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		setError("");
		setLoading(true);

		try {
			if (services().length === 0) {
				throw new Error("add at least one service");
			}

			const { data, error: apiError } = await api.POST("/api/projects", {
				body: {
					name: name().trim(),
					github_url: githubUrl().trim(),
					branch: branch().trim() || "main",
					env_vars: envVars().length > 0 ? envVars() : null,
					services: services().map(mapServiceToRequest),
				},
			});

			if (apiError) {
				throw apiError;
			}

			navigate(`/projects/${data.id}`);
		} catch (err: any) {
			setError(err?.error || err?.message || "failed to create group");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div class="mx-auto max-w-5xl">
			<div class="mb-10">
				<h1 class="text-2xl font-serif text-black">new group</h1>
				<p class="mt-1 text-sm text-neutral-500">
					create a render-style service group from a repository, choose service
					types, and deploy immediately
				</p>
			</div>

			<Show when={error()}>
				<div class="mb-6 border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
					{error()}
				</div>
			</Show>

			<form onSubmit={handleSubmit} class="space-y-8">
				<section class="border border-neutral-200 bg-white p-6">
					<div class="mb-6 flex flex-wrap items-start justify-between gap-4">
						<div>
							<h2 class="text-sm font-serif text-black">source</h2>
							<p class="mt-1 text-xs text-neutral-500">
								point the group at a repository and branch, then containr builds
								and deploys it on create
							</p>
						</div>
						<Show when={hasGithubAccess()}>
							<button
								type="button"
								onClick={() => setUseRepoPicker(!useRepoPicker())}
								class="border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-400"
							>
								{useRepoPicker() ? "enter url manually" : "pick from github"}
							</button>
						</Show>
					</div>

					<div class="grid gap-4 md:grid-cols-2">
						<div>
							<label class="mb-2 block text-sm text-neutral-600">
								group name
							</label>
							<input
								type="text"
								value={name()}
								onInput={(event) => setName(event.currentTarget.value)}
								class="w-full border border-neutral-300 bg-white px-3 py-2.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
								placeholder="acme-platform"
								required
							/>
						</div>

						<div>
							<label class="mb-2 block text-sm text-neutral-600">branch</label>
							<input
								type="text"
								value={branch()}
								onInput={(event) => setBranch(event.currentTarget.value)}
								class="w-full border border-neutral-300 bg-white px-3 py-2.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
								placeholder="main"
							/>
						</div>
					</div>

					<div class="mt-4">
						<label class="mb-2 block text-sm text-neutral-600">
							repository
						</label>
						<Show when={hasGithubAccess() && useRepoPicker()}>
							<div class="border border-neutral-300">
								<div class="border-b border-neutral-200 p-2">
									<input
										type="text"
										value={repoFilter()}
										onInput={(event) =>
											setRepoFilter(event.currentTarget.value)
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
										when={!githubRepos.loading && filteredRepos().length === 0}
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
												class={`flex w-full items-center justify-between border-b border-neutral-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-neutral-50 ${
													githubUrl() === repo.clone_url ? "bg-neutral-100" : ""
												}`}
											>
												<div>
													<span class="text-black">{repo.name}</span>
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
								onInput={(event) =>
									applyRepoSelection(event.currentTarget.value)
								}
								class="w-full border border-neutral-300 bg-white px-3 py-2.5 text-sm text-black placeholder-neutral-400 focus:border-black focus:outline-none"
								placeholder="https://github.com/acme/app"
								required
							/>
							<Show when={!hasGithubAccess()}>
								<p class="mt-1.5 text-xs text-neutral-400">
									<a href="/settings" class="underline hover:text-black">
										set up github app
									</a>{" "}
									to browse and deploy private repositories
								</p>
							</Show>
						</Show>
					</div>
				</section>

				<section class="border border-neutral-200 bg-white p-6">
					<div class="mb-6">
						<h2 class="text-sm font-serif text-black">services</h2>
						<p class="mt-1 text-xs text-neutral-500">
							add one or more services the same way Render distinguishes web
							services, private services, and background workers
						</p>
					</div>

					<div class="grid gap-3 md:grid-cols-3">
						<For each={serviceTypeOptions}>
							{(serviceType) => (
								<button
									type="button"
									onClick={() => addService(serviceType)}
									class="border border-neutral-200 px-4 py-4 text-left transition-colors hover:border-black"
								>
									<p class="text-xs uppercase tracking-wide text-neutral-500">
										add {serviceTypeLabel(serviceType)}
									</p>
									<p class="mt-2 text-sm text-black">
										{serviceTypeDescription(serviceType)}
									</p>
								</button>
							)}
						</For>
					</div>

					<p class="mt-3 text-xs text-neutral-400">
						every web service gets its own generated service subdomain. add
						custom domains inside each web service card.
					</p>

					<Show when={services().length === 0}>
						<div class="mt-4 border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">
							start by choosing a service type above
						</div>
					</Show>

					<div class="mt-4">
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
					</div>
				</section>

				<section class="border border-neutral-200 bg-white p-6">
					<div class="mb-6">
						<h2 class="text-sm font-serif text-black">advanced</h2>
						<p class="mt-1 text-xs text-neutral-500">
							shared configuration applied across the group
						</p>
					</div>

					<div class="space-y-6">
						<EnvVarEditor
							envVars={envVars()}
							onChange={setEnvVars}
							title="shared environment"
							description="available to every service in the group"
							emptyText="no shared environment variables configured"
							addLabel="add shared variable"
						/>
					</div>
				</section>

				<div class="flex gap-3">
					<button
						type="submit"
						disabled={loading()}
						class="flex-1 bg-black px-4 py-2.5 text-sm text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{loading() ? "creating and deploying..." : "create group"}
					</button>
					<button
						type="button"
						onClick={() => navigate("/projects")}
						class="border border-neutral-300 px-4 py-2.5 text-sm text-neutral-700 transition-colors hover:border-neutral-400 hover:text-black"
					>
						cancel
					</button>
				</div>
			</form>
		</div>
	);
};

export default NewApp;
