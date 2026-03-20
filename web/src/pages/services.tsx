import { A, useSearchParams } from "@solidjs/router";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import type { Service } from "../api/services";
import {
	EmptyBlock,
	LoadingBlock,
	Notice,
	PageTitle,
} from "../components/Plain";
import { StatusBadge } from "../components/StatusBadge";
import { useAppStore } from "../context/AppStore";
import {
	describeError,
	formatDateTime,
} from "../utils/format";
import { groupServices, humanize, listAttachableGroups } from "../utils/service-groups";

const endpointFor = (service: Service): string => {
	return (
		service.default_urls[0] ??
		service.proxy_connection_string ??
		service.connection_string ??
		(service.internal_host && service.port
			? `${service.internal_host}:${service.port}`
			: "internal only")
	);
};

const isUrl = (s: string) =>
	s.startsWith("http://") || s.startsWith("https://");

const Services = () => {
	const store = useAppStore();
	const [searchParams, setSearchParams] = useSearchParams();
	const [query, setQuery] = createSignal("");
	const [actionError, setActionError] = createSignal<string | null>(null);

	createEffect(() => {
		void store.loadServices();
	});

	const pollInterval = setInterval(() => void store.loadServices(), 30000);
	onCleanup(() => clearInterval(pollInterval));

	const allServices = createMemo(() => store.state.services);
	const allGroups = createMemo(() => groupServices(allServices()));
	const attachableGroups = createMemo(() => listAttachableGroups(allServices()));

	const filteredServices = createMemo(() => {
		const needle = query().trim().toLowerCase();
		const activeGroup = searchParams.group ?? "all";

		return allServices().filter((service) => {
			if (
				needle &&
				![
					service.name,
					service.service_type,
					service.resource_kind,
					service.network_name,
					service.project_name ?? "",
					endpointFor(service),
				]
					.join(" ")
					.toLowerCase()
					.includes(needle)
			) {
				return false;
			}

			if (activeGroup !== "all") {
				const currentKey = service.group_id ?? `isolated:${service.network_name}`;
				if (currentKey !== activeGroup) return false;
			}

			return true;
		});
	});

	const groupedServices = createMemo(() => groupServices(filteredServices()));

	const runAction = async (id: string, action: "start" | "stop" | "restart") => {
		setActionError(null);
		try {
			await store.runAction(id, action);
			void store.loadServices();
		} catch (error) {
			setActionError(describeError(error));
		}
	};

	const setGroupFilter = (value: string) => {
		setSearchParams({ group: value === "all" ? undefined : value });
	};

	return (
		<div class="flex flex-col gap-5">
			<PageTitle
				title="Services"
				actions={
					<>
						<A
							href="/services/new"
							class="inline-flex items-center px-3 py-1.5 text-xs font-medium border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
						>
							+ New Service
						</A>
						<button
							type="button"
							onClick={() => void store.loadServices()}
							class="inline-flex items-center px-3 py-1.5 text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
						>
							Refresh
						</button>
					</>
				}
			/>

			<Show when={actionError()}>
				{(message) => <Notice tone="error">{message()}</Notice>}
			</Show>

			{/* Filter bar */}
			<div class="flex flex-col gap-3">
				<input
					class="flex h-8 w-full max-w-sm border border-border bg-card px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
					placeholder="Filter services..."
				/>
				<div class="flex flex-wrap gap-1.5">
					<button
						type="button"
						class={`px-2.5 py-1 text-xs border transition-colors ${
							!searchParams.group
								? "border-foreground/30 bg-secondary text-foreground"
								: "border-border text-muted-foreground hover:text-foreground"
						}`}
						onClick={() => setGroupFilter("all")}
					>
						All
					</button>
					<For each={allGroups()}>
						{(group) => (
							<button
								type="button"
								class={`px-2.5 py-1 text-xs border transition-colors ${
									searchParams.group === group.key
										? "border-foreground/30 bg-secondary text-foreground"
										: "border-border text-muted-foreground hover:text-foreground"
								}`}
								onClick={() => setGroupFilter(group.key)}
							>
								{group.filterLabel}
							</button>
						)}
					</For>
				</div>
			</div>

			<Show when={store.state.servicesError}>
				<Notice tone="error">
					Failed to load services: {store.state.servicesError}
				</Notice>
			</Show>

			<Show when={store.state.servicesLoading}>
				<LoadingBlock message="Loading services..." />
			</Show>

			<Show when={!store.state.servicesLoading && filteredServices().length === 0}>
				<EmptyBlock title="No services found">
					Create a new service or adjust your filter.
				</EmptyBlock>
			</Show>

			<Show when={!store.state.servicesLoading && filteredServices().length > 0}>
				<div class="flex flex-col gap-6">
					<For each={groupedServices()}>
						{(group) => (
							<div class="flex flex-col gap-1">
								{/* Group header */}
								<div class="flex items-center justify-between mb-2">
									<div class="flex items-center gap-3">
										<span class="text-xs font-medium text-foreground">
											{group.label}
										</span>
										<span class="text-xs font-mono text-muted-foreground">
											{group.networkName}
										</span>
										<span class="text-xs text-muted-foreground">
											{group.services.length} service
											{group.services.length === 1 ? "" : "s"}
										</span>
									</div>
									<Show when={group.id}>
										<A
											href={`/services/new?group_id=${group.id!}&group_name=${encodeURIComponent(group.label)}`}
											class="text-xs text-muted-foreground hover:text-foreground transition-colors"
										>
											+ Add
										</A>
									</Show>
								</div>

								{/* Service rows */}
								<div class="border border-border divide-y divide-border">
									<For each={group.services}>
										{(service) => (
											<div class="flex items-center gap-4 px-4 py-3 bg-card hover:bg-secondary/30 transition-colors">
												{/* Status dot */}
												<StatusBadge status={service.status} />

												{/* Name + type */}
												<div class="flex-1 min-w-0">
													<A
														class="text-sm font-medium hover:underline truncate block"
														href={`/services/${service.id}`}
													>
														{service.name}
													</A>
													<p class="text-xs text-muted-foreground mt-0.5">
														{humanize(service.service_type)}
													</p>
												</div>

												{/* Endpoint / domains */}
												<div class="hidden sm:flex items-center gap-2 shrink-0">
													<Show
														when={isUrl(endpointFor(service))}
														fallback={
															<span class="text-xs font-mono text-muted-foreground">
																{endpointFor(service)}
															</span>
														}
													>
														<a
															href={endpointFor(service)}
															target="_blank"
															rel="noopener noreferrer"
															class="text-xs font-mono text-muted-foreground hover:text-foreground hover:underline transition-colors"
														>
															{endpointFor(service)}
														</a>
													</Show>
													<Show when={service.domains.length > 0}>
														<span class="text-xs text-muted-foreground">
															+{service.domains.length} domain
															{service.domains.length === 1 ? "" : "s"}
														</span>
													</Show>
												</div>

												{/* Updated */}
												<div class="hidden lg:block text-xs text-muted-foreground shrink-0 w-28 text-right">
													{formatDateTime(service.updated_at)}
												</div>

												{/* Actions */}
												<div class="flex items-center gap-1 shrink-0">
													<button
														type="button"
														class="px-2 py-1 text-xs border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
														onClick={() => void runAction(service.id, "restart")}
														disabled={store.state.pendingServiceId === service.id}
													>
														Restart
													</button>
													<button
														type="button"
														class="px-2 py-1 text-xs border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
														onClick={() =>
															void runAction(
																service.id,
																service.running_instances > 0 ? "stop" : "start",
															)
														}
														disabled={store.state.pendingServiceId === service.id}
													>
														{service.running_instances > 0 ? "Stop" : "Start"}
													</button>
													<A
														href={`/services/${service.id}`}
														class="px-2 py-1 text-xs border border-border text-muted-foreground hover:text-foreground transition-colors"
													>
														Open
													</A>
												</div>
											</div>
										)}
									</For>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
};

export default Services;
