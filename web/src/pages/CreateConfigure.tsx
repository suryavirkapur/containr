import { useNavigate, useSearchParams } from "@solidjs/router";
import { type Component, createEffect, createSignal, Show } from "solid-js";
import { api, components } from "../api";
import EnvVarEditor from "../components/EnvVarEditor";
import ServiceForm, {
	applyServiceType,
	createServiceForType,
	type Service,
	type ServiceType,
	serviceTypeLabel,
} from "../components/ServiceForm";
import {
	Alert,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Input,
	PageHeader,
} from "../components/ui";
import { type EditableEnvVar, mapServiceToRequest } from "../utils/projectEditor";

const inferServiceName = (sourceUrl: string): string => {
	const trimmed = sourceUrl.trim();
	if (!trimmed) return "";
	const cleaned = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
	const segments = cleaned.split(/[/:]/).filter(Boolean);
	return segments[segments.length - 1] || "";
};

const searchParamValue = (value: string | string[] | undefined): string | undefined =>
	Array.isArray(value) ? value[0] : value;

const CreateConfigure: Component = () => {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();

	const [selectedType, setSelectedType] = createSignal<ServiceType>("web_service");
	const [githubUrl, setGithubUrl] = createSignal("");
	const [branch, setBranch] = createSignal("main");
	const [service, setService] = createSignal<Service>(createServiceForType("web_service"));
	const [envVars, setEnvVars] = createSignal<EditableEnvVar[]>([]);
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);

	createEffect(() => {
		const repoUrl = searchParamValue(searchParams.repo);
		const requestedServiceType = searchParamValue(searchParams.type);
		const defaultBranch = searchParamValue(searchParams.branch);

		if (repoUrl) setGithubUrl(repoUrl);
		if (defaultBranch) setBranch(defaultBranch);

		if (
			requestedServiceType === "web_service" ||
			requestedServiceType === "private_service" ||
			requestedServiceType === "background_worker" ||
			requestedServiceType === "cron_job"
		) {
			const type = requestedServiceType as ServiceType;
			setSelectedType(type);
			let nextService = applyServiceType(service(), type);

			if (repoUrl && !nextService.name.trim()) {
				const inferred = inferServiceName(repoUrl);
				if (inferred) nextService = { ...nextService, name: inferred };
			}
			setService(nextService);
		}
	});

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		setError("");
		setLoading(true);

		try {
			const currentService = service();
			if (!currentService.name.trim()) {
				throw new Error("service name is required");
			}

			const { data, error: apiError } = await api.POST("/api/services", {
				body: {
					source: "git_repository",
					name: currentService.name.trim(),
					github_url: githubUrl().trim(),
					branch: branch().trim() || "main",
					env_vars: envVars().length > 0 ? envVars() : null,
					service: mapServiceToRequest(currentService),
				},
			});

			if (apiError) throw apiError;
			navigate(`/services/${data.id}`);
		} catch (err) {
			if (err instanceof Error) {
				setError(err.message);
			} else if (
				typeof err === "object" &&
				err !== null &&
				"error" in err &&
				typeof err.error === "string"
			) {
				setError(err.error);
			} else {
				setError("failed to create service");
			}
		} finally {
			setLoading(false);
		}
	};

	return (
		<div class="mx-auto max-w-3xl space-y-8">
			<PageHeader
				eyebrow="configure"
				title={`new ${serviceTypeLabel(selectedType())}`}
				description={`deploying from ${githubUrl() || "your repository"}`}
			/>

			<Show when={error()}>
				<Alert variant="destructive" title="create failed">
					{error()}
				</Alert>
			</Show>

			<form class="space-y-8" onSubmit={handleSubmit}>
				<Card>
					<CardHeader>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							service identity
						</p>
						<CardTitle class="mt-2">basic settings</CardTitle>
					</CardHeader>
					<CardContent class="grid gap-4 md:grid-cols-2">
						<Input
							label="service name"
							value={service().name}
							onInput={(event) =>
								setService({
									...service(),
									name: event.currentTarget.value,
								})
							}
							placeholder="my-api"
							required
						/>
						<Input
							label="branch"
							value={branch()}
							onInput={(event) => setBranch(event.currentTarget.value)}
							placeholder="main"
						/>
					</CardContent>
				</Card>

				<EnvVarEditor
					envVars={envVars()}
					onChange={setEnvVars}
					title="environment variables"
					description="configure shared environment variables securely."
					emptyText="no environment variables configured"
					addLabel="add variable"
				/>

				<div class="space-y-4">
					<div class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							service definition
						</p>
						<h2 class="font-serif text-2xl text-[var(--foreground)]">
							configure build, runtime, and storage
						</h2>
					</div>
					<ServiceForm
						service={service()}
						index={0}
						allServices={[service()]}
						showServiceTypePicker={false}
						onUpdate={(_, next) => {
							setSelectedType(next.service_type);
							setService(next);
						}}
						onRemove={() => {}}
						allowRemove={false}
					/>
				</div>

				<div class="flex justify-end border-t border-[var(--border)] pt-8">
					<Button type="submit" isLoading={loading()} class="min-w-32">
						create service
					</Button>
				</div>
			</form>
		</div>
	);
};

export default CreateConfigure;
