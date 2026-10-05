import { A, useNavigate, useSearchParams } from "@solidjs/router";
import Boxes from "lucide-solid/icons/boxes";
import MoreHorizontal from "lucide-solid/icons/ellipsis";
import ExternalLink from "lucide-solid/icons/external-link";
import LayoutGrid from "lucide-solid/icons/layout-grid";
import List from "lucide-solid/icons/list";
import Play from "lucide-solid/icons/play";
import Plus from "lucide-solid/icons/plus";
import RotateCw from "lucide-solid/icons/rotate-cw";
import Search from "lucide-solid/icons/search";
import Square from "lucide-solid/icons/square";
import Trash from "lucide-solid/icons/trash";
import { type Component, createMemo, For, Match, Show, Switch } from "solid-js";
import type { Service } from "../../api/services";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Badge,
	cx,
	EmptyState,
	Input,
	LinkButton,
	PageHeader,
	Segmented,
	Select,
	Skeleton,
	StatusBadge,
} from "../../components/ui";
import { confirm, DropdownMenu, toast } from "../../components/ui/overlay";
import { useAppStore } from "../../context/AppStore";
import { timeAgo } from "../../lib/format";
import {
	displayHost,
	instancesLabel,
	isManaged,
	primaryUrl,
	publicPorts,
	ServiceIcon,
	typeLabel,
} from "../../lib/services";

type Kind = "all" | "apps" | "data";
type View = "list" | "grid";

const readParam = (value: string | string[] | undefined) =>
	(Array.isArray(value) ? value[0] : value) ?? "";

export const ServiceActions: Component<{ service: Service }> = (props) => {
	const store = useAppStore();
	const navigate = useNavigate();

	const act = async (action: "start" | "stop" | "restart") => {
		try {
			await store.runAction(props.service.id, action);
			toast.success(
				`${action === "stop" ? "Stopping" : action === "start" ? "Starting" : "Restarting"} ${props.service.name}`,
			);
		} catch (error) {
			toast.error(`Could not ${action} ${props.service.name}`, error);
		}
	};

	const remove = async () => {
		const ok = await confirm({
			title: `Delete ${props.service.name}?`,
			description: isManaged(props.service)
				? "The container and its data volume are removed. This cannot be undone."
				: "All containers, deployments and logs for this service are removed. This cannot be undone.",
			confirmLabel: "Delete service",
			danger: true,
			typeToConfirm: props.service.name,
		});
		if (!ok) return;
		try {
			await store.removeService(props.service.id);
			toast.success(`Deleted ${props.service.name}`);
		} catch (error) {
			toast.error("Delete failed", error);
		}
	};

	return (
		<DropdownMenu
			trigger={(trigger) => (
				<button
					type="button"
					class="btn btn-ghost btn-icon btn-sm"
					aria-label="Service actions"
					{...trigger}
				>
					<MoreHorizontal />
				</button>
			)}
			items={[
				{
					label: "Open",
					icon: <Boxes />,
					onSelect: () => navigate(`/services/${props.service.id}`),
				},
				...(primaryUrl(props.service)
					? [
							{
								label: "Visit site",
								icon: <ExternalLink />,
								onSelect: () => window.open(primaryUrl(props.service) ?? "", "_blank", "noopener"),
							},
						]
					: []),
				{ separator: true as const },
				props.service.status === "stopped"
					? { label: "Start", icon: <Play />, onSelect: () => void act("start") }
					: { label: "Stop", icon: <Square />, onSelect: () => void act("stop") },
				{ label: "Restart", icon: <RotateCw />, onSelect: () => void act("restart") },
				{ separator: true as const },
				{ label: "Delete", icon: <Trash />, danger: true, onSelect: () => void remove() },
			]}
		/>
	);
};

const Services = () => {
	useBreadcrumbs(() => [{ label: "Services" }]);
	const store = useAppStore();
	const navigate = useNavigate();
	const [params, setParams] = useSearchParams();

	const query = () => readParam(params.q);
	const kind = () => (readParam(params.kind) || "all") as Kind;
	const project = () => readParam(params.project);
	const view = () => (readParam(params.view) || "list") as View;

	const projects = createMemo(() => {
		const seen = new Map<string, string>();
		for (const service of store.state.services) {
			if (service.group_id) seen.set(service.group_id, service.project_name ?? "Untitled project");
		}
		return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
	});

	const filtered = createMemo(() => {
		const needle = query().trim().toLowerCase();
		return store.state.services
			.filter((service) => {
				if (kind() === "apps" && isManaged(service)) return false;
				if (kind() === "data" && !isManaged(service)) return false;
				if (project() && service.group_id !== project()) return false;
				if (!needle) return true;
				return [service.name, service.project_name ?? "", service.image ?? "", ...service.domains]
					.join(" ")
					.toLowerCase()
					.includes(needle);
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	});

	return (
		<div class="animate-fade-in">
			<PageHeader
				title="Services"
				description="Apps, workers, cron jobs and databases running on this server."
				actions={
					<LinkButton href="/new" variant="primary">
						<Plus />
						New service
					</LinkButton>
				}
			/>

			<div class="mb-4 flex flex-wrap items-center gap-2">
				<div class="relative min-w-[220px] flex-1">
					<Search
						width={15}
						height={15}
						class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint"
					/>
					<Input
						class="pl-8"
						placeholder="Filter by name, image or domain"
						value={query()}
						onInput={(event) =>
							setParams({ q: event.currentTarget.value || undefined }, { replace: true })
						}
					/>
				</div>
				<Select
					class="w-auto min-w-[160px]"
					value={project()}
					onChange={(event) => setParams({ project: event.currentTarget.value || undefined })}
				>
					<option value="">All projects</option>
					<For each={projects()}>{([id, name]) => <option value={id}>{name}</option>}</For>
				</Select>
				<Segmented<Kind>
					value={kind()}
					onChange={(value) => setParams({ kind: value === "all" ? undefined : value })}
					options={[
						{ value: "all", label: "All" },
						{ value: "apps", label: "Apps" },
						{ value: "data", label: "Databases" },
					]}
				/>
				<Segmented<View>
					value={view()}
					onChange={(value) => setParams({ view: value === "list" ? undefined : value })}
					options={[
						{ value: "list", label: <List width={14} height={14} /> },
						{ value: "grid", label: <LayoutGrid width={14} height={14} /> },
					]}
				/>
			</div>

			<Switch>
				<Match when={!store.loaded() && !store.state.servicesError}>
					<div class="card space-y-3 p-4">
						<Skeleton class="h-10" />
						<Skeleton class="h-10" />
						<Skeleton class="h-10" />
					</div>
				</Match>
				<Match when={store.state.services.length === 0}>
					<EmptyState
						icon={<Boxes />}
						title="Deploy your first service"
						description="Build from a Git repository, run any Docker image, or start from a one-click app."
					>
						<LinkButton href="/new" variant="primary">
							<Plus />
							New service
						</LinkButton>
						<LinkButton href="/apps">Browse one-click apps</LinkButton>
					</EmptyState>
				</Match>
				<Match when={filtered().length === 0}>
					<EmptyState
						icon={<Search />}
						title="No matching services"
						description="Try a different filter."
					/>
				</Match>
				<Match when={view() === "grid"}>
					<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						<For each={filtered()}>
							{(service) => (
								<A href={`/services/${service.id}`} class="card card-interactive flex flex-col p-4">
									<div class="flex items-start gap-3">
										<ServiceIcon type={service.service_type} size="lg" />
										<div class="min-w-0 flex-1">
											<div class="truncate text-[14px] font-semibold">{service.name}</div>
											<div class="truncate text-[12.5px] text-fg-subtle">
												{typeLabel(service.service_type)}
												{service.project_name ? ` · ${service.project_name}` : ""}
											</div>
										</div>
										<ServiceActions service={service} />
									</div>
									<div class="mt-4 min-h-[20px] truncate text-[12.5px] text-fg-muted">
										<Show
											when={primaryUrl(service)}
											fallback={
												<Show
													when={publicPorts(service).length > 0}
													fallback={
														<span class="text-fg-faint">
															{service.internal_host ?? "No public URL"}
														</span>
													}
												>
													<span class="text-warning">
														Public TCP · {publicPorts(service).join(", ")}
													</span>
												</Show>
											}
										>
											{(url) => displayHost(url())}
										</Show>
									</div>
									<div class="mt-4 flex items-center justify-between border-t border-border pt-3">
										<StatusBadge status={service.status} />
										<span class="text-[12px] text-fg-faint">{timeAgo(service.updated_at)}</span>
									</div>
								</A>
							)}
						</For>
					</div>
				</Match>
				<Match when={true}>
					<div class="card overflow-x-auto">
						<table class="table min-w-[760px]">
							<thead>
								<tr>
									<th>Name</th>
									<th>Project</th>
									<th>Status</th>
									<th>Instances</th>
									<th>Updated</th>
									<th class="w-10" />
								</tr>
							</thead>
							<tbody>
								<For each={filtered()}>
									{(service) => (
										<tr class="row-link" onClick={() => navigate(`/services/${service.id}`)}>
											<td>
												<div class="flex items-center gap-3">
													<ServiceIcon type={service.service_type} />
													<div class="min-w-0">
														<div class="flex items-center gap-2">
															<A
																href={`/services/${service.id}`}
																class="truncate font-medium hover:underline"
																onClick={(event) => event.stopPropagation()}
															>
																{service.name}
															</A>
															<Show when={isManaged(service)}>
																<Badge>{typeLabel(service.service_type)}</Badge>
															</Show>
														</div>
														<div class="truncate text-[12px] text-fg-subtle">
															<Show
																when={primaryUrl(service)}
																fallback={
																	<Show
																		when={publicPorts(service).length > 0}
																		fallback={typeLabel(service.service_type)}
																	>
																		<span class="text-warning">
																			Public TCP · {publicPorts(service).join(", ")}
																		</span>
																	</Show>
																}
															>
																{(url) => (
																	<a
																		href={url()}
																		target="_blank"
																		rel="noreferrer"
																		class="hover:text-fg hover:underline"
																		onClick={(event) => event.stopPropagation()}
																	>
																		{displayHost(url())}
																	</a>
																)}
															</Show>
														</div>
													</div>
												</div>
											</td>
											<td class={cx(!service.project_name && "text-fg-faint")}>
												{service.project_name ?? "—"}
											</td>
											<td>
												<StatusBadge status={service.status} />
											</td>
											<td class="tabular-nums text-fg-muted">{instancesLabel(service)}</td>
											<td class="whitespace-nowrap text-fg-subtle">
												{timeAgo(service.updated_at)}
											</td>
											<td onClick={(event) => event.stopPropagation()}>
												<ServiceActions service={service} />
											</td>
										</tr>
									)}
								</For>
							</tbody>
						</table>
					</div>
				</Match>
			</Switch>
		</div>
	);
};

export default Services;
