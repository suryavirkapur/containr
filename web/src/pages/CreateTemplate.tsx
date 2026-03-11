import { useNavigate, useSearchParams } from "@solidjs/router";
import { type Component, createEffect, createResource, createSignal, For, Show } from "solid-js";
import { api, type components } from "../api";
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

type Project = components["schemas"]["AppResponse"];
type TemplateType = "postgresql" | "redis" | "mariadb" | "qdrant" | "rabbitmq";

const templateLabel = (templateType: TemplateType): string => {
	switch (templateType) {
		case "postgresql":
			return "containr postgres";
		case "redis":
			return "containr valkey";
		case "mariadb":
			return "containr mariadb";
		case "qdrant":
			return "containr qdrant";
		case "rabbitmq":
			return "containr rabbitmq";
		default:
			return "template service";
	}
};

const fetchProjects = async (): Promise<Project[]> => {
	try {
		const { data, error } = await api.GET("/api/projects");
		if (error) throw error;
		return data ?? [];
	} catch {
		return [];
	}
};

const searchParamValue = (value: string | string[] | undefined): string | undefined =>
	Array.isArray(value) ? value[0] : value;

const selectClass =
	"flex h-11 w-full rounded-[var(--radius)] border px-3 py-2 text-sm " +
	"font-medium bg-[var(--input)] text-[var(--foreground)] " +
	"border-[var(--border)] focus:border-[var(--ring)] focus:outline-none " +
	"focus:ring-1 focus:ring-[var(--ring)]";

const CreateTemplate: Component = () => {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();

	const [templateType, setTemplateType] = createSignal<TemplateType>("postgresql");
	const [selectedGroupId, setSelectedGroupId] = createSignal("");
	const [managedName, setManagedName] = createSignal("");
	const [managedVersion, setManagedVersion] = createSignal("");
	const [managedMemoryMb, setManagedMemoryMb] = createSignal("512");
	const [managedCpuLimit, setManagedCpuLimit] = createSignal("1.0");
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);

	const [projects] = createResource(fetchProjects);

	createEffect(() => {
		const requestedTemplate = searchParamValue(searchParams.type);
		const requestedGroupId = searchParamValue(searchParams.group_id);

		if (
			requestedTemplate === "postgresql" ||
			requestedTemplate === "redis" ||
			requestedTemplate === "mariadb" ||
			requestedTemplate === "qdrant" ||
			requestedTemplate === "rabbitmq"
		) {
			setTemplateType(requestedTemplate);
		}

		if (requestedGroupId) {
			setSelectedGroupId(requestedGroupId);
		}
	});

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		setError("");
		setLoading(true);

		try {
			if (!managedName().trim()) {
				throw new Error("service name is required");
			}

			const { data, error: apiError } = await api.POST("/api/services", {
				body: {
					source: "template",
					name: managedName().trim(),
					template: templateType(),
					version: managedVersion().trim() || null,
					memory_limit_mb: parseInt(managedMemoryMb(), 10) || 512,
					cpu_limit: parseFloat(managedCpuLimit()) || 1.0,
					group_id: selectedGroupId().trim() || null,
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
				title={`new ${templateLabel(templateType())}`}
				description="launch a managed template directly into a service network."
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
							placement
						</p>
						<CardTitle class="mt-2">attach the service to a service network</CardTitle>
					</CardHeader>
					<CardContent class="space-y-4">
						<div class="space-y-2">
							<label
								for="managed-group"
								class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]"
							>
								service network
							</label>
							<select
								id="managed-group"
								value={selectedGroupId()}
								onChange={(event) => setSelectedGroupId(event.currentTarget.value)}
								class={selectClass}
							>
								<option value="">standalone service</option>
								<For each={projects() || []}>
									{(project) => <option value={project.id}>{project.name}</option>}
								</For>
							</select>
						</div>
						<p class="text-sm text-[var(--muted-foreground)]">
							if you leave this empty, the service gets its own private docker network. attaching it
							to a service network joins the existing shared boundary.
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							settings
						</p>
						<CardTitle class="mt-2">configure the template service</CardTitle>
					</CardHeader>
					<CardContent class="grid gap-4 md:grid-cols-2">
						<Input
							label="service name"
							value={managedName()}
							onInput={(event) => setManagedName(event.currentTarget.value)}
							placeholder="primary-db"
							required
						/>
						<Input
							label="version"
							value={managedVersion()}
							onInput={(event) => setManagedVersion(event.currentTarget.value)}
							placeholder="leave empty for default"
						/>
						<Input
							label="memory limit (mb)"
							type="number"
							value={managedMemoryMb()}
							onInput={(event) => setManagedMemoryMb(event.currentTarget.value)}
						/>
						<Input
							label="cpu limit"
							type="number"
							step="0.1"
							value={managedCpuLimit()}
							onInput={(event) => setManagedCpuLimit(event.currentTarget.value)}
						/>
					</CardContent>
				</Card>

				<div class="flex justify-end border-t border-[var(--border)] pt-8">
					<Button type="submit" isLoading={loading()} class="min-w-32">
						create service
					</Button>
				</div>
			</form>
		</div>
	);
};

export default CreateTemplate;
