import { useNavigate, useSearchParams } from "@solidjs/router";
import Plus from "lucide-solid/icons/plus";
import Trash from "lucide-solid/icons/trash";
import { createSignal, Index, Show } from "solid-js";
import { createServiceRequest, type MountInput, type ServiceInput } from "../../api/platform";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import { Button, Field, Input, LinkButton, PageHeader } from "../../components/ui";
import { EnvEditor, type EnvRow } from "../../components/ui/editors";
import { toast } from "../../components/ui/overlay";
import { useAppStore } from "../../context/AppStore";
import { slugify } from "../../lib/format";
import {
	FormSection,
	nameProblem,
	PortField,
	ProjectField,
	type ServiceType,
	ServiceTypePicker,
} from "./shared";

const NewImage = () => {
	useBreadcrumbs(() => [{ label: "New service", href: "/new" }, { label: "Docker image" }]);
	const navigate = useNavigate();
	const store = useAppStore();
	const [params] = useSearchParams();
	const [image, setImage] = createSignal("");
	const [name, setName] = createSignal("");
	const [project, setProject] = createSignal(
		typeof params.project === "string" ? params.project : "",
	);
	const [type, setType] = createSignal<ServiceType>("web_service");
	const [port, setPort] = createSignal("80");
	const [schedule, setSchedule] = createSignal("");
	const [env, setEnv] = createSignal<EnvRow[]>([]);
	const [volumes, setVolumes] = createSignal<MountInput[]>([]);
	const [submitting, setSubmitting] = createSignal(false);
	const [touched, setTouched] = createSignal(false);

	const onImage = (value: string) => {
		setImage(value);
		if (!touched()) {
			const base = value.split("/").pop()?.split(":")[0]?.split("@")[0] ?? "";
			setName(slugify(base));
		}
	};

	const error = () => (touched() ? nameProblem(name()) : null);

	const submit = async (event: Event) => {
		event.preventDefault();
		setTouched(true);
		if (!image().trim()) {
			toast.error("Enter an image to deploy");
			return;
		}
		if (nameProblem(name())) return;
		const portNumber = Number.parseInt(port(), 10);
		const service: ServiceInput = {
			name: name().trim(),
			image: image().trim(),
			service_type: type(),
			port: portNumber > 0 && portNumber < 65536 ? portNumber : 80,
			expose_http: type() === "web_service",
			schedule: type() === "cron_job" ? schedule().trim() : null,
			env_vars: env()
				.filter((row) => row.key.trim())
				.map((row) => ({ key: row.key.trim(), value: row.value, secret: row.secret })),
			mounts: volumes()
				.filter((mount) => mount.target.trim())
				.map((mount) => ({
					name: mount.name.trim() || slugify(mount.target),
					target: mount.target.trim(),
				})),
		};
		setSubmitting(true);
		try {
			const created = await createServiceRequest({
				source: "git_repository",
				name: name().trim(),
				github_url: "",
				service,
				...(project() ? { group_id: project() } : {}),
			});
			store.upsertService(created);
			toast.success(`Deploying ${created.name}`);
			navigate(`/services/${created.id}`);
		} catch (requestError) {
			toast.error("Could not create the service", requestError);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div class="animate-fade-in mx-auto max-w-5xl">
			<PageHeader
				title="Deploy a Docker image"
				description="Run a prebuilt image. containr pulls it on every deploy."
			/>
			<form onSubmit={(event) => void submit(event)}>
				<FormSection
					title="Image"
					description="Public images work out of the box. For private ones, add the registry under Settings → Registries."
				>
					<Field
						label="Image reference"
						hint="Docker Hub images can be short, like redis:7 or louislam/uptime-kuma:1."
					>
						<Input
							mono
							autofocus
							placeholder="ghcr.io/org/app:latest"
							value={image()}
							onInput={(event) => onImage(event.currentTarget.value)}
						/>
					</Field>
				</FormSection>

				<FormSection title="Service">
					<div class="grid gap-4 sm:grid-cols-2">
						<Field label="Name" error={error()}>
							<Input
								value={name()}
								aria-invalid={Boolean(error())}
								onInput={(event) => {
									setTouched(true);
									setName(event.currentTarget.value.toLowerCase());
								}}
							/>
						</Field>
						<ProjectField value={project()} onChange={setProject} />
					</div>
					<ServiceTypePicker value={type()} onChange={setType} />
					<div class="grid gap-4 sm:grid-cols-2">
						<Show when={type() === "web_service" || type() === "private_service"}>
							<PortField value={port()} onChange={setPort} />
						</Show>
						<Show when={type() === "cron_job"}>
							<Field label="Schedule" hint="Cron syntax in UTC.">
								<Input
									mono
									placeholder="0 * * * *"
									value={schedule()}
									onInput={(event) => setSchedule(event.currentTarget.value)}
								/>
							</Field>
						</Show>
					</div>
				</FormSection>

				<FormSection
					title="Persistent data"
					description="Paths that keep their data across restarts and redeploys."
				>
					<div class="space-y-2">
						<Index each={volumes()}>
							{(volume, index) => (
								<div class="grid grid-cols-[1fr_1.5fr_32px] items-center gap-2">
									<Input
										mono
										placeholder="volume name"
										value={volume().name}
										onInput={(event) =>
											setVolumes(
												volumes().map((item, i) =>
													i === index ? { ...item, name: event.currentTarget.value } : item,
												),
											)
										}
									/>
									<Input
										mono
										placeholder="/data"
										value={volume().target}
										onInput={(event) =>
											setVolumes(
												volumes().map((item, i) =>
													i === index ? { ...item, target: event.currentTarget.value } : item,
												),
											)
										}
									/>
									<button
										type="button"
										class="btn btn-ghost btn-icon hover:text-danger!"
										aria-label="Remove volume"
										onClick={() => setVolumes(volumes().filter((_, i) => i !== index))}
									>
										<Trash />
									</button>
								</div>
							)}
						</Index>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setVolumes([...volumes(), { name: "", target: "" }])}
						>
							<Plus />
							Add volume
						</Button>
					</div>
				</FormSection>

				<FormSection title="Environment">
					<EnvEditor rows={env()} onChange={setEnv} />
				</FormSection>

				<div class="sticky bottom-0 -mx-4 mt-2 flex items-center justify-end gap-2 border-t border-border bg-bg/85 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
					<LinkButton href="/new" variant="ghost">
						Cancel
					</LinkButton>
					<Button type="submit" variant="primary" loading={submitting()}>
						Create and deploy
					</Button>
				</div>
			</form>
		</div>
	);
};

export default NewImage;
