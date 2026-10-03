import { useNavigate } from "@solidjs/router";
import FileCode from "lucide-solid/icons/file-code";
import Upload from "lucide-solid/icons/upload";
import { createSignal, Match, Show, Switch } from "solid-js";
import { createServiceRequest, deployDockerfile, deployTarball } from "../../api/platform";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Button,
	cx,
	Field,
	Input,
	LinkButton,
	PageHeader,
	Segmented,
	Textarea,
} from "../../components/ui";
import { toast } from "../../components/ui/overlay";
import { useAppStore } from "../../context/AppStore";
import {
	FormSection,
	nameProblem,
	PortField,
	ProjectField,
	type ServiceType,
	ServiceTypePicker,
} from "./shared";

type Mode = "upload" | "dockerfile";

const NewUpload = () => {
	useBreadcrumbs(() => [{ label: "New service", href: "/new" }, { label: "Upload or Dockerfile" }]);
	const navigate = useNavigate();
	const store = useAppStore();
	const [mode, setMode] = createSignal<Mode>("upload");
	const [file, setFile] = createSignal<File | null>(null);
	const [dragging, setDragging] = createSignal(false);
	const [dockerfile, setDockerfile] = createSignal(
		"FROM nginx:alpine\nRUN echo '<h1>Hello from containr</h1>' > /usr/share/nginx/html/index.html\nEXPOSE 80\n",
	);
	const [name, setName] = createSignal("");
	const [project, setProject] = createSignal("");
	const [type, setType] = createSignal<ServiceType>("web_service");
	const [port, setPort] = createSignal("80");
	const [touched, setTouched] = createSignal(false);
	const [submitting, setSubmitting] = createSignal(false);

	const error = () => (touched() ? nameProblem(name()) : null);

	const submit = async (event: Event) => {
		event.preventDefault();
		setTouched(true);
		if (nameProblem(name())) return;
		if (mode() === "upload" && !file()) {
			toast.error("Choose a .tar or .tar.gz to upload");
			return;
		}
		const portNumber = Number.parseInt(port(), 10);
		setSubmitting(true);
		try {
			const created = await createServiceRequest({
				source: "git_repository",
				name: name().trim(),
				github_url: "",
				deploy: false,
				service: {
					name: name().trim(),
					service_type: type(),
					port: portNumber > 0 && portNumber < 65536 ? portNumber : 80,
					expose_http: type() === "web_service",
				},
				...(project() ? { group_id: project() } : {}),
			});
			store.upsertService(created);
			const selected = file();
			if (mode() === "upload" && selected) await deployTarball(created.id, selected);
			else await deployDockerfile(created.id, dockerfile());
			toast.success(`Building ${created.name}`);
			navigate(`/services/${created.id}/deployments`);
		} catch (requestError) {
			toast.error("Could not deploy", requestError);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div class="animate-fade-in mx-auto max-w-5xl">
			<PageHeader
				title="Deploy an upload or Dockerfile"
				description="Ship code without a Git repository. Redeploy later from the service's Deployments tab or the CLI."
			/>
			<form onSubmit={(event) => void submit(event)}>
				<FormSection title="Source">
					<Segmented<Mode>
						value={mode()}
						onChange={setMode}
						options={[
							{
								value: "upload",
								label: (
									<span class="flex items-center gap-1.5">
										<Upload width={13} height={13} />
										Upload tarball
									</span>
								),
							},
							{
								value: "dockerfile",
								label: (
									<span class="flex items-center gap-1.5">
										<FileCode width={13} height={13} />
										Paste Dockerfile
									</span>
								),
							},
						]}
					/>
					<Switch>
						<Match when={mode() === "upload"}>
							<label
								class={cx(
									"flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center transition-colors",
									dragging()
										? "border-accent bg-accent-soft"
										: "border-border-strong hover:bg-surface-hover",
								)}
								onDragOver={(event) => {
									event.preventDefault();
									setDragging(true);
								}}
								onDragLeave={() => setDragging(false)}
								onDrop={(event) => {
									event.preventDefault();
									setDragging(false);
									const dropped = event.dataTransfer?.files?.[0];
									if (dropped) setFile(dropped);
								}}
							>
								<Upload width={22} height={22} class="text-fg-subtle" />
								<span class="mt-3 text-[14px] font-medium">
									{file()?.name ?? "Drop your project archive here"}
								</span>
								<span class="mt-1 text-[12.5px] text-fg-subtle">
									A .tar or .tar.gz with a Dockerfile at its root, up to 512 MB
								</span>
								<input
									type="file"
									class="hidden"
									accept=".tar,.tgz,.gz"
									onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
								/>
							</label>
							<p class="hint">
								Create one with{" "}
								<code>tar -czf app.tar.gz --exclude=node_modules --exclude=.git .</code>
							</p>
						</Match>
						<Match when={mode() === "dockerfile"}>
							<Field label="Dockerfile">
								<Textarea
									mono
									rows={10}
									spellcheck={false}
									value={dockerfile()}
									onInput={(event) => setDockerfile(event.currentTarget.value)}
								/>
							</Field>
						</Match>
					</Switch>
				</FormSection>

				<FormSection title="Service">
					<div class="grid gap-4 sm:grid-cols-2">
						<Field label="Name" error={error()}>
							<Input
								value={name()}
								placeholder="my-app"
								aria-invalid={Boolean(error())}
								onInput={(event) => setName(event.currentTarget.value.toLowerCase())}
							/>
						</Field>
						<ProjectField value={project()} onChange={setProject} />
					</div>
					<ServiceTypePicker value={type()} onChange={setType} />
					<Show when={type() === "web_service" || type() === "private_service"}>
						<div class="grid gap-4 sm:grid-cols-2">
							<PortField value={port()} onChange={setPort} />
						</div>
					</Show>
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

export default NewUpload;
