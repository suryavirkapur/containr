import {
	Component,
	createEffect,
	createMemo,
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
import {
	type EditableEnvVar,
	mapServiceToRequest,
} from "../utils/projectEditor";

type CreationSource = "git_repository" | "template";
type TemplateType = "postgresql" | "redis" | "mariadb" | "qdrant" | "rabbitmq";

type GithubAppStatus = components["schemas"]["GithubAppStatusResponse"];
type Project = components["schemas"]["AppResponse"];
type RepoInfo = components["schemas"]["RepoInfo"];

interface ModeOption {
	mode: CreationSource;
	title: string;
	description: string;
	badge: string;
}

interface RuntimeOption {
	value: string;
	label: string;
	description: string;
	icon: string;
}

const modeOptions: ModeOption[] = [
	{
		mode: "git_repository",
		title: "git repository",
		description:
			"build a service from a repository and choose the runtime shape.",
		badge: "repository",
	},
	{
		mode: "template",
		title: "service template",
		description:
			"launch postgres, valkey, mariadb, qdrant, or rabbitmq from a template.",
		badge: "template",
	},
];

const appServiceOptions: RuntimeOption[] = [
	{
		value: "web_service",
		label: "web service",
		description: "public http and grpc service behind the containr proxy.",
		icon: "public",
	},
	{
		value: "private_service",
		label: "private service",
		description: "internal-only service inside the same service network.",
		icon: "private",
	},
	{
		value: "background_worker",
		label: "background worker",
		description: "long-running worker without public ingress.",
		icon: "worker",
	},
	{
		value: "cron_job",
		label: "cron job",
		description: "scheduled job service with a cron expression.",
		icon: "cron",
	},
];

const templateOptions: RuntimeOption[] = [
	{
		value: "postgresql",
		label: "containr postgres",
		description: "managed postgres with pgdog and optional pitr.",
		icon: "postgres",
	},
	{
		value: "redis",
		label: "containr valkey",
		description: "redis-compatible valkey for caches and workers.",
		icon: "valkey",
	},
	{
		value: "mariadb",
		label: "containr mariadb",
		description: "mysql-compatible mariadb service.",
		icon: "mariadb",
	},
	{
		value: "qdrant",
		label: "containr qdrant",
		description: "vector service with direct http access when exposed.",
		icon: "vector",
	},
	{
		value: "rabbitmq",
		label: "rabbitmq",
		description: "managed rabbitmq broker for queues, events, and workers.",
		icon: "queue",
	},
];

const selectClass =
	"flex h-11 w-full rounded-[var(--radius)] border px-3 py-2 text-sm " +
	"font-medium bg-[var(--input)] text-[var(--foreground)] " +
	"border-[var(--border)] focus:border-[var(--ring)] focus:outline-none " +
	"focus:ring-1 focus:ring-[var(--ring)]";

const selectionCardClass = (selected: boolean): string =>
	`rounded-[var(--radius)] border p-4 text-left transition-colors ${
		selected
			? "border-[var(--foreground)] bg-[var(--foreground)] " +
				"text-[var(--background)]"
			: "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] " +
				"hover:border-[var(--border-strong)]"
	}`;

const repoButtonClass = (selected: boolean): string =>
	"flex w-full items-center justify-between border-b border-[var(--border)] " +
	`px-4 py-3 text-left transition-colors last:border-b-0 ${
		selected
			? "bg-[var(--surface-muted)]"
			: "bg-[var(--card)] hover:bg-[var(--muted)]"
	}`;

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

const fetchProjects = async (): Promise<Project[]> => {
	try {
		const { data, error } = await api.GET("/api/projects");
		if (error) throw error;
		return data ?? [];
	} catch {
		return [];
	}
};

const inferServiceName = (sourceUrl: string): string => {
	const trimmed = sourceUrl.trim();
	if (!trimmed) return "";
	const cleaned = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
	const segments = cleaned.split(/[/:]/).filter(Boolean);
	return segments[segments.length - 1] || "";
};

const searchParamValue = (
	value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

const templateLabel = (templateType: TemplateType): string =>
	templateOptions.find((option) => option.value === templateType)?.label ||
	"template service";

const NewApp: Component = () => {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const [mode, setMode] = createSignal<CreationSource>("git_repository");
	const [selectedType, setSelectedType] =
		createSignal<ServiceType>("web_service");
	const [service, setService] = createSignal<Service>(
		createServiceForType("web_service"),
	);
	const [templateType, setTemplateType] =
		createSignal<TemplateType>("postgresql");
	const [selectedGroupId, setSelectedGroupId] = createSignal("");
	const [managedName, setManagedName] = createSignal("");
	const [managedVersion, setManagedVersion] = createSignal("");
	const [managedMemoryMb, setManagedMemoryMb] = createSignal("512");
	const [managedCpuLimit, setManagedCpuLimit] = createSignal("1.0");
	const [githubUrl, setGithubUrl] = createSignal("");
	const [branch, setBranch] = createSignal("main");
	const [useRepoPicker, setUseRepoPicker] = createSignal(true);
	const [repoFilter, setRepoFilter] = createSignal("");
	const [envVars, setEnvVars] = createSignal<EditableEnvVar[]>([]);
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);

	const [githubApp] = createResource(fetchGithubApp);
	const [githubRepos] = createResource(fetchGithubRepos);
	const [projects] = createResource(fetchProjects);

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
		const requestedSource = searchParamValue(searchParams.source);
		const requestedTemplate = searchParamValue(searchParams.template);
		const requestedServiceType = searchParamValue(searchParams.service_type);
		const requestedGroupId = searchParamValue(searchParams.group_id);

		if (requestedSource === "template") {
			setMode("template");
		}

		if (
			requestedServiceType === "web_service" ||
			requestedServiceType === "private_service" ||
			requestedServiceType === "background_worker" ||
			requestedServiceType === "cron_job"
		) {
			setMode("git_repository");
			switchServiceType(requestedServiceType);
		}

		if (
			requestedTemplate === "postgresql" ||
			requestedTemplate === "redis" ||
			requestedTemplate === "mariadb" ||
			requestedTemplate === "qdrant" ||
			requestedTemplate === "rabbitmq"
		) {
			setMode("template");
			setTemplateType(requestedTemplate);
		}

		if (requestedGroupId) {
			setSelectedGroupId(requestedGroupId);
		}
	});

	const pageDescription = createMemo(() => {
		if (mode() === "git_repository") {
			return "select a repository first, then choose the runtime shape for the service.";
		}

		return "select a template first, then attach the service to an existing service network or keep it standalone.";
	});

	const submitLabel = createMemo(() =>
		mode() === "git_repository" ? "create and deploy" : "create service",
	);

	const runtimeBadge = createMemo(() => {
		if (mode() === "git_repository") {
			return serviceTypeLabel(selectedType());
		}

		return templateLabel(templateType());
	});

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		setError("");
		setLoading(true);

		try {
			if (mode() === "git_repository") {
				const currentService = service();
				if (!currentService.name.trim()) {
					throw new Error("service name is required");
				}
				if (!githubUrl().trim()) {
					throw new Error("repository url is required");
				}

				const { data, error: apiError } = await api.POST("/api/services", {
					body: {
						source: "git_repository",
						name: currentService.name.trim(),
						github_url: githubUrl().trim(),
						branch: branch().trim() || "main",
						env_vars: envVars().length > 0 ? envVars() : null,
						service: mapServiceToRequest(currentService),
					},
				});

				if (apiError) {
					throw apiError;
				}

				navigate(`/services/${data.id}`);
				return;
			}

			if (!managedName().trim()) {
				throw new Error("service name is required");
			}

			const { data, error: apiError } = await api.POST("/api/services", {
				body: {
					source: "template",
					name: managedName().trim(),
					template: templateType(),
					version: managedVersion().trim() || null,
					memory_limit_mb: parseInt(managedMemoryMb(), 10) || 512,
					cpu_limit: parseFloat(managedCpuLimit()) || 1.0,
					group_id: selectedGroupId().trim() || null,
				},
			});
			if (apiError) {
				throw apiError;
			}

			navigate(`/services/${data.id}`);
		} catch (err) {
			if (err instanceof Error) {
				setError(err.message);
			} else if (
				typeof err === "object" &&
				err !== null &&
				"error" in err &&
				typeof err.error === "string"
			) {
				setError(err.error);
			} else {
				setError("failed to create service");
			}
		} finally {
			setLoading(false);
		}
	};

	return (
		<form class="space-y-8" onSubmit={handleSubmit}>
			<PageHeader
				eyebrow="create"
				title="new service"
				description={pageDescription()}
				actions={
					<div class="flex items-center gap-3">
						<Button type="submit" isLoading={loading()}>
							{submitLabel()}
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
							source
						</p>
						<CardTitle class="mt-2">choose how this service starts</CardTitle>
					</div>
					<Badge variant="outline">{runtimeBadge()}</Badge>
				</CardHeader>
				<CardContent class="grid gap-3 md:grid-cols-2">
					<For each={modeOptions}>
						{(option) => (
							<button
								type="button"
								onClick={() => setMode(option.mode)}
								class={selectionCardClass(mode() === option.mode)}
							>
								<p class="text-[11px] font-semibold uppercase tracking-[0.22em]">
									{option.badge}
								</p>
								<p class="mt-4 font-serif text-xl">{option.title}</p>
								<p
									class={`mt-3 text-sm leading-6 ${
										mode() === option.mode
											? "text-[var(--background)]/80"
											: "text-[var(--muted-foreground)]"
									}`}
								>
									{option.description}
								</p>
							</button>
						)}
					</For>
				</CardContent>
			</Card>

			<Show when={mode() === "git_repository"}>
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
					<CardContent class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
						<For each={appServiceOptions}>
							{(option) => (
								<button
									type="button"
									onClick={() => switchServiceType(option.value as ServiceType)}
									class={selectionCardClass(selectedType() === option.value)}
								>
									<p class="text-[11px] font-semibold uppercase tracking-[0.22em]">
										{option.icon}
									</p>
									<p class="mt-4 font-serif text-xl">{option.label}</p>
									<p
										class={`mt-3 text-sm leading-6 ${
											selectedType() === option.value
												? "text-[var(--background)]/80"
												: "text-[var(--muted-foreground)]"
										}`}
									>
										{serviceTypeDescription(option.value as ServiceType)}
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
								<div class="max-h-72 overflow-y-auto rounded-[var(--radius)] border border-[var(--border)]">
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
													applyRepoSelection(
														repo.clone_url,
														repo.default_branch,
													)
												}
												class={repoButtonClass(githubUrl() === repo.clone_url)}
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
									placeholder="https://github.com/acme/service"
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
									setService({
										...service(),
										name: event.currentTarget.value,
									})
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
					description="available to the whole service network during runtime"
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
						showServiceTypePicker={false}
						onUpdate={(_, next) => {
							setSelectedType(next.service_type);
							setService(next);
						}}
						onRemove={() => {}}
						allowRemove={false}
					/>
				</div>
			</Show>

			<Show when={mode() === "template"}>
				<Card>
					<CardHeader class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
						<div>
							<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
								template
							</p>
							<CardTitle class="mt-2">choose the service template</CardTitle>
						</div>
						<Badge variant="outline">{templateLabel(templateType())}</Badge>
					</CardHeader>
					<CardContent class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
						<For each={templateOptions}>
							{(option) => (
								<button
									type="button"
									onClick={() => setTemplateType(option.value as TemplateType)}
									class={selectionCardClass(templateType() === option.value)}
								>
									<p class="text-[11px] font-semibold uppercase tracking-[0.22em]">
										{option.icon}
									</p>
									<p class="mt-4 font-serif text-xl">{option.label}</p>
									<p
										class={`mt-3 text-sm leading-6 ${
											templateType() === option.value
												? "text-[var(--background)]/80"
												: "text-[var(--muted-foreground)]"
										}`}
									>
										{option.description}
									</p>
								</button>
							)}
						</For>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							placement
						</p>
						<CardTitle class="mt-2">
							attach the service to a service network
						</CardTitle>
					</CardHeader>
					<CardContent class="space-y-4">
						<div class="space-y-2">
							<label
								for="managed-group"
								class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]"
							>
								service network
							</label>
							<select
								id="managed-group"
								value={selectedGroupId()}
								onChange={(event) =>
									setSelectedGroupId(event.currentTarget.value)
								}
								class={selectClass}
							>
								<option value="">standalone service</option>
								<For each={projects() || []}>
									{(project) => (
										<option value={project.id}>{project.name}</option>
									)}
								</For>
							</select>
						</div>
						<p class="text-sm text-[var(--muted-foreground)]">
							if you leave this empty, the service gets its own private docker
							network. attaching it to a service network joins the existing
							shared boundary.
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							settings
						</p>
						<CardTitle class="mt-2">configure the template service</CardTitle>
					</CardHeader>
					<CardContent class="grid gap-4 md:grid-cols-2">
						<Input
							label="service name"
							value={managedName()}
							onInput={(event) => setManagedName(event.currentTarget.value)}
							placeholder="primary-db"
							required
						/>
						<Input
							label="version"
							value={managedVersion()}
							onInput={(event) => setManagedVersion(event.currentTarget.value)}
							placeholder="leave empty for default"
						/>
						<Input
							label="memory limit (mb)"
							type="number"
							value={managedMemoryMb()}
							onInput={(event) => setManagedMemoryMb(event.currentTarget.value)}
						/>
						<Input
							label="cpu limit"
							type="number"
							step="0.1"
							value={managedCpuLimit()}
							onInput={(event) => setManagedCpuLimit(event.currentTarget.value)}
						/>
					</CardContent>
				</Card>
			</Show>
		</form>
	);
};

export default NewApp;
