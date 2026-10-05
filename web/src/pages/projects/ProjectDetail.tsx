import { A, useParams } from "@solidjs/router";
import Database from "lucide-solid/icons/database";
import GitBranch from "lucide-solid/icons/git-branch";
import Package from "lucide-solid/icons/package";
import Pencil from "lucide-solid/icons/pencil";
import Store from "lucide-solid/icons/store";
import { createMemo, createSignal, For, Show } from "solid-js";
import { renameProject } from "../../api/platform";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Badge,
	Button,
	Card,
	CopyButton,
	EmptyState,
	Input,
	LinkButton,
	PageHeader,
	StatusBadge,
} from "../../components/ui";
import { Modal, toast } from "../../components/ui/overlay";
import { useAppStore } from "../../context/AppStore";
import { timeAgo } from "../../lib/format";
import {
	displayHost,
	isManaged,
	primaryUrl,
	publicPorts,
	ServiceIcon,
	typeLabel,
} from "../../lib/services";
import { ServiceActions } from "../services/ServiceList";
import { useProjectSummaries } from "./Projects";

const ProjectDetail = () => {
	const params = useParams();
	const store = useAppStore();
	const projects = useProjectSummaries();
	const project = createMemo(() => projects().find((item) => item.id === params.id));
	const [renaming, setRenaming] = createSignal(false);
	const [draft, setDraft] = createSignal("");
	const [saving, setSaving] = createSignal(false);

	useBreadcrumbs(() => [
		{ label: "Projects", href: "/projects" },
		{ label: project()?.name ?? "Project" },
	]);

	const rename = async () => {
		setSaving(true);
		try {
			await renameProject(params.id ?? "", draft().trim());
			await store.loadServices(true);
			toast.success("Project renamed");
			setRenaming(false);
		} catch (error) {
			toast.error("Could not rename the project", error);
		} finally {
			setSaving(false);
		}
	};

	const addHref = (path: string) => `${path}?project=${encodeURIComponent(params.id ?? "")}`;

	return (
		<Show
			when={project()}
			fallback={
				<Show when={store.loaded()}>
					<EmptyState
						title="Project not found"
						description="It may have been deleted with its last service."
					>
						<LinkButton href="/projects">Back to projects</LinkButton>
					</EmptyState>
				</Show>
			}
		>
			{(current) => (
				<div class="animate-fade-in">
					<PageHeader
						eyebrow="Project"
						title={
							<span class="inline-flex items-center gap-2">
								{current().name}
								<button
									type="button"
									class="btn btn-ghost btn-icon btn-sm"
									aria-label="Rename project"
									onClick={() => {
										setDraft(current().name);
										setRenaming(true);
									}}
								>
									<Pencil />
								</button>
							</span>
						}
						description={
							<span class="inline-flex items-center gap-1">
								Private network <code class="text-fg-muted">{current().network}</code>
								<CopyButton value={current().network} />
							</span>
						}
					/>

					<div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<A
							href={addHref("/new/git")}
							class="card card-interactive flex items-center gap-3 p-3.5 text-[13px] font-medium"
						>
							<GitBranch width={16} height={16} class="text-fg-subtle" />
							Add from Git
						</A>
						<A
							href={addHref("/new/image")}
							class="card card-interactive flex items-center gap-3 p-3.5 text-[13px] font-medium"
						>
							<Package width={16} height={16} class="text-fg-subtle" />
							Add Docker image
						</A>
						<A
							href={addHref("/new/database")}
							class="card card-interactive flex items-center gap-3 p-3.5 text-[13px] font-medium"
						>
							<Database width={16} height={16} class="text-fg-subtle" />
							Add database
						</A>
						<A
							href="/apps"
							class="card card-interactive flex items-center gap-3 p-3.5 text-[13px] font-medium"
						>
							<Store width={16} height={16} class="text-fg-subtle" />
							Add one-click app
						</A>
					</div>

					<Card title="Services" description={`${current().services.length} in this network`} flush>
						<ul class="divide-y divide-border">
							<For each={current().services}>
								{(service) => (
									<li class="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover">
										<A
											href={`/services/${service.id}`}
											class="flex min-w-0 flex-1 items-center gap-3"
										>
											<ServiceIcon type={service.service_type} />
											<div class="min-w-0">
												<div class="flex items-center gap-2">
													<span class="truncate text-[13.5px] font-medium">{service.name}</span>
													<Show when={isManaged(service)}>
														<Badge>{typeLabel(service.service_type)}</Badge>
													</Show>
												</div>
												<div class="truncate text-[12px] text-fg-subtle">
													<code>
														{service.internal_host ?? service.name}
														<Show when={service.port}>:{service.port}</Show>
													</code>
													<Show when={primaryUrl(service)}>
														{(url) => <> · {displayHost(url())}</>}
													</Show>
													<Show when={publicPorts(service).length > 0}>
														<span class="text-warning">
															{" "}
															· public TCP {publicPorts(service).join(", ")}
														</span>
													</Show>
												</div>
											</div>
										</A>
										<span class="hidden text-[12px] text-fg-faint md:block">
											{timeAgo(service.updated_at)}
										</span>
										<StatusBadge status={service.status} />
										<ServiceActions service={service} />
									</li>
								)}
							</For>
						</ul>
					</Card>

					<Modal
						open={renaming()}
						onClose={() => setRenaming(false)}
						title="Rename project"
						size="sm"
						footer={
							<>
								<Button variant="secondary" onClick={() => setRenaming(false)}>
									Cancel
								</Button>
								<Button
									variant="primary"
									loading={saving()}
									disabled={!draft().trim()}
									onClick={() => void rename()}
								>
									Save
								</Button>
							</>
						}
					>
						<Input
							autofocus
							value={draft()}
							onInput={(event) => setDraft(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void rename();
							}}
						/>
					</Modal>
				</div>
			)}
		</Show>
	);
};

export default ProjectDetail;
