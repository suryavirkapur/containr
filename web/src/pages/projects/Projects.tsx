import { A } from "@solidjs/router";
import FolderKanban from "lucide-solid/icons/folder-kanban";
import Network from "lucide-solid/icons/network";
import Plus from "lucide-solid/icons/plus";
import { createMemo, For, Show } from "solid-js";
import type { Service } from "../../api/services";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import { EmptyState, LinkButton, PageHeader, Skeleton, StatusDot } from "../../components/ui";
import { useAppStore } from "../../context/AppStore";
import { timeAgo } from "../../lib/format";
import { ServiceIcon } from "../../lib/services";

export type ProjectSummary = {
	id: string;
	name: string;
	network: string;
	services: Service[];
	updated: string;
};

export const useProjectSummaries = () => {
	const store = useAppStore();
	return createMemo(() => {
		const map = new Map<string, ProjectSummary>();
		for (const service of store.state.services) {
			if (!service.group_id) continue;
			const existing = map.get(service.group_id);
			if (existing) {
				existing.services.push(service);
				if (service.updated_at > existing.updated) existing.updated = service.updated_at;
				if (service.resource_kind === "app_service" && service.project_name)
					existing.name = service.project_name;
			} else {
				map.set(service.group_id, {
					id: service.group_id,
					name: service.project_name ?? service.name,
					network: service.network_name,
					services: [service],
					updated: service.updated_at,
				});
			}
		}
		return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
	});
};

const Projects = () => {
	useBreadcrumbs(() => [{ label: "Projects" }]);
	const store = useAppStore();
	const projects = useProjectSummaries();
	const isolated = () => store.state.services.filter((service) => !service.group_id);

	return (
		<div class="animate-fade-in">
			<PageHeader
				title="Projects"
				description="A project is a private network. Services inside it reach each other by name; everything else is isolated."
				actions={
					<LinkButton href="/new" variant="primary">
						<Plus />
						New project
					</LinkButton>
				}
			/>
			<Show
				when={store.loaded()}
				fallback={
					<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						<Skeleton class="h-36" />
						<Skeleton class="h-36" />
						<Skeleton class="h-36" />
					</div>
				}
			>
				<Show
					when={projects().length > 0}
					fallback={
						<EmptyState
							icon={<FolderKanban />}
							title="No projects yet"
							description="Your first service creates a project. Add databases and other services to it later."
						>
							<LinkButton href="/new" variant="primary">
								<Plus />
								New service
							</LinkButton>
						</EmptyState>
					}
				>
					<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						<For each={projects()}>
							{(project) => (
								<A href={`/projects/${project.id}`} class="card card-interactive flex flex-col p-5">
									<div class="flex items-center justify-between gap-3">
										<div class="min-w-0">
											<div class="truncate text-[15px] font-semibold">{project.name}</div>
											<div class="mt-0.5 flex items-center gap-1.5 text-[12px] text-fg-subtle">
												<Network width={12} height={12} />
												<span class="truncate font-mono">{project.network}</span>
											</div>
										</div>
										<div class="flex -space-x-1.5">
											<For each={project.services.slice(0, 4)}>
												{(service) => (
													<span class="rounded-md ring-2 ring-[var(--surface)]">
														<ServiceIcon type={service.service_type} size="sm" />
													</span>
												)}
											</For>
										</div>
									</div>
									<ul class="mt-4 space-y-1.5">
										<For each={project.services.slice(0, 4)}>
											{(service) => (
												<li class="flex items-center gap-2 text-[13px]">
													<StatusDot status={service.status} />
													<span class="truncate">{service.name}</span>
												</li>
											)}
										</For>
										<Show when={project.services.length > 4}>
											<li class="text-[12px] text-fg-faint">+{project.services.length - 4} more</li>
										</Show>
									</ul>
									<div class="mt-auto pt-4 text-[12px] text-fg-faint">
										Updated {timeAgo(project.updated)}
									</div>
								</A>
							)}
						</For>
					</div>
				</Show>
				<Show when={isolated().length > 0}>
					<h2 class="mt-10 mb-3 text-[13px] font-medium text-fg-subtle">Not in a project</h2>
					<div class="card divide-y divide-border">
						<For each={isolated()}>
							{(service) => (
								<A
									href={`/services/${service.id}`}
									class="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover"
								>
									<ServiceIcon type={service.service_type} size="sm" />
									<span class="flex-1 truncate text-[13px] font-medium">{service.name}</span>
									<StatusDot status={service.status} />
								</A>
							)}
						</For>
					</div>
				</Show>
			</Show>
		</div>
	);
};

export default Projects;
