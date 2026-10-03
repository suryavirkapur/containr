import { A, useLocation, useNavigate, useParams } from "@solidjs/router";
import MoreHorizontal from "lucide-solid/icons/ellipsis";
import ExternalLink from "lucide-solid/icons/external-link";
import Play from "lucide-solid/icons/play";
import Rocket from "lucide-solid/icons/rocket";
import RotateCw from "lucide-solid/icons/rotate-cw";
import Square from "lucide-solid/icons/square";
import Trash from "lucide-solid/icons/trash";
import {
	createMemo,
	createResource,
	createSignal,
	For,
	Match,
	onCleanup,
	onMount,
	type ParentComponent,
	Show,
	Switch,
} from "solid-js";
import { errorMessage } from "../../api/http";
import { getService, getServiceSettings, type UpdateServiceBody } from "../../api/services";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Button,
	cx,
	EmptyState,
	LinkButton,
	Notice,
	Skeleton,
	StatusBadge,
} from "../../components/ui";
import { confirm, DropdownMenu, toast } from "../../components/ui/overlay";
import { useAppStore } from "../../context/AppStore";
import { displayHost, isAppService, primaryUrl, ServiceIcon, typeLabel } from "../../lib/services";
import { isInProgress } from "../../lib/status";
import { ServiceContext, type ServiceContextValue, toServiceInput } from "./context";

type TabDef = { path: string; label: string; app?: boolean; managed?: boolean };

const TABS: TabDef[] = [
	{ path: "", label: "Overview" },
	{ path: "/deployments", label: "Deployments", app: true },
	{ path: "/logs", label: "Logs" },
	{ path: "/metrics", label: "Metrics" },
	{ path: "/environment", label: "Environment", app: true },
	{ path: "/networking", label: "Networking", app: true },
	{ path: "/storage", label: "Storage" },
	{ path: "/console", label: "Console" },
	{ path: "/settings", label: "Settings" },
];

const ServiceLayout: ParentComponent = (props) => {
	const params = useParams();
	const location = useLocation();
	const navigate = useNavigate();
	const store = useAppStore();
	const id = () => params.id ?? "";

	const [service, { refetch: refetchService, mutate: mutateService }] = createResource(
		id,
		getService,
	);
	const isApp = () => {
		const current = service();
		return Boolean(current && isAppService(current));
	};
	const [settings, { refetch: refetchSettings }] = createResource(
		() => (isApp() ? id() : null),
		(serviceId) => getServiceSettings(serviceId),
	);
	const [busy, setBusy] = createSignal<string | null>(null);

	useBreadcrumbs(() => {
		const current = service();
		const crumbs = [{ label: "Services", href: "/services" }];
		if (current?.project_name && current.group_id) {
			crumbs.push({ label: current.project_name, href: `/projects/${current.group_id}` });
		}
		crumbs.push({ label: current?.name ?? "…", href: `/services/${id()}` });
		return crumbs;
	});

	// poll faster while something is changing, slower when steady
	onMount(() => {
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			if (document.visibilityState === "visible" && service()) {
				try {
					const next = await getService(id());
					mutateService(next);
					store.upsertService(next);
				} catch {
					// transient errors are fine; the next tick retries
				}
			}
			timer = setTimeout(tick, isInProgress(service()?.status) ? 2500 : 8000);
		};
		timer = setTimeout(tick, 4000);
		onCleanup(() => clearTimeout(timer));
	});

	const refetch = async () => {
		await Promise.all([refetchService(), isApp() ? refetchSettings() : Promise.resolve()]);
		const current = service();
		if (current) store.upsertService(current);
	};

	const save: ServiceContextValue["save"] = async (body, message) => {
		try {
			const updated = await store.updateService(id(), body as UpdateServiceBody);
			mutateService(updated);
			await refetchSettings();
			toast.success(message ?? "Changes saved", "Redeploy to apply changes to running containers.");
			return true;
		} catch (error) {
			toast.error("Could not save changes", error);
			return false;
		}
	};

	const context: ServiceContextValue = {
		id,
		service,
		settings,
		isApp,
		refetch,
		save,
		serviceRequest: (patch) => {
			const current = settings();
			return current ? toServiceInput(current.service, patch) : null;
		},
	};

	const tabs = createMemo(() => TABS.filter((tab) => (tab.app ? isApp() : true)));
	const base = () => `/services/${id()}`;
	const activeTab = () => {
		const rest = location.pathname.slice(base().length);
		return tabs().find((tab) => tab.path && rest.startsWith(tab.path))?.path ?? "";
	};

	const runAction = async (action: "start" | "stop" | "restart") => {
		setBusy(action);
		try {
			const updated = await store.runAction(id(), action);
			mutateService(updated);
			toast.success(
				action === "restart"
					? "Restarting service"
					: action === "stop"
						? "Service stopping"
						: "Service starting",
			);
		} catch (error) {
			toast.error(`Could not ${action} the service`, error);
		} finally {
			setBusy(null);
		}
	};

	const deploy = async () => {
		setBusy("deploy");
		try {
			await store.triggerDeploy(id());
			toast.success("Deployment started", "Follow the build in the Deployments tab.");
			navigate(`${base()}/deployments`);
			void refetch();
		} catch (error) {
			toast.error("Could not start a deployment", error);
		} finally {
			setBusy(null);
		}
	};

	const remove = async () => {
		const current = service();
		if (!current) return;
		const ok = await confirm({
			title: `Delete ${current.name}?`,
			description: "Containers, deployment history and logs are removed permanently.",
			confirmLabel: "Delete service",
			danger: true,
			typeToConfirm: current.name,
		});
		if (!ok) return;
		try {
			await store.removeService(current.id);
			toast.success(`Deleted ${current.name}`);
			navigate("/services");
		} catch (error) {
			toast.error("Delete failed", error);
		}
	};

	return (
		<Switch>
			<Match when={service.error}>
				<EmptyState
					title="Service not found"
					description={errorMessage(service.error, "It may have been deleted.")}
				>
					<LinkButton href="/services">Back to services</LinkButton>
				</EmptyState>
			</Match>
			<Match when={true}>
				<ServiceContext.Provider value={context}>
					<div class="animate-fade-in">
						<div class="mb-5 flex flex-wrap items-start gap-4">
							<Show when={service()} fallback={<Skeleton class="h-10 w-10" />}>
								{(current) => <ServiceIcon type={current().service_type} size="lg" />}
							</Show>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2.5">
									<h1 class="truncate text-[22px] font-semibold tracking-[-0.02em]">
										{service()?.name ?? <Skeleton class="h-7 w-48" />}
									</h1>
									<Show when={service()}>
										{(current) => <StatusBadge status={current().status} />}
									</Show>
								</div>
								<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-subtle">
									<Show when={service()}>
										{(current) => (
											<>
												<span>{typeLabel(current().service_type)}</span>
												<Show when={current().project_name && current().group_id}>
													<A href={`/projects/${current().group_id}`} class="hover:text-fg">
														{current().project_name}
													</A>
												</Show>
												<Show when={primaryUrl(current())}>
													{(url) => (
														<a
															href={url()}
															target="_blank"
															rel="noreferrer"
															class="inline-flex items-center gap-1 text-fg-muted hover:text-fg"
														>
															{displayHost(url())}
															<ExternalLink width={12} height={12} />
														</a>
													)}
												</Show>
											</>
										)}
									</Show>
								</div>
							</div>
							<Show when={service()}>
								{(current) => (
									<div class="flex w-full items-center gap-2 sm:w-auto">
										<Show when={isApp()}>
											<Button
												variant="primary"
												onClick={() => void deploy()}
												loading={busy() === "deploy"}
											>
												<Rocket />
												Deploy
											</Button>
										</Show>
										<Button
											variant="secondary"
											onClick={() => void runAction("restart")}
											loading={busy() === "restart"}
										>
											<RotateCw />
											Restart
										</Button>
										<DropdownMenu
											trigger={(trigger) => (
												<Button variant="secondary" icon aria-label="More actions" {...trigger}>
													<MoreHorizontal />
												</Button>
											)}
											items={[
												current().status === "stopped"
													? {
															label: "Start",
															icon: <Play />,
															onSelect: () => void runAction("start"),
														}
													: {
															label: "Stop",
															icon: <Square />,
															onSelect: () => void runAction("stop"),
														},
												{ separator: true },
												{
													label: "Delete service",
													icon: <Trash />,
													danger: true,
													onSelect: () => void remove(),
												},
											]}
										/>
									</div>
								)}
							</Show>
						</div>

						<nav class="tabs mb-6">
							<For each={tabs()}>
								{(tab) => (
									<A
										href={`${base()}${tab.path}`}
										class={cx("tab", activeTab() === tab.path && "active")}
										end
									>
										{tab.label}
									</A>
								)}
							</For>
						</nav>

						<Show when={service()} fallback={<Skeleton class="h-64 w-full" />}>
							<Show when={settings.error}>
								<Notice tone="warning" class="mb-4">
									Settings could not be loaded: {errorMessage(settings.error)}
								</Notice>
							</Show>
							{props.children}
						</Show>
					</div>
				</ServiceContext.Provider>
			</Match>
		</Switch>
	);
};

export default ServiceLayout;
