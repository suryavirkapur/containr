import { Component, createResource, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import SystemMonitor from "../components/SystemMonitor";
import { api, type components } from "../api";

type Project = components["schemas"]["AppResponse"];

/**
 * fetches projects from the api
 */
const fetchProjects = async (): Promise<Project[]> => {
	const { data, error } = await api.GET("/api/projects");
	if (error) throw new Error("failed to fetch projects");
	return data ?? [];
};

/**
 * dashboard page showing all projects
 */
const Dashboard: Component = () => {
	const [apps] = createResource(fetchProjects);

	return (
		<div>
			{/* system monitor */}
			<SystemMonitor />

			{/* header */}
			<div class="flex justify-between items-center mb-10">
				<div>
					<h1 class="text-3xl font-serif font-medium text-black">
						your projects
					</h1>
					<p class="text-neutral-500 mt-1 text-sm font-light">
						each project can group one or more services behind a single deploy
						flow
					</p>
				</div>
				<A href="/projects/new">
					<Button class="gap-2">
						<svg
							class="w-4 h-4"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M12 4v16m8-8H4"
							/>
						</svg>
						new project
					</Button>
				</A>
			</div>

			{/* loading state */}
			<Show when={apps.loading}>
				<div class="space-y-4">
					<For each={[1, 2, 3]}>
						{() => (
							<div class="border border-neutral-100 p-6 animate-pulse">
								<div class="h-5 bg-neutral-100 w-1/4 mb-3"></div>
								<div class="h-4 bg-neutral-50 w-1/2"></div>
							</div>
						)}
					</For>
				</div>
			</Show>

			{/* empty state */}
			<Show when={!apps.loading && apps()?.length === 0}>
				<div class="border border-dashed border-neutral-300 p-12 text-center bg-neutral-50/50">
					<div class="w-12 h-12 mx-auto mb-4 border border-neutral-300 flex items-center justify-center bg-white">
						<svg
							class="w-6 h-6 text-neutral-400"
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
					<h3 class="text-lg font-serif text-black mb-2">no projects yet</h3>
					<p class="text-neutral-500 mb-6 text-sm font-light">
						create a project and define one or more services from a repository
					</p>
					<A href="/projects/new">
						<Button>create new project</Button>
					</A>
				</div>
			</Show>

			{/* project list */}
			<Show when={!apps.loading && apps() && apps()!.length > 0}>
				<div class="grid gap-4">
					<For each={apps()}>
						{(app) => (
							<A href={`/projects/${app.id}`} class="block group">
								<Card
									variant="hover"
									class="transition-all hover:bg-neutral-50"
								>
									<div class="p-6 flex items-center justify-between">
										<div class="flex items-center gap-4">
											{/* status indicator */}
											<span class="w-2.5 h-2.5 bg-black"></span>

											{/* project info */}
											<div>
												<h3 class="text-black font-medium text-lg leading-none group-hover:underline decoration-1 underline-offset-4">
													{app.name}
												</h3>
												<div class="mt-1.5 flex items-center gap-3 text-xs">
													<p class="font-mono text-neutral-500">
														{app.github_url}
													</p>
													<span class="text-neutral-300">/</span>
													<span class="text-neutral-600">
														{app.services.length} service
														{app.services.length === 1 ? "" : "s"}
													</span>
												</div>
											</div>
										</div>

										<div class="flex items-center gap-6 text-sm text-neutral-500">
											{/* domains */}
											<Show
												when={
													(app.domains && app.domains.length > 0) || app.domain
												}
											>
												<span class="text-neutral-900 font-medium">
													{(() => {
														const domains =
															app.domains && app.domains.length > 0
																? app.domains
																: app.domain
																	? [app.domain]
																	: [];
														if (domains.length <= 1) return domains[0];
														return `${domains[0]} +${domains.length - 1}`;
													})()}
												</span>
											</Show>

											{/* branch */}
											<Badge variant="secondary" class="font-mono text-xs">
												{app.branch}
											</Badge>

											{/* arrow */}
											<svg
												class="w-4 h-4 text-neutral-300 group-hover:text-black transition-colors"
												fill="none"
												stroke="currentColor"
												viewBox="0 0 24 24"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M17 8l4 4m0 0l-4 4m4-4H3"
												/>
											</svg>
										</div>
									</div>
								</Card>
							</A>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
};

export default Dashboard;
