import Container from "lucide-solid/icons/container";
import Plus from "lucide-solid/icons/plus";
import Trash from "lucide-solid/icons/trash";
import { createResource, createSignal, For, Match, Switch } from "solid-js";
import { errorMessage } from "../../api/http";
import { createRegistry, deleteRegistry, listRegistries } from "../../api/platform";
import {
	Button,
	Card,
	EmptyState,
	Field,
	Input,
	Notice,
	PasswordInput,
	Skeleton,
} from "../../components/ui";
import { confirm, Modal, toast } from "../../components/ui/overlay";
import { timeAgo } from "../../lib/format";

const RegistriesSettings = () => {
	const [registries, { refetch }] = createResource(listRegistries);
	const [open, setOpen] = createSignal(false);
	const [server, setServer] = createSignal("");
	const [username, setUsername] = createSignal("");
	const [password, setPassword] = createSignal("");
	const [saving, setSaving] = createSignal(false);

	const add = async () => {
		setSaving(true);
		try {
			await createRegistry(server().trim() || "docker.io", username().trim(), password());
			toast.success("Registry added", "Images from it now pull with these credentials.");
			setOpen(false);
			setServer("");
			setUsername("");
			setPassword("");
			void refetch();
		} catch (error) {
			toast.error("Could not add the registry", error);
		} finally {
			setSaving(false);
		}
	};

	const remove = async (id: string, host: string) => {
		const ok = await confirm({
			title: `Remove ${host}?`,
			description:
				"Services that pull private images from it will fail to deploy until you add it again.",
			confirmLabel: "Remove",
			danger: true,
		});
		if (!ok) return;
		try {
			await deleteRegistry(id);
			void refetch();
		} catch (error) {
			toast.error("Could not remove the registry", error);
		}
	};

	return (
		<>
			<Card
				title="Container registries"
				description="Credentials for pulling private images. containr picks the right one from each image's hostname."
				flush
				actions={
					<Button variant="primary" size="sm" onClick={() => setOpen(true)}>
						<Plus />
						Add registry
					</Button>
				}
			>
				<Switch>
					<Match when={registries.loading && !registries()}>
						<div class="p-4">
							<Skeleton class="h-12" />
						</div>
					</Match>
					<Match when={registries.error}>
						<div class="p-4">
							<Notice tone="danger">{errorMessage(registries.error)}</Notice>
						</div>
					</Match>
					<Match when={!registries()?.length}>
						<div class="p-4">
							<EmptyState
								icon={<Container />}
								title="No registries"
								description="Public images work without one. Add Docker Hub, GHCR, GitLab or a self-hosted registry for private images."
							/>
						</div>
					</Match>
					<Match when={true}>
						<ul class="divide-y divide-border">
							<For each={registries()}>
								{(registry) => (
									<li class="flex items-center gap-3 px-4 py-3">
										<span class="flex h-8 w-8 items-center justify-center rounded-md bg-surface-2 text-fg-subtle">
											<Container width={15} height={15} />
										</span>
										<div class="min-w-0 flex-1">
											<div class="truncate font-mono text-[13px]">{registry.server}</div>
											<div class="text-[12px] text-fg-subtle">
												{registry.username} · added {timeAgo(registry.created_at)}
											</div>
										</div>
										<button
											type="button"
											class="btn btn-ghost btn-icon btn-sm hover:text-danger!"
											aria-label={`Remove ${registry.server}`}
											onClick={() => void remove(registry.id, registry.server)}
										>
											<Trash />
										</button>
									</li>
								)}
							</For>
						</ul>
					</Match>
				</Switch>
			</Card>
			<Modal
				open={open()}
				onClose={() => setOpen(false)}
				title="Add registry"
				footer={
					<>
						<Button variant="secondary" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							variant="primary"
							loading={saving()}
							disabled={!username().trim() || !password()}
							onClick={() => void add()}
						>
							Add registry
						</Button>
					</>
				}
			>
				<div class="space-y-4">
					<Field
						label="Registry host"
						hint="Leave empty for Docker Hub. Examples: ghcr.io, registry.gitlab.com"
					>
						<Input
							mono
							autofocus
							placeholder="docker.io"
							value={server()}
							onInput={(event) => setServer(event.currentTarget.value)}
						/>
					</Field>
					<Field label="Username">
						<Input value={username()} onInput={(event) => setUsername(event.currentTarget.value)} />
					</Field>
					<Field
						label="Password or access token"
						hint="Stored encrypted. Prefer a read-only token."
					>
						<PasswordInput
							value={password()}
							onInput={(event) => setPassword(event.currentTarget.value)}
						/>
					</Field>
				</div>
			</Modal>
		</>
	);
};

export default RegistriesSettings;
