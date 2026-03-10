import {
	Component,
	createMemo,
	createResource,
	createSignal,
	For,
	Show,
} from "solid-js";
import { A } from "@solidjs/router";

import { api, type components } from "../api";
import SystemMonitor from "../components/SystemMonitor";
import {
	Badge,
	Button,
	Card,
	CardContent,
	EmptyState,
	Input,
	PageHeader,
	Skeleton,
	Tabs,
	TabsList,
	TabsTrigger,
} from "../components/ui";

type Project = components["schemas"]["AppResponse"];
type FilterTab = "active" | "suspended" | "all";

const fetchProjects = async (): Promise<Project[]> => {
	const { data, error } = await api.GET("/api/projects");
	if (error) throw new Error("failed to fetch projects");
	return data ?? [];
};

const timeAgo = (dateStr: string): string => {
	const date = new Date(dateStr);
	const now = new Date();
	const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	const years = Math.floor(days / 365);
	return `${years}y ago`;
};

const runtimeLabel = (_project: Project): string => "docker";

const ServiceIcon: Component<{ type: string }> = (props) => {
	const iconPath = () => {
		switch (props.type) {
			case "web_service":
				return "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z";
			case "private_service":
				return "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z";
			default:
				return "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z";
		}
	};

	return (
		<div class="flex h-10 w-10 items-center justify-center border border-[var(--border)] bg-[var(--muted)]">
			<svg
				class="h-4 w-4 text-[var(--muted-foreground)]"
				viewBox="0 0 24 24"
				fill="currentColor"
			>
				<path d={iconPath()} />
			</svg>
		</div>
	);
};

const Dashboard: Component = () => {
	const [apps] = createResource(fetchProjects);
	const [filter, setFilter] = createSignal<FilterTab>("all");
	const [search, setSearch] = createSignal("");

	const serviceRows = createMemo(() => {
		const projects = apps() || [];
		const rows: {
			project: Project;
			serviceName: string;
			serviceType: string;
			runtime: string;
		}[] = [];

		for (const project of projects) {
			if (project.services && project.services.length > 0) {
				for (const service of project.services) {
					rows.push({
						project,
						serviceName: service.name || project.name,
						serviceType: service.service_type,
						runtime: runtimeLabel(project),
					});
				}
				continue;
			}

			rows.push({
				project,
				serviceName: project.name,
				serviceType: "web_service",
				runtime: runtimeLabel(project),
			});
		}

		return rows;
	});

	const filteredRows = createMemo(() => {
		let rows = serviceRows();
		const query = search().toLowerCase().trim();

		if (query) {
			rows = rows.filter(
				(row) =>
					row.serviceName.toLowerCase().includes(query) ||
					row.project.name.toLowerCase().includes(query),
			);
		}

		if (filter() === "suspended") return [];
		return rows;
	});

	const counts = createMemo(() => ({
		active: serviceRows().length,
		suspended: 0,
		all: serviceRows().length,
	}));

	return (
		<div class="space-y-8">
			<PageHeader
				eyebrow="control plane"
				title="services"
				description="browse every service across your groups, monitor host capacity, and jump directly into the runtime that is currently serving traffic."
				actions={
					<A href="/projects/new">
						<Button>new service</Button>
					</A>
				}
			/>

			<SystemMonitor />

			<Card>
				<CardContent class="space-y-6">
					<div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
						<Tabs value={filter()} onValueChange={(value) => setFilter(value as FilterTab)}>
							<TabsList>
								<TabsTrigger value="active">
									active <span class="text-[10px]">({counts().active})</span>
								</TabsTrigger>
								<TabsTrigger value="suspended">
									suspended <span class="text-[10px]">({counts().suspended})</span>
								</TabsTrigger>
								<TabsTrigger value="all">
									all <span class="text-[10px]">({counts().all})</span>
								</TabsTrigger>
							</TabsList>
						</Tabs>

						<div class="w-full md:max-w-sm">
							<Input
								value={search()}
								onInput={(event) => setSearch(event.currentTarget.value)}
								placeholder="search services or groups"
							/>
						</div>
					</div>

					<Show when={apps.loading}>
						<div class="space-y-3">
							<For each={[1, 2, 3, 4]}>
								{() => <Skeleton class="h-18 w-full" />}
							</For>
						</div>
					</Show>

					<Show when={!apps.loading && apps()?.length === 0}>
						<EmptyState
							title="no services yet"
							description="connect a repository, define a service, and let containr build and deploy it."
							action={
								<A href="/projects/new">
									<Button>deploy your first service</Button>
								</A>
							}
							icon={
								<svg
									class="h-6 w-6"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="1.5"
										d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
									/>
								</svg>
							}
						/>
					</Show>

					<Show when={!apps.loading && apps() && apps()!.length > 0}>
						<div class="overflow-hidden border border-[var(--border)]">
							<div class="grid grid-cols-[1fr_120px_120px_120px] gap-4 border-b border-[var(--border)] bg-[var(--muted)] px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--muted-foreground)]">
								<div>service</div>
								<div>status</div>
								<div>runtime</div>
								<div>updated</div>
							</div>

							<For each={filteredRows()}>
								{(row) => (
									<A
										href={`/projects/${row.project.id}`}
										class="grid grid-cols-[1fr_120px_120px_120px] gap-4 border-b border-[var(--border)] bg-[var(--card)] px-5 py-4 transition-colors hover:bg-[var(--surface-muted)]"
									>
										<div class="flex min-w-0 items-center gap-3">
											<ServiceIcon type={row.serviceType} />
											<div class="min-w-0">
												<p class="truncate text-sm font-semibold text-[var(--foreground)]">
													{row.serviceName}
												</p>
												<p class="truncate text-xs uppercase tracking-[0.16em] text-[var(--muted-foreground)]">
													{row.project.name}
												</p>
											</div>
										</div>
										<div class="flex items-center">
											<Badge variant="success">running</Badge>
										</div>
										<div class="flex items-center">
											<Badge variant="secondary">{row.runtime}</Badge>
										</div>
										<div class="flex items-center text-sm text-[var(--muted-foreground)]">
											{timeAgo(row.project.created_at)}
										</div>
									</A>
								)}
							</For>

							<Show when={filteredRows().length === 0 && serviceRows().length > 0}>
								<div class="px-6 py-10 text-center text-sm text-[var(--muted-foreground)]">
									no services match the current search
								</div>
							</Show>
						</div>
					</Show>
				</CardContent>
			</Card>
		</div>
	);
};

export default Dashboard;
