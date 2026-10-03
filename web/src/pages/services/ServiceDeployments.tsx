import FileCode from "lucide-solid/icons/file-code";
import GitBranch from "lucide-solid/icons/git-branch";
import Package from "lucide-solid/icons/package";
import Rocket from "lucide-solid/icons/rocket";
import RotateCcw from "lucide-solid/icons/rotate-ccw";
import Terminal from "lucide-solid/icons/terminal";
import Upload from "lucide-solid/icons/upload";
import Webhook from "lucide-solid/icons/webhook";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { deployDockerfile, deployTarball } from "../../api/platform";
import {
	listServiceDeployments,
	rollbackServiceDeployment,
	type ServiceDeployment,
	triggerServiceDeployment,
} from "../../api/services";
import {
	Button,
	Card,
	CopyField,
	cx,
	EmptyState,
	Field,
	Input,
	Notice,
	Segmented,
	Skeleton,
	StatusBadge,
	Textarea,
} from "../../components/ui";
import { LogConsole } from "../../components/ui/LogConsole";
import { confirm, toast } from "../../components/ui/overlay";
import { formatDateTime, formatDuration, shortId, timeAgo } from "../../lib/format";
import { useDeploymentLogStream } from "../../lib/logs";
import { isInProgress } from "../../lib/status";
import { useService } from "./context";

type Method = "git" | "image" | "upload" | "dockerfile" | "webhook" | "cli";

const DOCKERFILE_SAMPLE = `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80`;

const ServiceDeployments = () => {
	const ctx = useService();
	const [deployments, { refetch, mutate }] = createResource(ctx.id, (id) =>
		listServiceDeployments(id),
	);
	const [selected, setSelected] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal<string | null>(null);
	const [method, setMethod] = createSignal<Method>("git");
	const [branch, setBranch] = createSignal("");
	const [image, setImage] = createSignal("");
	const [dockerfile, setDockerfile] = createSignal(DOCKERFILE_SAMPLE);
	const [file, setFile] = createSignal<File | null>(null);
	const [dragging, setDragging] = createSignal(false);

	const isImageService = () => !ctx.settings()?.github_url && Boolean(ctx.service()?.image);

	createEffect(() => {
		if (isImageService()) setMethod("image");
	});
	createEffect(() => {
		const current = ctx.settings();
		if (current && !branch()) setBranch(current.branch);
		if (current?.service.image && !image()) setImage(current.service.image);
	});

	// select the newest deployment by default
	createEffect(() => {
		const list = deployments();
		if (list?.length && !list.some((item) => item.id === selected())) setSelected(list[0].id);
	});

	onMount(() => {
		const timer = setInterval(async () => {
			const list = deployments();
			if (
				document.visibilityState !== "visible" ||
				!list?.some((item) => isInProgress(item.status))
			)
				return;
			try {
				mutate(await listServiceDeployments(ctx.id()));
			} catch {
				// next tick retries
			}
		}, 3000);
		onCleanup(() => clearInterval(timer));
	});

	const stream = useDeploymentLogStream(ctx.id, selected);
	const selectedDeployment = createMemo(() =>
		deployments()?.find((item) => item.id === selected()),
	);
	const current = createMemo(() => deployments()?.find((item) => item.status === "running"));

	const afterDeploy = async (deployment?: ServiceDeployment) => {
		await refetch();
		if (deployment?.id) setSelected(deployment.id);
		void ctx.refetch();
	};

	const run = async (
		key: string,
		task: () => Promise<ServiceDeployment | undefined>,
		message: string,
	) => {
		setBusy(key);
		try {
			const deployment = await task();
			toast.success(message);
			await afterDeploy(deployment);
		} catch (error) {
			toast.error("Deployment could not start", error);
		} finally {
			setBusy(null);
		}
	};

	const deployGit = () =>
		run(
			"git",
			() => triggerServiceDeployment(ctx.id(), { branch: branch().trim() || undefined }),
			"Deployment started",
		);

	const deployImage = () =>
		run(
			"image",
			async () => {
				const request = ctx.serviceRequest({ image: image().trim() });
				if (!request) throw new Error("Service settings are still loading");
				const saved = await ctx.save({ service: request }, "Image updated");
				if (!saved) throw new Error("Could not update the image");
				return triggerServiceDeployment(ctx.id(), {});
			},
			"Deploying new image",
		);

	const deployUpload = () => {
		const selectedFile = file();
		if (!selectedFile) return;
		return run("upload", () => deployTarball(ctx.id(), selectedFile), "Upload received, building…");
	};

	const deployDockerfileNow = () =>
		run("dockerfile", () => deployDockerfile(ctx.id(), dockerfile()), "Building from Dockerfile…");

	const rollback = async (deployment: ServiceDeployment) => {
		const ok = await confirm({
			title: "Roll back to this deployment?",
			description: (
				<>
					The service returns to <code>{shortId(deployment.commit_sha)}</code> from{" "}
					{formatDateTime(deployment.created_at)}, including its configuration at that time.
				</>
			),
			confirmLabel: "Roll back",
		});
		if (!ok) return;
		await run(
			`rollback:${deployment.id}`,
			() => rollbackServiceDeployment(ctx.id(), deployment.id),
			"Rollback started",
		);
	};

	const webhookUrl = () => {
		const path = ctx.settings()?.auto_deploy.webhook_path;
		return path ? `${window.location.origin}${path}` : "";
	};

	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		const dropped = event.dataTransfer?.files?.[0];
		if (dropped) setFile(dropped);
	};

	return (
		<div class="space-y-6">
			<Card title="Deploy" description="Ship a new version of this service using any method." flush>
				<div class="border-b border-border px-4 py-3">
					<Segmented<Method>
						value={method()}
						onChange={setMethod}
						options={[
							{
								value: "git",
								label: (
									<span class="flex items-center gap-1.5">
										<GitBranch width={13} height={13} />
										Git
									</span>
								),
							},
							{
								value: "image",
								label: (
									<span class="flex items-center gap-1.5">
										<Package width={13} height={13} />
										Image
									</span>
								),
							},
							{
								value: "upload",
								label: (
									<span class="flex items-center gap-1.5">
										<Upload width={13} height={13} />
										Upload
									</span>
								),
							},
							{
								value: "dockerfile",
								label: (
									<span class="flex items-center gap-1.5">
										<FileCode width={13} height={13} />
										Dockerfile
									</span>
								),
							},
							{
								value: "webhook",
								label: (
									<span class="flex items-center gap-1.5">
										<Webhook width={13} height={13} />
										Webhook
									</span>
								),
							},
							{
								value: "cli",
								label: (
									<span class="flex items-center gap-1.5">
										<Terminal width={13} height={13} />
										CLI
									</span>
								),
							},
						]}
					/>
				</div>
				<div class="p-4">
					<Switch>
						<Match when={method() === "git"}>
							<Show
								when={ctx.settings()?.github_url}
								fallback={
									<Notice>
										This service has no Git repository. Add one under Settings → Source, or use
										another method.
									</Notice>
								}
							>
								<div class="flex flex-wrap items-end gap-3">
									<Field label="Repository" class="min-w-[240px] flex-1">
										<CopyField value={ctx.settings()?.github_url ?? ""} />
									</Field>
									<Field label="Branch" class="w-48">
										<Input
											mono
											value={branch()}
											onInput={(event) => setBranch(event.currentTarget.value)}
										/>
									</Field>
									<Button
										variant="primary"
										loading={busy() === "git"}
										onClick={() => void deployGit()}
									>
										<Rocket />
										Deploy latest commit
									</Button>
								</div>
							</Show>
						</Match>
						<Match when={method() === "image"}>
							<div class="flex flex-wrap items-end gap-3">
								<Field
									label="Image"
									class="min-w-[260px] flex-1"
									hint="Any public image, or a private one from a registry you added in Settings."
								>
									<Input
										mono
										placeholder="ghcr.io/org/app:1.4.2"
										value={image()}
										onInput={(event) => setImage(event.currentTarget.value)}
									/>
								</Field>
								<Button
									variant="primary"
									loading={busy() === "image"}
									disabled={!image().trim()}
									onClick={() => void deployImage()}
								>
									<Rocket />
									Deploy image
								</Button>
							</div>
						</Match>
						<Match when={method() === "upload"}>
							<label
								class={cx(
									"flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
									dragging()
										? "border-accent bg-accent-soft"
										: "border-border-strong hover:bg-surface-hover",
								)}
								onDragOver={(event) => {
									event.preventDefault();
									setDragging(true);
								}}
								onDragLeave={() => setDragging(false)}
								onDrop={onDrop}
							>
								<Upload width={20} height={20} class="text-fg-subtle" />
								<span class="mt-3 text-[13.5px] font-medium">
									{file() ? file()?.name : "Drop a .tar or .tar.gz of your project"}
								</span>
								<span class="mt-1 text-[12.5px] text-fg-subtle">
									It must contain a Dockerfile at its root (or the path set in Settings). Up to 512
									MB.
								</span>
								<input
									type="file"
									class="hidden"
									accept=".tar,.tgz,.gz,application/gzip,application/x-tar"
									onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
								/>
							</label>
							<div class="mt-3 flex items-center justify-between gap-3">
								<code class="text-[12px] text-fg-subtle">
									tar -czf app.tar.gz --exclude=node_modules .
								</code>
								<Button
									variant="primary"
									disabled={!file()}
									loading={busy() === "upload"}
									onClick={() => void deployUpload()}
								>
									<Rocket />
									Upload and deploy
								</Button>
							</div>
						</Match>
						<Match when={method() === "dockerfile"}>
							<Field
								label="Dockerfile"
								hint="Built with an empty context: use it for images that download or generate everything they need."
							>
								<Textarea
									mono
									rows={10}
									value={dockerfile()}
									onInput={(event) => setDockerfile(event.currentTarget.value)}
									spellcheck={false}
								/>
							</Field>
							<div class="mt-3 flex justify-end">
								<Button
									variant="primary"
									loading={busy() === "dockerfile"}
									disabled={!dockerfile().trim()}
									onClick={() => void deployDockerfileNow()}
								>
									<Rocket />
									Build and deploy
								</Button>
							</div>
						</Match>
						<Match when={method() === "webhook"}>
							<div class="space-y-3">
								<p class="text-[13px] text-fg-muted">
									Send a <code class="text-fg">POST</code> to this URL from CI or any service to
									redeploy the latest commit. Treat it like a password.
								</p>
								<CopyField value={webhookUrl()} secret />
								<code class="block rounded-md bg-surface-2 px-3 py-2 text-[12px] text-fg-muted">
									curl -X POST "{webhookUrl() ? "<webhook url>" : ""}"
								</code>
								<p class="text-[12.5px] text-fg-subtle">
									Pushes to GitHub deploy automatically when auto-deploy is on (Settings → Source).
								</p>
							</div>
						</Match>
						<Match when={method() === "cli"}>
							<div class="space-y-2 text-[13px] text-fg-muted">
								<p>Deploy from your terminal with the containr CLI:</p>
								<pre class="overflow-x-auto rounded-md bg-surface-2 px-3 py-2.5 font-mono text-[12px] text-fg">
									{`containr-cmd init --url ${window.location.origin}
containr-cmd login --email <you@example.com> --password <password>
containr-cmd services deploy ${ctx.id()}
containr-cmd services deploy ${ctx.id()} --upload .`}
								</pre>
							</div>
						</Match>
					</Switch>
				</div>
			</Card>

			<div class="grid gap-6 xl:grid-cols-[380px_1fr]">
				<Card title="History" flush>
					<Switch>
						<Match when={deployments.loading && !deployments()}>
							<div class="space-y-2 p-4">
								<Skeleton class="h-12" />
								<Skeleton class="h-12" />
							</div>
						</Match>
						<Match when={!deployments()?.length}>
							<div class="p-4">
								<EmptyState
									icon={<Rocket />}
									title="No deployments yet"
									description="Deploy to see build output here."
								/>
							</div>
						</Match>
						<Match when={true}>
							<ul class="max-h-[600px] divide-y divide-border overflow-y-auto">
								<For each={deployments()}>
									{(deployment) => (
										<li>
											<button
												type="button"
												onClick={() => setSelected(deployment.id)}
												class={cx(
													"flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
													selected() === deployment.id
														? "bg-surface-hover"
														: "hover:bg-surface-hover",
												)}
											>
												<div class="min-w-0 flex-1">
													<div class="flex items-center gap-2">
														<StatusBadge status={deployment.status} />
														<Show when={current()?.id === deployment.id}>
															<span class="text-[11.5px] font-medium text-success">current</span>
														</Show>
													</div>
													<div class="mt-1.5 truncate text-[13px]">
														{deployment.commit_message || "Manual deployment"}
													</div>
													<div class="mt-0.5 text-[12px] text-fg-subtle">
														<code>{shortId(deployment.commit_sha)}</code> ·{" "}
														{timeAgo(deployment.created_at)}
														<Show when={deployment.started_at}>
															{" "}
															· {formatDuration(deployment.started_at, deployment.finished_at)}
														</Show>
													</div>
												</div>
												<Show
													when={
														current()?.id !== deployment.id &&
														(deployment.status === "running" || deployment.status === "stopped")
													}
												>
													<button
														type="button"
														class="btn btn-ghost btn-sm shrink-0"
														title="Roll back to this deployment"
														disabled={busy() !== null}
														onClick={(event) => {
															event.stopPropagation();
															void rollback(deployment);
														}}
													>
														<RotateCcw />
														Rollback
													</button>
												</Show>
											</button>
										</li>
									)}
								</For>
							</ul>
						</Match>
					</Switch>
				</Card>

				<LogConsole
					stream={stream}
					height="560px"
					live={isInProgress(selectedDeployment()?.status)}
					title={
						<Show when={selectedDeployment()}>
							{(deployment) => (
								<>
									Build {shortId(deployment().id, 8)} · {formatDateTime(deployment().created_at)}
								</>
							)}
						</Show>
					}
					filename={`build-${selected() ?? "log"}.txt`}
					emptyText="Select a deployment to see its build output."
				/>
			</div>
		</div>
	);
};

export default ServiceDeployments;
