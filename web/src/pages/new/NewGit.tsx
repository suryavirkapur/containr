import { A, useNavigate, useSearchParams } from "@solidjs/router";
import GitBranch from "lucide-solid/icons/git-branch";
import Lock from "lucide-solid/icons/lock";
import Search from "lucide-solid/icons/search";
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { listGithubAppRepos } from "../../api/github";
import { createServiceRequest, type ServiceInput } from "../../api/platform";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Button,
	Card,
	cx,
	Field,
	Input,
	LinkButton,
	Notice,
	PageHeader,
	Skeleton,
} from "../../components/ui";
import { GithubIcon } from "../../components/ui/brand";
import { EnvEditor, type EnvRow } from "../../components/ui/editors";
import { toast } from "../../components/ui/overlay";
import { useAppStore } from "../../context/AppStore";
import { slugify } from "../../lib/format";
import {
	FormSection,
	nameProblem,
	PortField,
	ProjectField,
	type ServiceType,
	ServiceTypePicker,
} from "./shared";

const NewGit = () => {
	useBreadcrumbs(() => [{ label: "New service", href: "/new" }, { label: "Git repository" }]);
	const navigate = useNavigate();
	const store = useAppStore();
	const [params] = useSearchParams();
	const [repos] = createResource(() => listGithubAppRepos().catch(() => null));
	const [query, setQuery] = createSignal("");
	const [url, setUrl] = createSignal("");
	const [branch, setBranch] = createSignal("main");
	const [name, setName] = createSignal("");
	const [project, setProject] = createSignal(
		typeof params.project === "string" ? params.project : "",
	);
	const [type, setType] = createSignal<ServiceType>("web_service");
	const [port, setPort] = createSignal("8080");
	const [dockerfile, setDockerfile] = createSignal("");
	const [context, setContext] = createSignal("");
	const [schedule, setSchedule] = createSignal("");
	const [env, setEnv] = createSignal<EnvRow[]>([]);
	const [submitting, setSubmitting] = createSignal(false);
	const [touched, setTouched] = createSignal(false);

	const filtered = createMemo(() => {
		const needle = query().trim().toLowerCase();
		const list = repos() ?? [];
		return (
			needle ? list.filter((repo) => repo.full_name.toLowerCase().includes(needle)) : list
		).slice(0, 30);
	});

	const choose = (repo: { clone_url: string; default_branch: string; name: string }) => {
		setUrl(repo.clone_url);
		setBranch(repo.default_branch);
		if (!name()) setName(slugify(repo.name));
	};

	const fromUrl = (value: string) => {
		setUrl(value);
		const match = /\/([^/]+?)(?:\.git)?\/?$/.exec(value.trim());
		if (match && !name()) setName(slugify(match[1]));
	};

	const error = () => (touched() ? nameProblem(name()) : null);

	const submit = async (event: Event) => {
		event.preventDefault();
		setTouched(true);
		if (nameProblem(name()) || !url().trim()) {
			if (!url().trim()) toast.error("Choose a repository first");
			return;
		}
		const portNumber = Number.parseInt(port(), 10);
		if (
			type() !== "background_worker" &&
			type() !== "cron_job" &&
			!(portNumber > 0 && portNumber < 65536)
		) {
			toast.error("Enter a valid container port");
			return;
		}
		if (type() === "cron_job" && !schedule().trim()) {
			toast.error("Cron jobs need a schedule");
			return;
		}
		const service: ServiceInput = {
			name: name().trim(),
			service_type: type(),
			port: Number.isFinite(portNumber) && portNumber > 0 ? portNumber : 8080,
			expose_http: type() === "web_service",
			dockerfile_path: dockerfile().trim() || null,
			build_context: context().trim() || null,
			schedule: type() === "cron_job" ? schedule().trim() : null,
			env_vars: env()
				.filter((row) => row.key.trim())
				.map((row) => ({ key: row.key.trim(), value: row.value, secret: row.secret })),
		};
		setSubmitting(true);
		try {
			const created = await createServiceRequest({
				source: "git_repository",
				name: name().trim(),
				github_url: url().trim(),
				branch: branch().trim() || "main",
				service,
				...(project() ? { group_id: project() } : {}),
			});
			store.upsertService(created);
			toast.success(`Deploying ${created.name}`, "The first build has started.");
			navigate(`/services/${created.id}/deployments`);
		} catch (requestError) {
			toast.error("Could not create the service", requestError);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div class="animate-fade-in mx-auto max-w-5xl">
			<PageHeader
				title="Deploy from Git"
				description="containr clones the repository, builds its Dockerfile and runs the image."
			/>
			<form onSubmit={(event) => void submit(event)}>
				<FormSection
					title="Repository"
					description="Pick one from GitHub or paste any HTTPS Git URL."
				>
					<Switch>
						<Match when={repos.loading}>
							<Skeleton class="h-40" />
						</Match>
						<Match when={(repos()?.length ?? 0) > 0}>
							<Card flush>
								<div class="border-b border-border p-2">
									<div class="relative">
										<Search
											width={14}
											height={14}
											class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint"
										/>
										<Input
											class="pl-8"
											placeholder="Search repositories"
											value={query()}
											onInput={(event) => setQuery(event.currentTarget.value)}
										/>
									</div>
								</div>
								<ul class="max-h-[280px] divide-y divide-border overflow-y-auto">
									<For
										each={filtered()}
										fallback={
											<li class="px-4 py-6 text-center text-[13px] text-fg-subtle">No matches</li>
										}
									>
										{(repo) => (
											<li>
												<button
													type="button"
													onClick={() => choose(repo)}
													class={cx(
														"flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
														url() === repo.clone_url ? "bg-accent-soft" : "hover:bg-surface-hover",
													)}
												>
													<GithubIcon class="shrink-0 text-fg-subtle" />
													<span class="min-w-0 flex-1 truncate text-[13px] font-medium">
														{repo.full_name}
													</span>
													<Show when={repo.private}>
														<Lock width={13} height={13} class="text-fg-faint" />
													</Show>
													<span class="text-[12px] text-fg-faint">{repo.default_branch}</span>
												</button>
											</li>
										)}
									</For>
								</ul>
							</Card>
						</Match>
						<Match when={true}>
							<Notice title="Connect GitHub for private repositories">
								Public repositories work with any URL. To deploy private repos and redeploy on push,{" "}
								<A href="/settings/github" class="underline">
									set up the GitHub App
								</A>
								.
							</Notice>
						</Match>
					</Switch>
					<div class="grid gap-4 sm:grid-cols-[1fr_180px]">
						<Field label="Repository URL">
							<Input
								mono
								placeholder="https://github.com/org/repo.git"
								value={url()}
								onInput={(event) => fromUrl(event.currentTarget.value)}
							/>
						</Field>
						<Field label="Branch">
							<div class="relative">
								<GitBranch
									width={14}
									height={14}
									class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint"
								/>
								<Input
									mono
									class="pl-8"
									value={branch()}
									onInput={(event) => setBranch(event.currentTarget.value)}
								/>
							</div>
						</Field>
					</div>
				</FormSection>

				<FormSection title="Service" description="How the service runs once it's built.">
					<div class="grid gap-4 sm:grid-cols-2">
						<Field label="Name" error={error()} hint="Lowercase, used in URLs and hostnames.">
							<Input
								value={name()}
								aria-invalid={Boolean(error())}
								onInput={(event) => setName(event.currentTarget.value.toLowerCase())}
								placeholder="my-app"
							/>
						</Field>
						<ProjectField value={project()} onChange={setProject} />
					</div>
					<ServiceTypePicker value={type()} onChange={setType} />
					<div class="grid gap-4 sm:grid-cols-2">
						<Show when={type() === "web_service" || type() === "private_service"}>
							<PortField value={port()} onChange={setPort} />
						</Show>
						<Show when={type() === "cron_job"}>
							<Field label="Schedule" hint="Cron syntax in UTC, e.g. 0 * * * * for hourly.">
								<Input
									mono
									placeholder="0 * * * *"
									value={schedule()}
									onInput={(event) => setSchedule(event.currentTarget.value)}
								/>
							</Field>
						</Show>
					</div>
				</FormSection>

				<FormSection
					title="Build"
					description="Defaults work for a Dockerfile at the repository root."
				>
					<div class="grid gap-4 sm:grid-cols-2">
						<Field label="Dockerfile path" optional>
							<Input
								mono
								placeholder="Dockerfile"
								value={dockerfile()}
								onInput={(event) => setDockerfile(event.currentTarget.value)}
							/>
						</Field>
						<Field label="Build context" optional>
							<Input
								mono
								placeholder="."
								value={context()}
								onInput={(event) => setContext(event.currentTarget.value)}
							/>
						</Field>
					</div>
				</FormSection>

				<FormSection
					title="Environment"
					description="Paste a .env file into a key field to add many at once."
				>
					<EnvEditor rows={env()} onChange={setEnv} />
				</FormSection>

				<div class="sticky bottom-0 -mx-4 mt-2 flex items-center justify-end gap-2 border-t border-border bg-bg/85 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
					<LinkButton href="/new" variant="ghost">
						Cancel
					</LinkButton>
					<Button type="submit" variant="primary" loading={submitting()}>
						Create and deploy
					</Button>
				</div>
			</form>
		</div>
	);
};

export default NewGit;
