import { useNavigate, useParams } from "@solidjs/router";
import ExternalLink from "lucide-solid/icons/external-link";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Rocket from "lucide-solid/icons/rocket";
import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { createServiceRequest } from "../../api/platform";
import { getSettings } from "../../api/settings";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Badge,
	Button,
	Card,
	EmptyState,
	Field,
	Input,
	LinkButton,
	Notice,
	PasswordInput,
} from "../../components/ui";
import { toast } from "../../components/ui/overlay";
import { useAppStore } from "../../context/AppStore";
import {
	findTemplate,
	generateValue,
	initialValues,
	type TemplateContext,
} from "../../lib/catalog";
import { ServiceIcon, typeLabel } from "../../lib/services";
import { nameProblem, ProjectField } from "../new/shared";
import { AppLogo } from "./AppLogo";

const AppDeploy = () => {
	const params = useParams();
	const navigate = useNavigate();
	const store = useAppStore();
	const template = () => findTemplate(params.id ?? "");
	useBreadcrumbs(() => [
		{ label: "One-Click Apps", href: "/apps" },
		{ label: template()?.name ?? "App" },
	]);

	const [platform] = createResource(() => getSettings().catch(() => null));
	const [name, setName] = createSignal(template()?.id ?? "app");
	const [domain, setDomain] = createSignal("");
	const [domainTouched, setDomainTouched] = createSignal(false);
	const [project, setProject] = createSignal("");
	const [values, setValues] = createStore<Record<string, string>>({});
	const [submitting, setSubmitting] = createSignal(false);

	const baseDomain = () => {
		const value = platform()?.base_domain ?? "";
		return value && value !== "localhost" ? value : "";
	};

	createEffect(
		on(template, (current) => {
			if (!current) return;
			setName(current.id);
			setValues(initialValues(current, { app: current.id, domain: "", url: "" }));
		}),
	);

	// suggest <app>.<root domain> until the user edits the domain
	createEffect(() => {
		if (!domainTouched() && template()?.web)
			setDomain(baseDomain() ? `${name()}.${baseDomain()}` : "");
	});

	const context = (): TemplateContext => ({
		app: name().trim(),
		domain: domain().trim(),
		url: domain().trim() ? `https://${domain().trim()}` : "",
		vars: { ...values },
	});

	const preview = createMemo(() => {
		const current = template();
		if (!current) return [];
		try {
			return current.services(context());
		} catch {
			return [];
		}
	});

	const error = () => nameProblem(name());
	const missing = () =>
		(template()?.variables ?? []).filter(
			(variable) => variable.required && !values[variable.id]?.trim(),
		);

	const deploy = async (event: Event) => {
		event.preventDefault();
		const current = template();
		if (!current || error()) return;
		if (missing().length) {
			toast.error(`Fill in ${missing()[0].label.toLowerCase()}`);
			return;
		}
		if (current.needsDomain && !domain().trim()) {
			toast.error(`${current.name} needs a domain to work`);
			return;
		}
		setSubmitting(true);
		try {
			const ctx = context();
			const created = await createServiceRequest({
				source: "stack",
				name: ctx.app,
				services: current.services(ctx),
				...(project() ? { group_id: project() } : {}),
			});
			store.upsertService(created);
			void store.loadServices(true);
			toast.success(`${current.name} is deploying`, current.instructions?.(ctx));
			navigate(`/services/${created.id}`);
		} catch (requestError) {
			toast.error(`Could not deploy ${current.name}`, requestError);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Show
			when={template()}
			fallback={
				<EmptyState title="App not found" description="It may have been removed from the catalog.">
					<LinkButton href="/apps">Back to apps</LinkButton>
				</EmptyState>
			}
		>
			{(current) => (
				<div class="animate-fade-in">
					<div class="mb-8 flex flex-wrap items-start gap-4">
						<AppLogo template={current()} size={56} />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<h1 class="text-[22px] font-semibold tracking-[-0.02em]">{current().name}</h1>
								<Badge>{current().category}</Badge>
							</div>
							<p class="mt-1 max-w-2xl text-[13.5px] text-fg-subtle">{current().description}</p>
							<a
								href={current().website}
								target="_blank"
								rel="noreferrer"
								class="mt-2 inline-flex items-center gap-1 text-[12.5px] text-fg-muted hover:text-fg"
							>
								{current()
									.website.replace(/^https?:\/\//, "")
									.replace(/\/$/, "")}
								<ExternalLink width={12} height={12} />
							</a>
						</div>
					</div>

					<form
						class="grid gap-6 lg:grid-cols-[1fr_340px]"
						onSubmit={(event) => void deploy(event)}
					>
						<div class="space-y-6">
							<Card title="App">
								<div class="grid gap-4 sm:grid-cols-2">
									<Field
										label="App name"
										error={error()}
										hint="Used for the project, service and volume names."
									>
										<Input
											value={name()}
											onInput={(event) => setName(event.currentTarget.value.toLowerCase())}
										/>
									</Field>
									<Field label="Version" hint="Docker image tag.">
										<Input
											mono
											value={values.version ?? ""}
											onInput={(event) => setValues("version", event.currentTarget.value)}
										/>
									</Field>
								</div>
								<Show when={current().web}>
									<Field
										class="mt-4"
										label="Domain"
										optional={!current().needsDomain}
										hint={
											current().needsDomain && !domain()
												? `${current().name} only works behind its own domain.`
												: baseDomain()
													? "Point DNS at this server; HTTPS is issued automatically."
													: "Set a root domain in Settings to get one automatically."
										}
									>
										<Input
											placeholder="app.example.com"
											value={domain()}
											onInput={(event) => {
												setDomainTouched(true);
												setDomain(event.currentTarget.value.trim().toLowerCase());
											}}
										/>
									</Field>
								</Show>
								<div class="mt-4">
									<ProjectField
										value={project()}
										onChange={setProject}
										hint="Deploy into an existing project to let your other services reach it by name."
									/>
								</div>
							</Card>

							<Show when={(current().variables ?? []).length > 0}>
								<Card
									title="Configuration"
									description="Secrets are generated for you. Copy them now or find them later in each service's environment."
								>
									<div class="grid gap-4 sm:grid-cols-2">
										<For each={current().variables}>
											{(variable) => (
												<Field label={variable.label} hint={variable.description}>
													<Show
														when={variable.secret}
														fallback={
															<Input
																placeholder={variable.placeholder}
																value={values[variable.id] ?? ""}
																onInput={(event) =>
																	setValues(variable.id, event.currentTarget.value)
																}
															/>
														}
													>
														<div class="flex gap-1.5">
															<div class="min-w-0 flex-1">
																<PasswordInput
																	value={values[variable.id] ?? ""}
																	onInput={(event) =>
																		setValues(variable.id, event.currentTarget.value)
																	}
																/>
															</div>
															<Button
																variant="secondary"
																icon
																title="Generate a new value"
																onClick={() => setValues(variable.id, generateValue(variable))}
															>
																<RefreshCw />
															</Button>
														</div>
													</Show>
												</Field>
											)}
										</For>
									</div>
								</Card>
							</Show>
						</div>

						<div class="space-y-4">
							<Card title="What gets deployed" flush>
								<ul class="divide-y divide-border">
									<For each={preview()}>
										{(service) => (
											<li class="flex items-start gap-3 px-4 py-3">
												<ServiceIcon type={service.service_type} size="sm" />
												<div class="min-w-0">
													<div class="truncate text-[13px] font-medium">{service.name}</div>
													<div class="truncate font-mono text-[11.5px] text-fg-subtle">
														{service.image}
													</div>
													<div class="mt-0.5 text-[11.5px] text-fg-faint">
														{typeLabel(service.service_type)}
														<Show when={service.mounts?.length}>
															{" "}
															· {service.mounts?.length} volume(s)
														</Show>
													</div>
												</div>
											</li>
										)}
									</For>
								</ul>
							</Card>
							<Show when={current().instructions}>
								<Notice title="After deploying">{current().instructions?.(context())}</Notice>
							</Show>
							<Button
								type="submit"
								variant="primary"
								size="lg"
								class="w-full"
								loading={submitting()}
							>
								<Rocket />
								Deploy {current().name}
							</Button>
						</div>
					</form>
				</div>
			)}
		</Show>
	);
};

export default AppDeploy;
