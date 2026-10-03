import { Navigate } from "@solidjs/router";
import Plus from "lucide-solid/icons/plus";
import Trash from "lucide-solid/icons/trash";
import { createResource, createSignal, For, Show } from "solid-js";
import { createUser, listUsers } from "../../api/auth";
import { deleteUser } from "../../api/platform";
import { Badge, Button, Card, Field, Input, PasswordInput, Skeleton } from "../../components/ui";
import { confirm, Modal, toast } from "../../components/ui/overlay";
import { useAuth } from "../../context/AuthContext";
import { randomSecret } from "../../lib/format";

const UsersSettings = () => {
	const auth = useAuth();
	const [users, { refetch }] = createResource(
		() => (auth.user()?.is_admin ? true : null),
		listUsers,
	);
	const [open, setOpen] = createSignal(false);
	const [email, setEmail] = createSignal("");
	const [password, setPassword] = createSignal("");
	const [saving, setSaving] = createSignal(false);

	const openInvite = () => {
		setEmail("");
		setPassword(randomSecret(16));
		setOpen(true);
	};

	const create = async () => {
		setSaving(true);
		try {
			await createUser({ email: email().trim(), password: password() });
			toast.success(`Added ${email().trim()}`, "Share the temporary password with them securely.");
			setOpen(false);
			void refetch();
		} catch (error) {
			toast.error("Could not add the user", error);
		} finally {
			setSaving(false);
		}
	};

	const remove = async (id: string, userEmail: string) => {
		const ok = await confirm({
			title: `Remove ${userEmail}?`,
			description: "Their services, databases and deployments are deleted too.",
			confirmLabel: "Remove user",
			danger: true,
			typeToConfirm: userEmail,
		});
		if (!ok) return;
		try {
			await deleteUser(id);
			toast.success(`Removed ${userEmail}`);
			void refetch();
		} catch (error) {
			toast.error("Could not remove the user", error);
		}
	};

	return (
		<Show when={auth.user()?.is_admin} fallback={<Navigate href="/settings/account" />}>
			<Card
				title="Users"
				description="Everyone with access to this server. Each user sees only their own services."
				flush
				actions={
					<Button variant="primary" size="sm" onClick={openInvite}>
						<Plus />
						Add user
					</Button>
				}
			>
				<Show
					when={users()}
					fallback={
						<div class="p-4">
							<Skeleton class="h-16" />
						</div>
					}
				>
					<ul class="divide-y divide-border">
						<For each={users()}>
							{(user) => (
								<li class="flex items-center gap-3 px-4 py-3">
									<span class="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-soft-fg uppercase">
										{(user.github_username ?? user.email).slice(0, 1)}
									</span>
									<div class="min-w-0 flex-1">
										<div class="truncate text-[13.5px] font-medium">{user.email}</div>
										<Show when={user.github_username}>
											<div class="text-[12px] text-fg-subtle">@{user.github_username}</div>
										</Show>
									</div>
									<Show when={user.is_admin}>
										<Badge tone="accent">Admin</Badge>
									</Show>
									<Show when={user.id === auth.user()?.id}>
										<Badge>You</Badge>
									</Show>
									<Show when={user.id !== auth.user()?.id}>
										<button
											type="button"
											class="btn btn-ghost btn-icon btn-sm hover:text-danger!"
											aria-label={`Remove ${user.email}`}
											onClick={() => void remove(user.id, user.email)}
										>
											<Trash />
										</button>
									</Show>
								</li>
							)}
						</For>
					</ul>
				</Show>
			</Card>
			<Modal
				open={open()}
				onClose={() => setOpen(false)}
				title="Add user"
				description="They can change the temporary password after signing in."
				footer={
					<>
						<Button variant="secondary" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							variant="primary"
							loading={saving()}
							disabled={!email().includes("@") || password().length < 8}
							onClick={() => void create()}
						>
							Add user
						</Button>
					</>
				}
			>
				<div class="space-y-4">
					<Field label="Email">
						<Input
							type="email"
							autofocus
							value={email()}
							onInput={(event) => setEmail(event.currentTarget.value)}
						/>
					</Field>
					<Field label="Temporary password">
						<PasswordInput
							value={password()}
							onInput={(event) => setPassword(event.currentTarget.value)}
						/>
					</Field>
				</div>
			</Modal>
		</Show>
	);
};

export default UsersSettings;
