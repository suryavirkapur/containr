import { Navigate, useSearchParams } from "@solidjs/router";
import ExternalLink from "lucide-solid/icons/external-link";
import Plus from "lucide-solid/icons/plus";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Trash from "lucide-solid/icons/trash";
import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { deleteGithubApp, getGithubAppManifest, getGithubAppStatus } from "../../api/settings";
import { Badge, Button, Card, EmptyState, LinkButton, Notice, Skeleton } from "../../components/ui";
import { GithubIcon } from "../../components/ui/brand";
import { confirm, toast } from "../../components/ui/overlay";
import { useAuth } from "../../context/AuthContext";

const appendPath = (base: string | undefined, suffix: string) =>
	base ? `${base.replace(/\/+$/, "")}${suffix}` : null;

const GithubSettings = () => {
	const auth = useAuth();
	const [params] = useSearchParams();
	const [status, { refetch }] = createResource(
		() => (auth.user()?.is_admin ? true : null),
		getGithubAppStatus,
	);
	const [creating, setCreating] = createSignal(false);

	onMount(() => {
		if (params.created)
			toast.success("GitHub App created", "Now install it on your account or organisation.");
		if (params.installed)
			toast.success(
				"GitHub App installed",
				"Your repositories are available when creating services.",
			);
	});

	const create = async () => {
		setCreating(true);
		try {
			const manifest = await getGithubAppManifest();
			const form = document.createElement("form");
			form.method = "POST";
			form.action = "https://github.com/settings/apps/new";
			form.target = "_blank";
			const input = document.createElement("input");
			input.type = "hidden";
			input.name = "manifest";
			input.value = manifest;
			form.append(input);
			document.body.append(form);
			form.submit();
			form.remove();
		} catch (error) {
			toast.error("Could not start the GitHub App setup", error);
		} finally {
			setCreating(false);
		}
	};

	const remove = async () => {
		const ok = await confirm({
			title: "Disconnect the GitHub App?",
			description:
				"Auto-deploys and private repository access stop working. The app itself stays on GitHub until you delete it there.",
			confirmLabel: "Disconnect",
			danger: true,
		});
		if (!ok) return;
		try {
			await deleteGithubApp();
			void refetch();
		} catch (error) {
			toast.error("Could not disconnect", error);
		}
	};

	return (
		<Show when={auth.user()?.is_admin} fallback={<Navigate href="/settings/account" />}>
			<Show when={status()} fallback={<Skeleton class="h-48" />}>
				{(current) => (
					<Show
						when={current().configured && current().app}
						fallback={
							<Card>
								<EmptyState
									icon={<GithubIcon />}
									title="Connect GitHub"
									description="Create a GitHub App owned by you to deploy private repositories and redeploy on every push. Takes about a minute."
									class="border-0"
								>
									<Button variant="primary" loading={creating()} onClick={() => void create()}>
										<GithubIcon />
										Create GitHub App
									</Button>
								</EmptyState>
							</Card>
						}
					>
						<div class="space-y-6">
							<Card
								title={
									<span class="flex items-center gap-2">
										<GithubIcon />
										{current().app?.app_name}
									</span>
								}
								description="The GitHub App containr uses for clones and push webhooks."
								actions={
									<>
										<LinkButton
											href={current().app?.html_url ?? "https://github.com"}
											external
											size="sm"
											variant="ghost"
										>
											Open on GitHub
											<ExternalLink />
										</LinkButton>
										<Button variant="danger-outline" size="sm" onClick={() => void remove()}>
											<Trash />
											Disconnect
										</Button>
									</>
								}
							>
								<Badge tone="success">Connected</Badge>
							</Card>
							<Card
								title="Installations"
								description="Accounts and organisations whose repositories containr can access."
								flush
								actions={
									<>
										<Button
											variant="ghost"
											size="sm"
											icon
											onClick={() => void refetch()}
											aria-label="Refresh"
										>
											<RefreshCw />
										</Button>
										<Show when={appendPath(current().app?.html_url, "/installations/new")}>
											{(href) => (
												<LinkButton href={href()} external size="sm" variant="primary">
													<Plus />
													Install
												</LinkButton>
											)}
										</Show>
									</>
								}
							>
								<Show
									when={current().installations.length > 0}
									fallback={
										<div class="p-4">
											<Notice tone="warning" title="Not installed yet">
												Install the app on your account or an organisation so containr can see its
												repositories.
											</Notice>
										</div>
									}
								>
									<ul class="divide-y divide-border">
										<For each={current().installations}>
											{(installation) => (
												<li class="flex items-center gap-3 px-4 py-3">
													<GithubIcon class="text-fg-subtle" />
													<span class="flex-1 text-[13.5px] font-medium">
														{installation.account_login}
													</span>
													<Badge>{installation.account_type}</Badge>
													<span class="text-[12px] text-fg-subtle">
														{installation.repository_count ?? "All"} repositories
													</span>
												</li>
											)}
										</For>
									</ul>
								</Show>
							</Card>
						</div>
					</Show>
				)}
			</Show>
		</Show>
	);
};

export default GithubSettings;
