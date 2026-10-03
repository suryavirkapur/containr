import { useNavigate } from "@solidjs/router";
import Trash from "lucide-solid/icons/trash";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { moveService, type ServiceInput } from "../../api/platform";
import {
	Button,
	Card,
	Field,
	Input,
	Notice,
	PasswordInput,
	SaveBar,
	Select,
	SettingRow,
	Switch,
	Textarea,
} from "../../components/ui";
import { EnvEditor, type EnvRow, ListEditor } from "../../components/ui/editors";
import { confirm, toast } from "../../components/ui/overlay";
import { useAppStore } from "../../context/AppStore";
import { useService } from "./context";

type Draft = {
	githubUrl: string;
	branch: string;
	rolloutStrategy: string;
	autoDeploy: boolean;
	watchPaths: string[];
	cleanupStale: boolean;
	name: string;
	notes: string;
	image: string;
	serviceType: string;
	replicas: string;
	restartPolicy: string;
	schedule: string;
	command: string;
	entrypoint: string;
	workingDir: string;
	buildContext: string;
	dockerfilePath: string;
	buildTarget: string;
	buildArgs: EnvRow[];
	healthEnabled: boolean;
	healthPath: string;
	healthInterval: string;
	healthTimeout: string;
	healthRetries: string;
	memoryMb: string;
	cpu: string;
	registryEnabled: boolean;
	registryServer: string;
	registryUser: string;
	registryPassword: string;
};

const SECTIONS = [
	["general", "General"],
	["source", "Source"],
	["build", "Build"],
	["deploy", "Deploy"],
	["health", "Health check"],
	["resources", "Resources"],
	["danger", "Danger zone"],
] as const;

// split a command line on whitespace, keeping quoted segments together
const splitArgs = (value: string): string[] | null => {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parts = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	return parts.map((part) => part.replace(/^(["'])(.*)\1$/, "$2"));
};
const joinArgs = (value?: string[] | null) =>
	(value ?? []).map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");

const ManagedSettings = () => {
	const ctx = useService();
	const store = useAppStore();
	const navigate = useNavigate();
	const [project, setProject] = createSignal(ctx.service()?.group_id ?? "");
	const [moving, setMoving] = createSignal(false);

	const projects = createMemo(() => {
		const seen = new Map<string, string>();
		for (const service of store.state.services) {
			if (service.resource_kind === "app_service" && service.group_id) {
				seen.set(service.group_id, service.project_name ?? service.name);
			}
		}
		return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
	});

	const move = async () => {
		setMoving(true);
		try {
			const updated = await moveService(ctx.id(), project() || null);
			store.upsertService(updated);
			await ctx.refetch();
			toast.success(project() ? "Moved into the project" : "Detached from the project");
		} catch (error) {
			toast.error("Could not move the service", error);
		} finally {
			setMoving(false);
		}
	};

	const remove = async () => {
		const ok = await confirm({
			title: `Delete ${ctx.service()?.name}?`,
			description:
				"The container and its data volume are deleted. Download a backup first if you need the data.",
			confirmLabel: "Delete database",
			danger: true,
			typeToConfirm: ctx.service()?.name,
		});
		if (!ok) return;
		try {
			await store.removeService(ctx.id());
			navigate("/services");
		} catch (error) {
			toast.error("Delete failed", error);
		}
	};

	return (
		<div class="max-w-3xl space-y-6">
			<Card
				title="Project"
				description="Services in the same project share a private network and can reach this database."
			>
				<div class="flex flex-wrap items-end gap-3">
					<Field label="Project" class="min-w-[240px] flex-1">
						<Select value={project()} onChange={(event) => setProject(event.currentTarget.value)}>
							<option value="">No project (isolated)</option>
							<For each={projects()}>{([id, name]) => <option value={id}>{name}</option>}</For>
						</Select>
					</Field>
					<Button
						variant="primary"
						loading={moving()}
						disabled={project() === (ctx.service()?.group_id ?? "")}
						onClick={() => void move()}
					>
						Move
					</Button>
				</div>
			</Card>
			<Card title="Danger zone" class="border-danger/40">
				<SettingRow
					title="Delete this database"
					description="Removes the container and its volume permanently."
				>
					<Button variant="danger-outline" onClick={() => void remove()}>
						<Trash />
						Delete
					</Button>
				</SettingRow>
			</Card>
		</div>
	);
};

const AppSettings = () => {
	const ctx = useService();
	const store = useAppStore();
	const navigate = useNavigate();
	const [saving, setSaving] = createSignal(false);

	const fromSettings = (): Draft | null => {
		const current = ctx.settings();
		if (!current) return null;
		const service = current.service as typeof current.service & { notes?: string | null };
		return {
			githubUrl: current.github_url,
			branch: current.branch,
			rolloutStrategy: current.rollout_strategy,
			autoDeploy: current.auto_deploy.enabled,
			watchPaths: [...current.auto_deploy.watch_paths],
			cleanupStale: current.auto_deploy.cleanup_stale_deployments,
			name: service.name,
			notes: service.notes ?? "",
			image: service.image ?? "",
			serviceType: service.service_type,
			replicas: String(service.replicas),
			restartPolicy: service.restart_policy,
			schedule: service.schedule ?? "",
			command: joinArgs(service.command),
			entrypoint: joinArgs(service.entrypoint),
			workingDir: service.working_dir ?? "",
			buildContext: service.build_context ?? "",
			dockerfilePath: service.dockerfile_path ?? "",
			buildTarget: service.build_target ?? "",
			buildArgs: service.build_args.map((arg) => ({
				key: arg.key,
				value: arg.value,
				secret: arg.secret,
			})),
			healthEnabled: Boolean(service.health_check),
			healthPath: service.health_check?.path ?? "/",
			healthInterval: String(service.health_check?.interval_secs ?? 10),
			healthTimeout: String(service.health_check?.timeout_secs ?? 5),
			healthRetries: String(service.health_check?.retries ?? 3),
			memoryMb: service.memory_limit_mb ? String(service.memory_limit_mb) : "",
			cpu: service.cpu_limit ? String(service.cpu_limit) : "",
			registryEnabled: Boolean(service.registry_auth),
			registryServer: service.registry_auth?.server ?? "",
			registryUser: service.registry_auth?.username ?? "",
			registryPassword: service.registry_auth?.password ?? "",
		};
	};

	const initial = createMemo(fromSettings);
	// seed synchronously so the first render never sees an empty draft
	const [draft, setDraft] = createStore<Draft>(structuredClone(initial() ?? ({} as Draft)));
	const reset = () => {
		const value = initial();
		if (value) setDraft(reconcile(structuredClone(value)));
	};
	createEffect(on(initial, reset));

	const dirty = () => {
		const value = initial();
		return value ? JSON.stringify(draft) !== JSON.stringify(value) : false;
	};
	const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(key, value as never);

	const int = (value: string) => {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : null;
	};

	const save = async () => {
		if (!draft.name.trim()) {
			toast.error("The service needs a name");
			return;
		}
		if (draft.serviceType === "cron_job" && !draft.schedule.trim()) {
			toast.error("Cron jobs need a schedule");
			return;
		}
		const patch: Partial<ServiceInput> = {
			name: draft.name.trim(),
			image: draft.image.trim() || null,
			service_type: draft.serviceType as ServiceInput["service_type"],
			replicas: Math.max(0, int(draft.replicas) ?? 1),
			restart_policy: draft.restartPolicy as ServiceInput["restart_policy"],
			schedule: draft.serviceType === "cron_job" ? draft.schedule.trim() : null,
			command: splitArgs(draft.command),
			entrypoint: splitArgs(draft.entrypoint),
			working_dir: draft.workingDir.trim() || null,
			build_context: draft.buildContext.trim() || null,
			dockerfile_path: draft.dockerfilePath.trim() || null,
			build_target: draft.buildTarget.trim() || null,
			build_args: draft.buildArgs
				.filter((arg) => arg.key.trim())
				.map((arg) => ({ key: arg.key.trim(), value: arg.value, secret: arg.secret })),
			health_check: draft.healthEnabled
				? {
						path: draft.healthPath.trim() || "/",
						interval_secs: int(draft.healthInterval) ?? 10,
						timeout_secs: int(draft.healthTimeout) ?? 5,
						retries: int(draft.healthRetries) ?? 3,
					}
				: null,
			memory_limit_mb: int(draft.memoryMb),
			cpu_limit: draft.cpu.trim() ? Number.parseFloat(draft.cpu) : null,
			registry_auth: draft.registryEnabled
				? {
						server: draft.registryServer.trim() || null,
						username: draft.registryUser.trim(),
						password: draft.registryPassword,
					}
				: null,
		};
		if (initial() && "notes" in (ctx.settings()?.service ?? {}))
			patch.notes = draft.notes.trim() || null;
		const request = ctx.serviceRequest(patch);
		if (!request) return;
		setSaving(true);
		await ctx.save(
			{
				github_url: draft.githubUrl.trim(),
				branch: draft.branch.trim(),
				rollout_strategy: draft.rolloutStrategy,
				auto_deploy: {
					enabled: draft.autoDeploy,
					watch_paths: draft.watchPaths,
					cleanup_stale_deployments: draft.cleanupStale,
				},
				service: request,
			},
			"Settings saved",
		);
		setSaving(false);
	};

	const regenerateToken = async () => {
		const ok = await confirm({
			title: "Regenerate the deploy webhook?",
			description: "The current webhook URL stops working immediately.",
			confirmLabel: "Regenerate",
		});
		if (ok)
			await ctx.save(
				{ auto_deploy: { regenerate_webhook_token: true } },
				"Webhook URL regenerated",
			);
	};

	const remove = async () => {
		const ok = await confirm({
			title: `Delete ${ctx.service()?.name}?`,
			description:
				"Containers, images, deployment history and logs are removed permanently. Volumes are kept.",
			confirmLabel: "Delete service",
			danger: true,
			typeToConfirm: ctx.service()?.name,
		});
		if (!ok) return;
		try {
			await store.removeService(ctx.id());
			toast.success("Service deleted");
			navigate("/services");
		} catch (error) {
			toast.error("Delete failed", error);
		}
	};

	const isCron = () => draft.serviceType === "cron_job";
	const hasRepo = () => Boolean(draft.githubUrl?.trim());

	return (
		<Show when={initial() && draft.name !== undefined}>
			<div class="grid gap-8 lg:grid-cols-[180px_1fr]">
				<nav class="hidden lg:block">
					<ul class="sticky top-20 space-y-0.5 text-[13px]">
						<For each={SECTIONS}>
							{([id, label]) => (
								<li>
									<a
										href={`#${id}`}
										class="block rounded-md px-2.5 py-1.5 text-fg-subtle hover:bg-surface-hover hover:text-fg"
									>
										{label}
									</a>
								</li>
							)}
						</For>
					</ul>
				</nav>
				<div class="min-w-0 space-y-6">
					<Card id="general" title="General">
						<div class="space-y-4">
							<Field
								label="Service name"
								hint="Also the hostname other services in the project use to reach it."
							>
								<Input
									value={draft.name}
									onInput={(event) => set("name", event.currentTarget.value)}
								/>
							</Field>
							<Show when={"notes" in (ctx.settings()?.service ?? {})}>
								<Field label="Notes" optional hint="Visible to everyone who can see this service.">
									<Textarea
										rows={3}
										value={draft.notes}
										placeholder="What this service does, who owns it, runbooks…"
										onInput={(event) => set("notes", event.currentTarget.value)}
									/>
								</Field>
							</Show>
						</div>
					</Card>

					<Card
						id="source"
						title="Source"
						description="Where the code or image for this service comes from."
					>
						<div class="space-y-4">
							<div class="grid gap-4 sm:grid-cols-[1fr_200px]">
								<Field
									label="Git repository"
									optional
									hint="HTTPS clone URL. Private GitHub repos work once the GitHub App is installed."
								>
									<Input
										mono
										placeholder="https://github.com/org/repo"
										value={draft.githubUrl}
										onInput={(event) => set("githubUrl", event.currentTarget.value)}
									/>
								</Field>
								<Field label="Branch">
									<Input
										mono
										value={draft.branch}
										onInput={(event) => set("branch", event.currentTarget.value)}
									/>
								</Field>
							</div>
							<Field
								label="Image"
								optional
								hint={
									hasRepo()
										? "Leave empty to build from the repository."
										: "Pulled on every deploy."
								}
							>
								<Input
									mono
									placeholder="nginx:alpine"
									value={draft.image}
									onInput={(event) => set("image", event.currentTarget.value)}
								/>
							</Field>
							<div class="divide-y divide-border border-t border-border">
								<SettingRow
									title="Auto-deploy on push"
									description="Deploy automatically when the branch changes on GitHub."
								>
									<Switch
										checked={draft.autoDeploy}
										onChange={(value) => set("autoDeploy", value)}
										label="Auto-deploy"
									/>
								</SettingRow>
								<Show when={draft.autoDeploy}>
									<div class="py-4">
										<Field
											label="Watch paths"
											optional
											hint="Only deploy when files under these paths change. Empty means any change."
										>
											<ListEditor
												mono
												values={draft.watchPaths}
												onChange={(values) => set("watchPaths", values)}
												placeholder="apps/api/**"
												addLabel="Add path"
											/>
										</Field>
									</div>
								</Show>
								<SettingRow
									title="Cancel superseded builds"
									description="When a newer commit arrives, stop queued builds of older ones."
								>
									<Switch
										checked={draft.cleanupStale}
										onChange={(value) => set("cleanupStale", value)}
										label="Cancel superseded builds"
									/>
								</SettingRow>
								<SettingRow
									title="Deploy webhook"
									description="Invalidate the current webhook URL and create a new one."
								>
									<Button variant="secondary" size="sm" onClick={() => void regenerateToken()}>
										Regenerate
									</Button>
								</SettingRow>
								<SettingRow
									title="Private registry"
									description="Credentials used to pull this service's image."
								>
									<Switch
										checked={draft.registryEnabled}
										onChange={(value) => set("registryEnabled", value)}
										label="Private registry"
									/>
								</SettingRow>
							</div>
							<Show when={draft.registryEnabled}>
								<div class="grid gap-4 sm:grid-cols-3">
									<Field label="Registry" hint="Empty for Docker Hub.">
										<Input
											mono
											placeholder="ghcr.io"
											value={draft.registryServer}
											onInput={(event) => set("registryServer", event.currentTarget.value)}
										/>
									</Field>
									<Field label="Username">
										<Input
											value={draft.registryUser}
											onInput={(event) => set("registryUser", event.currentTarget.value)}
										/>
									</Field>
									<Field label="Password or token">
										<PasswordInput
											value={draft.registryPassword}
											onInput={(event) => set("registryPassword", event.currentTarget.value)}
										/>
									</Field>
								</div>
								<p class="hint">
									Tip: add registries once under Settings → Registries and every service can use
									them.
								</p>
							</Show>
						</div>
					</Card>

					<Card
						id="build"
						title="Build"
						description="How the image is built from your repository or upload."
					>
						<div class="space-y-4">
							<div class="grid gap-4 sm:grid-cols-3">
								<Field label="Dockerfile path" optional>
									<Input
										mono
										placeholder="Dockerfile"
										value={draft.dockerfilePath}
										onInput={(event) => set("dockerfilePath", event.currentTarget.value)}
									/>
								</Field>
								<Field label="Build context" optional>
									<Input
										mono
										placeholder="."
										value={draft.buildContext}
										onInput={(event) => set("buildContext", event.currentTarget.value)}
									/>
								</Field>
								<Field label="Target stage" optional>
									<Input
										mono
										placeholder="production"
										value={draft.buildTarget}
										onInput={(event) => set("buildTarget", event.currentTarget.value)}
									/>
								</Field>
							</div>
							<Field label="Build arguments" optional>
								<EnvEditor
									rows={draft.buildArgs}
									onChange={(rows) => set("buildArgs", rows)}
									keyPlaceholder="ARG_NAME"
									emptyLabel="No build arguments."
								/>
							</Field>
						</div>
					</Card>

					<Card id="deploy" title="Deploy" description="How containers are run and replaced.">
						<div class="space-y-4">
							<div class="grid gap-4 sm:grid-cols-2">
								<Field label="Service type">
									<Select
										value={draft.serviceType}
										onChange={(event) => set("serviceType", event.currentTarget.value)}
									>
										<option value="web_service">Web service (public HTTP)</option>
										<option value="private_service">Private service (internal only)</option>
										<option value="background_worker">Background worker</option>
										<option value="cron_job">Cron job</option>
									</Select>
								</Field>
								<Show
									when={isCron()}
									fallback={
										<Field label="Instances" hint="Requests are load-balanced across instances.">
											<Input
												type="number"
												min="0"
												max="50"
												value={draft.replicas}
												onInput={(event) => set("replicas", event.currentTarget.value)}
											/>
										</Field>
									}
								>
									<Field
										label="Schedule"
										hint="Cron syntax, in UTC. Example: */15 * * * * runs every 15 minutes."
									>
										<Input
											mono
											placeholder="0 3 * * *"
											value={draft.schedule}
											onInput={(event) => set("schedule", event.currentTarget.value)}
										/>
									</Field>
								</Show>
								<Field label="Rollout">
									<Select
										value={draft.rolloutStrategy}
										onChange={(event) => set("rolloutStrategy", event.currentTarget.value)}
									>
										<option value="start_first">Zero downtime (start new first)</option>
										<option value="stop_first">Stop old first (safe for single writers)</option>
									</Select>
								</Field>
								<Field label="Restart policy">
									<Select
										value={draft.restartPolicy}
										onChange={(event) => set("restartPolicy", event.currentTarget.value)}
									>
										<option value="always">Always restart</option>
										<option value="unless-stopped">Unless stopped manually</option>
										<option value="on-failure">Restart on failure</option>
										<option value="never">Never restart</option>
									</Select>
								</Field>
							</div>
							<div class="grid gap-4 sm:grid-cols-2">
								<Field label="Start command" optional hint="Overrides the image CMD.">
									<Input
										mono
										placeholder="npm run start"
										value={draft.command}
										onInput={(event) => set("command", event.currentTarget.value)}
									/>
								</Field>
								<Field label="Entrypoint" optional>
									<Input
										mono
										value={draft.entrypoint}
										onInput={(event) => set("entrypoint", event.currentTarget.value)}
									/>
								</Field>
								<Field label="Working directory" optional>
									<Input
										mono
										placeholder="/app"
										value={draft.workingDir}
										onInput={(event) => set("workingDir", event.currentTarget.value)}
									/>
								</Field>
							</div>
						</div>
					</Card>

					<Card
						id="health"
						title="Health check"
						description="New containers only receive traffic once they pass."
					>
						<div class="-mt-4 divide-y divide-border">
							<SettingRow
								title="HTTP health check"
								description="containr waits for a 2xx response before switching traffic."
							>
								<Switch
									checked={draft.healthEnabled}
									onChange={(value) => set("healthEnabled", value)}
									label="HTTP health check"
								/>
							</SettingRow>
						</div>
						<Show when={draft.healthEnabled}>
							<div class="grid gap-4 pt-2 sm:grid-cols-4">
								<Field label="Path" class="sm:col-span-4">
									<Input
										mono
										value={draft.healthPath}
										onInput={(event) => set("healthPath", event.currentTarget.value)}
									/>
								</Field>
								<Field label="Interval (s)">
									<Input
										type="number"
										min="1"
										value={draft.healthInterval}
										onInput={(event) => set("healthInterval", event.currentTarget.value)}
									/>
								</Field>
								<Field label="Timeout (s)">
									<Input
										type="number"
										min="1"
										value={draft.healthTimeout}
										onInput={(event) => set("healthTimeout", event.currentTarget.value)}
									/>
								</Field>
								<Field label="Retries">
									<Input
										type="number"
										min="1"
										value={draft.healthRetries}
										onInput={(event) => set("healthRetries", event.currentTarget.value)}
									/>
								</Field>
							</div>
						</Show>
					</Card>

					<Card
						id="resources"
						title="Resources"
						description="Limits per instance. Leave empty for no limit."
					>
						<div class="grid gap-4 sm:grid-cols-2">
							<Field label="Memory (MB)" optional>
								<Input
									type="number"
									min="16"
									placeholder="512"
									value={draft.memoryMb}
									onInput={(event) => set("memoryMb", event.currentTarget.value)}
								/>
							</Field>
							<Field label="CPU (cores)" optional>
								<Input
									type="number"
									min="0.1"
									step="0.1"
									placeholder="1"
									value={draft.cpu}
									onInput={(event) => set("cpu", event.currentTarget.value)}
								/>
							</Field>
						</div>
					</Card>

					<Card id="danger" title="Danger zone" class="border-danger/40">
						<Notice class="mb-4">
							Deleting removes containers and history. Named volumes stay on the server until you
							clean them up.
						</Notice>
						<SettingRow title="Delete this service" description="This cannot be undone.">
							<Button variant="danger-outline" onClick={() => void remove()}>
								<Trash />
								Delete service
							</Button>
						</SettingRow>
					</Card>

					<SaveBar
						dirty={dirty()}
						saving={saving()}
						onSave={() => void save()}
						onReset={reset}
						label="Unsaved settings · redeploy to apply"
					/>
				</div>
			</div>
		</Show>
	);
};

const ServiceSettingsPage = () => {
	const ctx = useService();
	return (
		<Show when={ctx.isApp()} fallback={<ManagedSettings />}>
			<AppSettings />
		</Show>
	);
};

export default ServiceSettingsPage;
