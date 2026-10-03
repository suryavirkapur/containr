import { useNavigate, useSearchParams } from "@solidjs/router";
import { createSignal, For } from "solid-js";
import { createServiceRequest } from "../../api/platform";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import { Button, cx, Field, Input, LinkButton, PageHeader, Select } from "../../components/ui";
import { toast } from "../../components/ui/overlay";
import { useAppStore } from "../../context/AppStore";
import { ServiceIcon } from "../../lib/services";
import { FormSection, nameProblem, ProjectField } from "./shared";

type Engine = {
	id: string;
	label: string;
	type: string;
	description: string;
	versions: string[];
};

const ENGINES: Engine[] = [
	{
		id: "postgresql",
		label: "PostgreSQL",
		type: "postgres",
		description: "The reliable relational database",
		versions: ["17", "16", "15", "14"],
	},
	{
		id: "mariadb",
		label: "MariaDB",
		type: "mariadb",
		description: "MySQL-compatible, great for WordPress and PHP apps",
		versions: ["11", "10.11", "10.6"],
	},
	{
		id: "redis",
		label: "Redis (Valkey)",
		type: "redis",
		description: "In-memory cache, queues and sessions",
		versions: ["8", "7.2"],
	},
	{
		id: "qdrant",
		label: "Qdrant",
		type: "qdrant",
		description: "Vector database for embeddings and AI search",
		versions: ["latest", "v1.13.0", "v1.12.0"],
	},
	{
		id: "rabbitmq",
		label: "RabbitMQ",
		type: "rabbitmq",
		description: "Message broker with the management UI",
		versions: ["4-management", "3-management"],
	},
];

const NewDatabase = () => {
	useBreadcrumbs(() => [{ label: "New service", href: "/new" }, { label: "Database" }]);
	const navigate = useNavigate();
	const store = useAppStore();
	const [params] = useSearchParams();
	const initialEngine = ENGINES.find((engine) => engine.id === params.engine) ?? ENGINES[0];
	const [engine, setEngine] = createSignal<Engine>(initialEngine);
	const [version, setVersion] = createSignal(initialEngine.versions[0]);
	const [name, setName] = createSignal(
		initialEngine.id === "postgresql" ? "postgres" : initialEngine.id,
	);
	const [nameTouched, setNameTouched] = createSignal(false);
	const [project, setProject] = createSignal(
		typeof params.project === "string" ? params.project : "",
	);
	const [memory, setMemory] = createSignal("512");
	const [cpu, setCpu] = createSignal("1");
	const [submitting, setSubmitting] = createSignal(false);

	const pick = (next: Engine) => {
		setEngine(next);
		setVersion(next.versions[0]);
		if (!nameTouched()) setName(next.id === "postgresql" ? "postgres" : next.id);
	};

	const error = () => (nameTouched() ? nameProblem(name()) : null);

	const submit = async (event: Event) => {
		event.preventDefault();
		setNameTouched(true);
		if (nameProblem(name())) return;
		setSubmitting(true);
		try {
			const memoryMb = Number.parseInt(memory(), 10);
			const cpuLimit = Number.parseFloat(cpu());
			const created = await createServiceRequest({
				source: "template",
				name: name().trim(),
				template: engine().id,
				version: version(),
				...(memoryMb > 0 ? { memory_limit_mb: memoryMb } : {}),
				...(cpuLimit > 0 ? { cpu_limit: cpuLimit } : {}),
				...(project() ? { group_id: project() } : {}),
			});
			store.upsertService(created);
			toast.success(`${engine().label} is starting`, "Connection details are on the service page.");
			navigate(`/services/${created.id}`);
		} catch (requestError) {
			toast.error("Could not create the database", requestError);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div class="animate-fade-in mx-auto max-w-5xl">
			<PageHeader
				title="Create a database"
				description="Managed containers with persistent storage, generated credentials and an internal hostname."
			/>
			<form onSubmit={(event) => void submit(event)}>
				<FormSection title="Engine">
					<div class="grid gap-2 sm:grid-cols-2">
						<For each={ENGINES}>
							{(item) => (
								<button
									type="button"
									onClick={() => pick(item)}
									class={cx(
										"flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
										engine().id === item.id
											? "border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]"
											: "border-border hover:border-border-strong hover:bg-surface-hover",
									)}
								>
									<ServiceIcon type={item.type} />
									<span class="min-w-0">
										<span class="block text-[13.5px] font-medium">{item.label}</span>
										<span class="block truncate text-[12px] text-fg-subtle">
											{item.description}
										</span>
									</span>
								</button>
							)}
						</For>
					</div>
				</FormSection>

				<FormSection title="Configuration">
					<div class="grid gap-4 sm:grid-cols-2">
						<Field
							label="Name"
							error={error()}
							hint="Also its hostname inside the project network."
						>
							<Input
								value={name()}
								aria-invalid={Boolean(error())}
								onInput={(event) => {
									setNameTouched(true);
									setName(event.currentTarget.value.toLowerCase());
								}}
							/>
						</Field>
						<Field label="Version">
							<Select value={version()} onChange={(event) => setVersion(event.currentTarget.value)}>
								<For each={engine().versions}>{(item) => <option value={item}>{item}</option>}</For>
							</Select>
						</Field>
					</div>
					<ProjectField
						value={project()}
						onChange={setProject}
						hint="Put the database in the same project as the apps that use it."
					/>
					<div class="grid gap-4 sm:grid-cols-2">
						<Field label="Memory limit (MB)">
							<Input
								type="number"
								min="64"
								value={memory()}
								onInput={(event) => setMemory(event.currentTarget.value)}
							/>
						</Field>
						<Field label="CPU limit (cores)">
							<Input
								type="number"
								min="0.1"
								step="0.1"
								value={cpu()}
								onInput={(event) => setCpu(event.currentTarget.value)}
							/>
						</Field>
					</div>
				</FormSection>

				<div class="sticky bottom-0 -mx-4 mt-2 flex items-center justify-end gap-2 border-t border-border bg-bg/85 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
					<LinkButton href="/new" variant="ghost">
						Cancel
					</LinkButton>
					<Button type="submit" variant="primary" loading={submitting()}>
						Create {engine().label}
					</Button>
				</div>
			</form>
		</div>
	);
};

export default NewDatabase;
