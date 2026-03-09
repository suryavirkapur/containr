import {
	Component,
	createMemo,
	createResource,
	createSignal,
	For,
	Show,
} from "solid-js";
import { A } from "@solidjs/router";
import { Badge } from "../components/ui/Badge";
import SystemMonitor from "../components/SystemMonitor";
import { api, type components } from "../api";

type Project = components["schemas"]["AppResponse"];

/// fetches projects from the api
const fetchProjects = async (): Promise<Project[]> => {
	const { data, error } = await api.GET("/api/projects");
	if (error) throw new Error("failed to fetch projects");
	return data ?? [];
};

/// formats a date string as relative time
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

/// determines runtime label from service config
const runtimeLabel = (project: Project): string => {
	if (!project.services || project.services.length === 0) return "docker";
	const svc = project.services[0];
	// if image is set, it's a prebuilt image
	if (svc.image) return "docker";
	// if dockerfile_path contains rust-related hints
	if (svc.dockerfile_path) return "docker";
	return "docker";
};

/// service type icon based on service_type
const ServiceIcon: Component<{ type: string }> = (props) => {
	// web_service = globe, private_service = lock, background_worker = gear
	const iconPath = () => {
		switch (props.type) {
			case "web_service":
				// globe icon
				return "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z";
			case "private_service":
				// lock icon
				return "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z";
			default:
				// gear icon
				return "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z";
		}
	};

	return (
		<svg
			class="w-4 h-4 text-neutral-400 shrink-0"
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d={iconPath()} />
		</svg>
	);
};

type FilterTab = "active" | "suspended" | "all";

/// dashboard page showing all projects
const Dashboard: Component = () => {
	const [apps] = createResource(fetchProjects);
	const [filter, setFilter] = createSignal<FilterTab>("all");
	const [search, setSearch] = createSignal("");

	// flatten all services from all projects into rows
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
				for (const svc of project.services) {
					rows.push({
						project,
						serviceName: svc.name || project.name,
						serviceType: svc.service_type,
						runtime: runtimeLabel(project),
					});
				}
			} else {
				rows.push({
					project,
					serviceName: project.name,
					serviceType: "web_service",
					runtime: runtimeLabel(project),
				});
			}
		}

		return rows;
	});

	// filtered list
	const filteredRows = createMemo(() => {
		let rows = serviceRows();
		const q = search().toLowerCase().trim();

		if (q) {
			rows = rows.filter(
				(row) =>
					row.serviceName.toLowerCase().includes(q) ||
					row.project.name.toLowerCase().includes(q),
			);
		}

		// filter tab - we don't have a status field on the project itself,
		// so "active" means all for now, "suspended" is empty
		if (filter() === "active") return rows;
		if (filter() === "suspended") return [];

		return rows;
	});

	const counts = createMemo(() => ({
		active: serviceRows().length,
		suspended: 0,
		all: serviceRows().length,
	}));

	return (
		<div>
			{/* system monitor */}
			<SystemMonitor />

			{/* header */}
			<div class="mb-6">
				<h1 class="text-xl font-semibold text-white mb-1">
					ungrouped services
				</h1>
			</div>

			{/* filter tabs */}
			<div class="flex items-center gap-1 mb-4">
				<button
					class={`px-3 py-1.5 text-xs font-medium border transition-colors cursor-pointer ${filter() === "active"
							? "bg-purple-600/20 text-purple-400 border-purple-600/40"
							: "bg-transparent text-neutral-400 border-neutral-700 hover:text-white"
						}`}
					onClick={() => setFilter("active")}
				>
					active ({counts().active})
				</button>
				<button
					class={`px-3 py-1.5 text-xs font-medium border transition-colors cursor-pointer ${filter() === "suspended"
							? "bg-purple-600/20 text-purple-400 border-purple-600/40"
							: "bg-transparent text-neutral-400 border-neutral-700 hover:text-white"
						}`}
					onClick={() => setFilter("suspended")}
				>
					suspended ({counts().suspended})
				</button>
				<button
					class={`px-3 py-1.5 text-xs font-medium border transition-colors cursor-pointer ${filter() === "all"
							? "bg-purple-600/20 text-purple-400 border-purple-600/40"
							: "bg-transparent text-neutral-400 border-neutral-700 hover:text-white"
						}`}
					onClick={() => setFilter("all")}
				>
					all ({counts().all})
				</button>
			</div>

			{/* search */}
			<div class="mb-4">
				<div class="relative">
					<svg
						class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
						/>
					</svg>
					<input
						type="text"
						placeholder="search services"
						value={search()}
						onInput={(e) => setSearch(e.currentTarget.value)}
						class="w-full bg-[#12121a] border border-neutral-700 text-neutral-200 text-sm pl-10 pr-4 py-2.5 placeholder:text-neutral-500 focus:outline-none focus:border-purple-500 transition-colors"
					/>
				</div>
			</div>

			{/* loading */}
			<Show when={apps.loading}>
				<div class="border border-neutral-800 bg-[#12121a]">
					<For each={[1, 2, 3]}>
						{() => (
							<div class="px-6 py-4 border-b border-neutral-800 animate-pulse">
								<div class="h-4 bg-neutral-800 w-1/4"></div>
							</div>
						)}
					</For>
				</div>
			</Show>

			{/* empty state */}
			<Show when={!apps.loading && apps()?.length === 0}>
				<div class="border border-dashed border-neutral-700 p-12 text-center bg-[#12121a]">
					<div class="w-12 h-12 mx-auto mb-4 border border-neutral-700 flex items-center justify-center bg-[#0a0a0f]">
						<svg
							class="w-6 h-6 text-neutral-500"
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
					</div>
					<h3 class="text-lg font-serif text-white mb-2">
						no services yet
					</h3>
					<p class="text-neutral-400 mb-6 text-sm">
						deploy your first service from a repository
					</p>
					<A
						href="/projects/new"
						class="inline-flex items-center px-4 py-2 bg-white text-black text-sm font-medium hover:bg-neutral-200 transition-colors"
					>
						deploy your first service
					</A>
				</div>
			</Show>

			{/* service table */}
			<Show when={!apps.loading && apps() && apps()!.length > 0}>
				<div class="border border-neutral-800 bg-[#12121a]">
					{/* table header */}
					<div class="grid grid-cols-[1fr_140px_100px_120px] gap-4 px-6 py-3 border-b border-neutral-800 text-xs font-mono uppercase tracking-wider text-neutral-500">
						<div class="flex items-center gap-1">
							service name
							<span class="ml-1 bg-neutral-700 text-neutral-300 px-1.5 py-0.5 text-[10px]">
								{filteredRows().length}
							</span>
						</div>
						<div>status</div>
						<div>runtime</div>
						<div>updated</div>
					</div>

					{/* table rows */}
					<For each={filteredRows()}>
						{(row) => (
							<A
								href={`/projects/${row.project.id}`}
								class="grid grid-cols-[1fr_140px_100px_120px] gap-4 px-6 py-3.5 border-b border-neutral-800 hover:bg-[#1a1a25] transition-colors items-center group"
							>
								{/* service name */}
								<div class="flex items-center gap-3 min-w-0">
									<ServiceIcon type={row.serviceType} />
									<span class="text-neutral-100 text-sm font-medium truncate group-hover:text-white group-hover:underline underline-offset-4 decoration-1">
										{row.serviceName}
									</span>
								</div>

								{/* status */}
								<div>
									<span class="inline-flex items-center gap-1.5 text-xs">
										<span class="w-1.5 h-1.5 bg-emerald-400"></span>
										<span class="text-emerald-400">
											running
										</span>
									</span>
								</div>

								{/* runtime */}
								<div>
									<Badge
										variant="default"
										class="text-[11px]"
									>
										{row.runtime}
									</Badge>
								</div>

								{/* updated */}
								<div class="text-sm text-neutral-400">
									{timeAgo(row.project.created_at)}
								</div>
							</A>
						)}
					</For>

					{/* empty filtered state */}
					<Show when={filteredRows().length === 0 && serviceRows().length > 0}>
						<div class="px-6 py-8 text-center text-neutral-500 text-sm">
							no services match your search
						</div>
					</Show>
				</div>
			</Show>
		</div>
	);
};

export default Dashboard;
