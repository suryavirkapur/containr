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
import { CreateServiceCard } from "../components/CreateServiceCard";
import { EmptyBlock, LoadingBlock, Notice, PageTitle, Panel } from "../components/Plain";
import { StatusBadge } from "../components/StatusBadge";
import { useAppStore } from "../context/AppStore";
import { describeError, formatDateTime } from "../utils/format";
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

const Services = () => {
	const store = useAppStore();
	const [searchParams, setSearchParams] = useSearchParams();
	const [query, setQuery] = createSignal("");
	const [statusFilter, setStatusFilter] = createSignal("all");
	const [kindFilter, setKindFilter] = createSignal("all");
	const [actionError, setActionError] = createSignal<string | null>(null);

	createEffect(() => {
		void store.loadServices();
	});

	const pollInterval = setInterval(() => void store.loadServices(), 30000);
	onCleanup(() => clearInterval(pollInterval));

	const allServices = createMemo(() => store.state.services);
	const allGroups = createMemo(() => groupServices(allServices()));
	const attachableGroups = createMemo(() => listAttachableGroups(allServices()));

	const statusOptions = createMemo(() =>
		[...new Set(allServices().map((service) => service.status))].sort((left, right) =>
			left.localeCompare(right),
		),
	);
	const kindOptions = createMemo(() =>
		[...new Set(allServices().map((service) => service.resource_kind))].sort((left, right) =>
			left.localeCompare(right),
		),
	);

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

			if (statusFilter() !== "all" && service.status !== statusFilter()) {
				return false;
			}

			if (kindFilter() !== "all" && service.resource_kind !== kindFilter()) {
				return false;
			}

			if (activeGroup !== "all") {
				const currentKey = service.group_id ?? `isolated:${service.network_name}`;
				if (currentKey !== activeGroup) return false;
			}

			return true;
		});
	});

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
		<div class="flex flex-col gap-6">
			<PageTitle
				title="Services"
				subtitle="Homepage now mirrors CapRover's apps view, but uses containr services and your existing proxy/runtime."
				actions={
					<>
						<A href="/services/new" class="cr-btn cr-btn-primary">
							New Service
						</A>
						<button type="button" onClick={() => void store.loadServices()} class="cr-btn cr-btn-secondary">
							Refresh
						</button>
					</>
				}
			/>

			<Show when={actionError()}>{(message) => <Notice tone="error">{message()}</Notice>}</Show>

			<CreateServiceCard />

			<Panel title="Services" subtitle="Create services at the top, then manage the existing inventory here.">
				<div class="mb-5 grid gap-4 lg:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,0.8fr))]">
					<label class="cr-field">
						<span class="cr-label">Search</span>
						<input
							class="cr-input"
							value={query()}
							onInput={(event) => setQuery(event.currentTarget.value)}
							placeholder="Search by name, endpoint, or network..."
						/>
					</label>
					<label class="cr-field">
						<span class="cr-label">Status</span>
						<select class="cr-select" value={statusFilter()} onChange={(event) => setStatusFilter(event.currentTarget.value)}>
							<option value="all">All Statuses</option>
							<For each={statusOptions()}>
								{(status) => <option value={status}>{humanize(status)}</option>}
							</For>
						</select>
					</label>
					<label class="cr-field">
						<span class="cr-label">Kind</span>
						<select class="cr-select" value={kindFilter()} onChange={(event) => setKindFilter(event.currentTarget.value)}>
							<option value="all">All Kinds</option>
							<For each={kindOptions()}>
								{(kind) => <option value={kind}>{humanize(kind)}</option>}
							</For>
						</select>
					</label>
					<div class="flex items-end">
						<div class="rounded-md border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
							{allServices().length} total services, {attachableGroups().length} network groups
						</div>
					</div>
				</div>

				<div class="mb-6 flex flex-col gap-2">
					<span class="cr-label">Group</span>
					<div class="flex flex-wrap gap-2">
						<button
							type="button"
							class={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
								!searchParams.group
									? "border-primary/20 bg-accent text-accent-foreground"
									: "border-border bg-card text-muted-foreground hover:bg-secondary"
							}`}
							onClick={() => setGroupFilter("all")}
						>
							All Groups
						</button>
						<For each={allGroups()}>
							{(group) => (
								<button
									type="button"
									class={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
										searchParams.group === group.key
											? "border-primary/20 bg-accent text-accent-foreground"
											: "border-border bg-card text-muted-foreground hover:bg-secondary"
									}`}
									onClick={() => setGroupFilter(group.key)}
								>
									{group.filterLabel}
								</button>
							)}
						</For>
					</div>
				</div>
			</Panel>

			<Show when={store.state.servicesError}>
				<Notice tone="error">Failed to load services: {store.state.servicesError}</Notice>
			</Show>

			<Show when={store.state.servicesLoading} fallback={null}>
				<LoadingBlock message="Loading services..." />
			</Show>

			<Show when={!store.state.servicesLoading && filteredServices().length === 0}>
				<EmptyBlock title="No services match the current filters">
					Clear the filters or create a new service from a repo or a managed template.
				</EmptyBlock>
			</Show>

			<Show when={!store.state.servicesLoading && filteredServices().length > 0}>
				<Panel title="Service Inventory" subtitle="CapRover-style list view, adapted to groups and services.">
					<div class="overflow-x-auto">
						<table class="cr-table min-w-[980px]">
							<thead>
								<tr>
									<th>Service</th>
									<th>Endpoint</th>
									<th>Status</th>
									<th>Group</th>
									<th>Updated</th>
									<th>Open</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								<For each={filteredServices()}>
									{(service) => {
										const groupKey = service.group_id ?? `isolated:${service.network_name}`;
										const groupMeta = allGroups().find((group) => group.key === groupKey);

										return (
											<tr>
												<td>
													<div class="flex flex-col gap-1">
														<A class="text-sm font-semibold text-primary hover:underline" href={`/services/${service.id}`}>
															{service.name}
														</A>
														<div class="flex flex-wrap gap-2">
															<span class="cr-chip">{humanize(service.service_type)}</span>
															<span class="cr-chip">{humanize(service.resource_kind)}</span>
															<Show when={service.domains.length > 0}>
																<span class="cr-chip">{service.domains.length} domain{service.domains.length === 1 ? '' : 's'}</span>
															</Show>
														</div>
													</div>
												</td>
												<td>
													<div class="flex flex-col gap-1">
														<span class="font-code text-xs">{endpointFor(service)}</span>
														<span class="text-xs text-muted-foreground">
															{service.container_ids.length} container{service.container_ids.length === 1 ? '' : 's'}
														</span>
													</div>
												</td>
												<td>
													<StatusBadge status={service.status} />
												</td>
												<td>
													<div class="flex flex-col gap-1">
														<span class="text-sm font-medium">{groupMeta?.label ?? 'Isolated'}</span>
														<span class="font-code text-xs text-muted-foreground">{service.network_name}</span>
													</div>
												</td>
												<td class="text-sm text-muted-foreground">
													{formatDateTime(service.updated_at)}
												</td>
												<td>
													<A href={`/services/${service.id}`} class="text-sm font-medium text-primary hover:underline">
														Manage
													</A>
												</td>
												<td>
													<div class="flex flex-wrap gap-2">
														<button
															type="button"
															class="cr-btn cr-btn-secondary !px-3 !py-2 !text-xs disabled:opacity-50"
															onClick={() => void runAction(service.id, 'restart')}
															disabled={store.state.pendingServiceId === service.id}
														>
															Restart
														</button>
														<button
															type="button"
															class="cr-btn cr-btn-secondary !px-3 !py-2 !text-xs disabled:opacity-50"
															onClick={() =>
																void runAction(
																	service.id,
																	service.running_instances > 0 ? 'stop' : 'start',
																)
															}
															disabled={store.state.pendingServiceId === service.id}
														>
															{service.running_instances > 0 ? 'Stop' : 'Start'}
														</button>
														<Show when={groupMeta?.id}>
															<A
																href={`/services/new?group_id=${groupMeta!.id!}&group_name=${encodeURIComponent(groupMeta!.label)}`}
																class="cr-btn cr-btn-secondary !px-3 !py-2 !text-xs"
															>
																Add Managed
															</A>
														</Show>
													</div>
												</td>
											</tr>
										);
									}}
								</For>
							</tbody>
						</table>
					</div>
				</Panel>
			</Show>
		</div>
	);
};

export default Services;
