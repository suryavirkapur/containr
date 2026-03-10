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

type CreationMode = "app" | "database" | "queue";
type ManagedDatabaseType = "postgresql" | "redis" | "mariadb" | "qdrant";
type ManagedQueueType = "rabbitmq";

type GithubAppStatus = components["schemas"]["GithubAppStatusResponse"];
type Project = components["schemas"]["AppResponse"];
type RepoInfo = components["schemas"]["RepoInfo"];

interface ModeOption {
	mode: CreationMode;
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
		mode: "app",
		title: "application service",
		description:
			"create a new group with a web, private, worker, or cron service.",
		badge: "repository",
	},
	{
		mode: "database",
		title: "managed database",
		description:
			"launch postgres, valkey, mariadb, or qdrant and attach it to a group if needed.",
		badge: "managed",
	},
	{
		mode: "queue",
		title: "managed queue",
		description: "launch rabbitmq with the same full-page creation flow.",
		badge: "managed",
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
		description: "internal-only service reachable only from the same group.",
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

const databaseOptions: RuntimeOption[] = [
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
		description: "vector database with direct http access when exposed.",
		icon: "vector",
	},
];

const queueOptions: RuntimeOption[] = [
	{
		value: "rabbitmq",
		label: "rabbitmq",
		description: "managed rabbitmq broker for queues and events.",
		icon: "queue",
	},
];

const selectClass =
	"flex h-11 w-full border px-3 py-2 text-sm font-medium bg-[var(--input)] " +
	"text-[var(--foreground)] border-[var(--border)] focus:border-[var(--ring)] " +
	"focus:outline-none focus:ring-1 focus:ring-[var(--ring)]";

const buildAuthHeaders = (): Headers => {
	const headers = new Headers({
		"Content-Type": "application/json",
	});
	const token = localStorage.getItem("containr_token");

	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}

	return headers;
};

const handleUnauthorized = (response: Response) => {
	if (response.status !== 401) {
		return;
	}

	localStorage.removeItem("containr_token");
	window.location.href = "/login";
};

const readErrorMessage = async (response: Response): Promise<string> => {
	try {
		const data = (await response.json()) as { error?: string };
		if (typeof data.error === "string" && data.error.trim()) {
			return data.error;
		}
	} catch {
		// ignore malformed json and fall back to a generic message below
	}

	return `request failed with status ${response.status}`;
};

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

const managedTypeLabel = (
	mode: CreationMode,
	databaseType: ManagedDatabaseType,
	queueType: ManagedQueueType,
): string => {
	if (mode === "database") {
		return (
			databaseOptions.find((option) => option.value === databaseType)?.label ||
			"managed database"
		);
	}

	if (mode === "queue") {
		return (
			queueOptions.find((option) => option.value === queueType)?.label ||
			"managed queue"
		);
	}

	return "service";
};

const NewApp: Component = () => {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const [mode, setMode] = createSignal<CreationMode>("app");
	const [selectedType, setSelectedType] =
		createSignal<ServiceType>("web_service");
	const [service, setService] = createSignal<Service>(
		createServiceForType("web_service"),
	);
	const [databaseType, setDatabaseType] =
		createSignal<ManagedDatabaseType>("postgresql");
	const [queueType, setQueueType] = createSignal<ManagedQueueType>("rabbitmq");
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
		const requestedKind = searchParams.kind;
		const requestedType = searchParams.type;
		const requestedServiceType = searchParams.service_type;
		const requestedGroupId = searchParams.group_id;

		if (requestedKind === "app") {
			setMode("app");
		} else if (requestedKind === "database") {
			setMode("database");
		} else if (requestedKind === "queue") {
			setMode("queue");
		}

		if (
			requestedServiceType === "web_service" ||
			requestedServiceType === "private_service" ||
			requestedServiceType === "background_worker" ||
			requestedServiceType === "cron_job"
		) {
			setMode("app");
			if (requestedServiceType !== selectedType()) {
				switchServiceType(requestedServiceType);
			}
		}

		if (
			requestedType === "postgres" ||
			requestedType === "postgresql" ||
			requestedType === "redis" ||
			requestedType === "valkey" ||
			requestedType === "mariadb" ||
			requestedType === "mysql" ||
			requestedType === "qdrant"
		) {
			setMode("database");
			switch (requestedType) {
				case "postgres":
				case "postgresql":
					setDatabaseType("postgresql");
					break;
				case "redis":
				case "valkey":
					setDatabaseType("redis");
					break;
				case "mariadb":
				case "mysql":
					setDatabaseType("mariadb");
					break;
				case "qdrant":
					setDatabaseType("qdrant");
					break;
			}
		}

		if (requestedType === "rabbitmq") {
			setMode("queue");
			setQueueType("rabbitmq");
		}

		if (requestedGroupId && requestedGroupId !== selectedGroupId()) {
			setSelectedGroupId(requestedGroupId);
		}
	});

	const pageDescription = createMemo(() => {
		if (mode() === "app") {
			return "create a new group and deploy its first application service from a repository.";
		}

		if (mode() === "database") {
			return "create a managed data service with the same full-page workflow and optionally attach it to an existing group.";
		}

		return "create a managed queue with the same full-page workflow and optionally attach it to an existing group.";
	});

	const submitLabel = createMemo(() => {
		if (mode() === "app") {
			return "create and deploy";
		}

		if (mode() === "database") {
			return "create database";
		}

		return "create queue";
	});

	const runtimeBadge = createMemo(() => {
		if (mode() === "app") {
			return serviceTypeLabel(selectedType());
		}

		return managedTypeLabel(mode(), databaseType(), queueType());
	});

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		setError("");
		setLoading(true);

		try {
			if (mode() === "app") {
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
				return;
			}

			if (!managedName().trim()) {
				throw new Error("service name is required");
			}

			const body = {
				name: managedName().trim(),
				version: managedVersion().trim() || null,
				memory_limit_mb: parseInt(managedMemoryMb(), 10) || 512,
				cpu_limit: parseFloat(managedCpuLimit()) || 1.0,
				group_id: selectedGroupId().trim() || null,
				db_type: mode() === "database" ? databaseType() : undefined,
				queue_type: mode() === "queue" ? queueType() : undefined,
			};

			const endpoint = mode() === "database" ? "/api/databases" : "/api/queues";
			const response = await fetch(endpoint, {
				method: "POST",
				headers: buildAuthHeaders(),
				body: JSON.stringify(body),
			});

			handleUnauthorized(response);
			if (!response.ok) {
				throw new Error(await readErrorMessage(response));
			}

			const data = (await response.json()) as { id: string };
			if (mode() === "database") {
				navigate(`/databases/${data.id}`);
				return;
			}

			navigate(`/queues/${data.id}`);
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
							service family
						</p>
						<CardTitle class="mt-2">choose what you are creating</CardTitle>
					</div>
					<Badge variant="outline">{runtimeBadge()}</Badge>
				</CardHeader>
				<CardContent class="grid gap-3 md:grid-cols-3">
					<For each={modeOptions}>
						{(option) => (
							<button
								type="button"
								onClick={() => setMode(option.mode)}
								class={`border p-4 text-left transition-colors ${
									mode() === option.mode
										? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
										: "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:border-[var(--border-strong)]"
								}`}
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

			<Show when={mode() === "app"}>
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
									class={`border p-4 text-left transition-colors ${
										selectedType() === option.value
											? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
											: "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:border-[var(--border-strong)]"
									}`}
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
													applyRepoSelection(
														repo.clone_url,
														repo.default_branch,
													)
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
			</Show>

			<Show when={mode() === "database" || mode() === "queue"}>
				<Card>
					<CardHeader class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
						<div>
							<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
								runtime
							</p>
							<CardTitle class="mt-2">
								choose the managed service type
							</CardTitle>
						</div>
						<Badge variant="outline">
							{managedTypeLabel(mode(), databaseType(), queueType())}
						</Badge>
					</CardHeader>
					<CardContent
						class={`grid gap-3 ${
							mode() === "database"
								? "md:grid-cols-2 xl:grid-cols-4"
								: "md:grid-cols-1"
						}`}
					>
						<For each={mode() === "database" ? databaseOptions : queueOptions}>
							{(option) => (
								<button
									type="button"
									onClick={() => {
										if (mode() === "database") {
											setDatabaseType(option.value as ManagedDatabaseType);
											return;
										}

										setQueueType(option.value as ManagedQueueType);
									}}
									class={`border p-4 text-left transition-colors ${
										(
											mode() === "database" && databaseType() === option.value
										) || (mode() === "queue" && queueType() === option.value)
											? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
											: "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:border-[var(--border-strong)]"
									}`}
								>
									<p class="text-[11px] font-semibold uppercase tracking-[0.22em]">
										{option.icon}
									</p>
									<p class="mt-4 font-serif text-xl">{option.label}</p>
									<p
										class={`mt-3 text-sm leading-6 ${
											(mode() === "database" &&
												databaseType() === option.value) ||
											(mode() === "queue" && queueType() === option.value)
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
						<CardTitle class="mt-2">attach the service to a group</CardTitle>
					</CardHeader>
					<CardContent class="space-y-4">
						<div class="space-y-2">
							<label
								for="managed-group"
								class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]"
							>
								group
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
							network. attaching it to a group joins the existing group network
							boundary.
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							settings
						</p>
						<CardTitle class="mt-2">configure the managed service</CardTitle>
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
