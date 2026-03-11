import { Component, createEffect, createResource, createSignal, For, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { api, components } from "../api";
import {
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
	applyServiceType,
	createServiceForType,
	ServiceType,
	serviceTypeLabel,
} from "../components/ServiceForm";

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

const searchParamValue = (value: string | string[] | undefined): string | undefined =>
	Array.isArray(value) ? value[0] : value;

const repoButtonClass = (selected: boolean): string =>
	"flex w-full items-center justify-between border-b border-[var(--border)] " +
	`px-4 py-3 text-left transition-colors last:border-b-0 ${
		selected ? "bg-[var(--surface-muted)]" : "bg-[var(--card)] hover:bg-[var(--muted)]"
	}`;

const CreateRepo: Component = () => {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();

	const [selectedType, setSelectedType] = createSignal<ServiceType>("web_service");
	const [githubUrl, setGithubUrl] = createSignal("");
	const [useRepoPicker, setUseRepoPicker] = createSignal(true);
	const [repoFilter, setRepoFilter] = createSignal("");
	const [error, setError] = createSignal("");

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
				repo.name.toLowerCase().includes(filter) || repo.full_name.toLowerCase().includes(filter),
		);
	};

	createEffect(() => {
		const requestedServiceType = searchParamValue(searchParams.type);

		if (
			requestedServiceType === "web_service" ||
			requestedServiceType === "private_service" ||
			requestedServiceType === "background_worker" ||
			requestedServiceType === "cron_job"
		) {
			setSelectedType(requestedServiceType as ServiceType);
		}
	});

	const handleSelectRepo = (repoUrl: string, defaultBranch?: string) => {
		const targetUrl = new URL(window.location.origin + "/services/new/configure");
		targetUrl.searchParams.set("type", selectedType());
		targetUrl.searchParams.set("repo", repoUrl);
		if (defaultBranch) {
			targetUrl.searchParams.set("branch", defaultBranch);
		}
		navigate(targetUrl.pathname + targetUrl.search);
	};

	const handleSubmitManualUrl = (e: Event) => {
		e.preventDefault();
		if (!githubUrl().trim()) {
			setError("Please enter a valid repository URL");
			return;
		}
		handleSelectRepo(githubUrl().trim());
	};

	return (
		<div class="mx-auto max-w-3xl space-y-8">
			<PageHeader
				eyebrow="create"
				title={`new ${serviceTypeLabel(selectedType())}`}
				description="connect your repository to begin."
			/>

			<Show when={error()}>
				<div class="rounded-md border border-red-500 bg-red-500/10 p-4 text-sm text-red-500">
					{error()}
				</div>
			</Show>

			<Card>
				<CardHeader class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
					<div>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							source
						</p>
						<CardTitle class="mt-2">connect a repository</CardTitle>
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
							<div class="max-h-96 overflow-y-auto rounded-[var(--radius)] border border-[var(--border)]">
								<Show when={githubRepos.loading}>
									<div class="px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
										loading repositories...
									</div>
								</Show>
								<Show when={!githubRepos.loading && filteredRepos().length === 0}>
									<div class="px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
										no repositories found
									</div>
								</Show>
								<For each={filteredRepos()}>
									{(repo) => (
										<button
											type="button"
											onClick={() => handleSelectRepo(repo.clone_url, repo.default_branch)}
											class={repoButtonClass(githubUrl() === repo.clone_url)}
										>
											<div class="flex items-center gap-3">
												<svg
													class="h-5 w-5 text-[var(--muted-foreground)]"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
												>
													<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
													<path d="M9 18c-4.51 2-5-2-7-2" />
												</svg>
												<div>
													<p class="text-sm font-semibold text-[var(--foreground)]">{repo.name}</p>
													<p class="mt-1 text-xs text-[var(--muted-foreground)]">
														{repo.full_name}
													</p>
												</div>
											</div>
											<div class="flex items-center gap-3">
												<p class="text-xs uppercase tracking-[0.16em] text-[var(--muted-foreground)]">
													{repo.default_branch}
												</p>
												<Show when={repo.private}>
													<Badge variant="secondary">private</Badge>
												</Show>
											</div>
										</button>
									)}
								</For>
							</div>
						</div>
					</Show>

					<Show when={!hasGithubAccess() || !useRepoPicker()}>
						<form class="space-y-4" onSubmit={handleSubmitManualUrl}>
							<Input
								label="public repository url"
								type="url"
								value={githubUrl()}
								onInput={(event) => setGithubUrl(event.currentTarget.value)}
								placeholder="https://github.com/react/react-dom"
								required
							/>
							<Button type="submit" class="w-full">
								continue
							</Button>

							<Show when={!hasGithubAccess()}>
								<div class="rounded-md border border-[var(--border)] bg-[var(--muted)] p-4 text-sm text-[var(--muted-foreground)]">
									<a
										href="/settings"
										class="font-medium text-[var(--foreground)] underline underline-offset-4"
									>
										Set up the GitHub App
									</a>{" "}
									to browse and deploy private repositories with one click.
								</div>
							</Show>
						</form>
					</Show>
				</CardContent>
			</Card>
		</div>
	);
};

export default CreateRepo;
