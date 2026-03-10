import {
	Component,
	createEffect,
	createResource,
	createSignal,
	For,
	Show,
} from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";

import { api, components } from "../api";
import EnvVarEditor from "../components/EnvVarEditor";
import ServiceForm, {
	type Service,
	type ServiceType,
	applyServiceType,
	createServiceForType,
	serviceTypeDescription,
	serviceTypeLabel,
} from "../components/ServiceForm";
import {
	type EditableEnvVar,
	mapServiceToRequest,
} from "../utils/projectEditor";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Input,
	PageHeader,
} from "../components/ui";

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
	{ type: "web_service", icon: "public" },
	{ type: "private_service", icon: "private" },
	{ type: "background_worker", icon: "worker" },
	{ type: "cron_job", icon: "cron" },
];

const NewApp: Component = () => {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const [selectedType, setSelectedType] =
		createSignal<ServiceType>("web_service");
	const [service, setService] = createSignal<Service>(
		createServiceForType("web_service"),
	);
	const [githubUrl, setGithubUrl] = createSignal("");
	const [branch, setBranch] = createSignal("main");
	const [useRepoPicker, setUseRepoPicker] = createSignal(true);
	const [repoFilter, setRepoFilter] = createSignal("");
	const [envVars, setEnvVars] = createSignal<EditableEnvVar[]>([]);
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

	createEffect(() => {
		const requestedType = searchParams.service_type;
		if (
			requestedType !== "web_service" &&
			requestedType !== "private_service" &&
			requestedType !== "background_worker" &&
			requestedType !== "cron_job"
		) {
			return;
		}

		if (requestedType !== selectedType()) {
			switchServiceType(requestedType);
		}
	});

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		setError("");
		setLoading(true);

		try {
			const currentService = service();
			if (!currentService.name.trim()) {
				throw new Error("service name is required");
			}
			if (!githubUrl().trim()) {
				throw new Error("repository url is required");
			}

			const { data, error: apiError } = await api.POST("/api/projects", {
				body: {
					name: currentService.name.trim(),
					github_url: githubUrl().trim(),
					branch: branch().trim() || "main",
					env_vars: envVars().length > 0 ? envVars() : null,
					services: [mapServiceToRequest(currentService)],
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
		<form class="space-y-8" onSubmit={handleSubmit}>
			<PageHeader
				eyebrow="create"
				title="new service"
				description="point containr at a repository, choose the service type, and shape the runtime with the same shared editor used after deploy."
				actions={
					<div class="flex items-center gap-3">
						<Button type="submit" isLoading={loading()}>
							create and deploy
						</Button>
					</div>
				}
			/>

			<Show when={error()}>
				<Alert variant="destructive" title="create failed">
					{error()}
				</Alert>
			</Show>

			<Card>
				<CardHeader class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
					<div>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							service type
						</p>
						<CardTitle class="mt-2">choose the runtime shape</CardTitle>
					</div>
					<Badge variant="outline">{serviceTypeLabel(selectedType())}</Badge>
				</CardHeader>
				<CardContent class="grid gap-3 md:grid-cols-3">
					<For each={serviceTypeOptions}>
						{(option) => (
							<button
								type="button"
								onClick={() => switchServiceType(option.type)}
								class={`border p-4 text-left transition-colors ${
									selectedType() === option.type
										? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
										: "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:border-[var(--border-strong)]"
								}`}
							>
								<p class="text-[11px] font-semibold uppercase tracking-[0.22em]">
									{option.icon}
								</p>
								<p class="mt-4 font-serif text-xl">
									{serviceTypeLabel(option.type)}
								</p>
								<p
									class={`mt-3 text-sm leading-6 ${
										selectedType() === option.type
											? "text-[var(--background)]/80"
											: "text-[var(--muted-foreground)]"
									}`}
								>
									{serviceTypeDescription(option.type)}
								</p>
							</button>
						)}
					</For>
				</CardContent>
			</Card>

			<Card>
				<CardHeader class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
					<div>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							source
						</p>
						<CardTitle class="mt-2">repository and branch</CardTitle>
					</div>
					<Show when={hasGithubAccess()}>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={() => setUseRepoPicker(!useRepoPicker())}
						>
							{useRepoPicker() ? "enter url manually" : "pick from github"}
						</Button>
					</Show>
				</CardHeader>
				<CardContent class="space-y-6">
					<Show when={hasGithubAccess() && useRepoPicker()}>
						<div class="space-y-3">
							<Input
								value={repoFilter()}
								onInput={(event) => setRepoFilter(event.currentTarget.value)}
								placeholder="search repositories"
							/>
							<div class="max-h-72 overflow-y-auto border border-[var(--border)]">
								<Show when={githubRepos.loading}>
									<div class="px-4 py-6 text-sm text-[var(--muted-foreground)]">
										loading repositories...
									</div>
								</Show>
								<Show
									when={!githubRepos.loading && filteredRepos().length === 0}
								>
									<div class="px-4 py-6 text-sm text-[var(--muted-foreground)]">
										no repositories found
									</div>
								</Show>
								<For each={filteredRepos()}>
									{(repo) => (
										<button
											type="button"
											onClick={() =>
												applyRepoSelection(repo.clone_url, repo.default_branch)
											}
											class={`flex w-full items-center justify-between border-b border-[var(--border)] px-4 py-3 text-left transition-colors last:border-b-0 ${
												githubUrl() === repo.clone_url
													? "bg-[var(--surface-muted)]"
													: "bg-[var(--card)] hover:bg-[var(--muted)]"
											}`}
										>
											<div>
												<p class="text-sm font-semibold text-[var(--foreground)]">
													{repo.name}
												</p>
												<p class="mt-1 text-xs uppercase tracking-[0.16em] text-[var(--muted-foreground)]">
													{repo.default_branch}
												</p>
											</div>
											<Show when={repo.private}>
												<Badge variant="secondary">private</Badge>
											</Show>
										</button>
									)}
								</For>
							</div>
						</div>
					</Show>

					<Show when={!hasGithubAccess() || !useRepoPicker()}>
						<div class="space-y-2">
							<Input
								label="repository"
								type="url"
								value={githubUrl()}
								onInput={(event) =>
									applyRepoSelection(event.currentTarget.value)
								}
								placeholder="https://github.com/acme/app"
								required
							/>
							<Show when={!hasGithubAccess()}>
								<p class="text-xs text-[var(--muted-foreground)]">
									<a href="/settings" class="underline underline-offset-4">
										set up github app
									</a>{" "}
									to browse and deploy private repositories.
								</p>
							</Show>
						</div>
					</Show>

					<div class="grid gap-4 md:grid-cols-2">
						<Input
							label="service name"
							value={service().name}
							onInput={(event) =>
								setService({ ...service(), name: event.currentTarget.value })
							}
							placeholder="my-api"
							required
						/>
						<Input
							label="branch"
							value={branch()}
							onInput={(event) => setBranch(event.currentTarget.value)}
							placeholder="main"
						/>
					</div>
				</CardContent>
			</Card>

			<EnvVarEditor
				envVars={envVars()}
				onChange={setEnvVars}
				title="shared environment variables"
				description="available to the whole group during runtime"
				emptyText="no shared environment variables configured"
				addLabel="add shared variable"
			/>

			<div class="space-y-4">
				<div class="space-y-2">
					<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
						service definition
					</p>
					<h2 class="font-serif text-2xl text-[var(--foreground)]">
						configure build, runtime, and storage
					</h2>
				</div>
				<ServiceForm
					service={service()}
					index={0}
					allServices={[service()]}
					onUpdate={(_, next) => {
						setSelectedType(next.service_type);
						setService(next);
					}}
					onRemove={() => {}}
					allowRemove={false}
				/>
			</div>
		</form>
	);
};

export default NewApp;
