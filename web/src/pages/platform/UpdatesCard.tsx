import CircleArrowUp from "lucide-solid/icons/circle-arrow-up";
import ExternalLink from "lucide-solid/icons/external-link";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import { createResource, createSignal, Show } from "solid-js";
import { errorMessage } from "../../api/http";
import { checkForUpdate, getServerVersion, installUpdate } from "../../api/platform";
import { Badge, Button, Card, Notice, Skeleton } from "../../components/ui";
import { confirm, toast } from "../../components/ui/overlay";
import { timeAgo } from "../../lib/format";

const RESTART_POLL_MS = 2000;
const RESTART_TIMEOUT_MS = 3 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** waits until /health reports the new version; false on timeout */
const waitForVersion = async (version: string) => {
	const deadline = Date.now() + RESTART_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(RESTART_POLL_MS);
		try {
			if ((await getServerVersion()) === version) return true;
		} catch {
			// the server is down while it restarts
		}
	}
	return false;
};

export const UpdatesCard = () => {
	const [check, { refetch }] = createResource(checkForUpdate);
	const [installing, setInstalling] = createSignal(false);

	const install = async (version: string) => {
		const ok = await confirm({
			title: `Install containr ${version}?`,
			description:
				"containr downloads the release from GitHub, checks it and restarts. Containers keep running, but the dashboard, API and proxy are down for a few seconds, so sites briefly stop responding. The current binary is kept next to the new one as containr.previous.",
			confirmLabel: "Install and restart",
		});
		if (!ok) return;
		setInstalling(true);
		try {
			await installUpdate(version);
			toast.info("Update installed", "containr is restarting…");
			if (await waitForVersion(version)) {
				toast.success(`containr ${version} is running`);
				setTimeout(() => window.location.reload(), 800);
			} else {
				toast.error(
					"containr didn't come back",
					"Check the server logs. The previous binary is saved as containr.previous.",
				);
				setInstalling(false);
			}
		} catch (error) {
			toast.error("Update failed", error);
			setInstalling(false);
		}
	};

	return (
		<Card
			title="Updates"
			description="New containr versions are published as GitHub releases."
			actions={
				<Button
					variant="ghost"
					size="sm"
					loading={check.loading}
					disabled={installing()}
					onClick={() => void refetch()}
				>
					<RefreshCw />
					Check for updates
				</Button>
			}
		>
			<Show
				when={check.latest}
				fallback={
					check.error ? (
						<Notice tone="danger">{errorMessage(check.error)}</Notice>
					) : (
						<Skeleton class="h-16" />
					)
				}
			>
				{(value) => (
					<div class="space-y-3">
						<div class="flex items-center justify-between gap-3 text-[13px]">
							<span class="text-fg-subtle">Installed</span>
							<span class="font-mono">{value().current_version}</span>
						</div>
						<Show
							when={value().update_available && value().latest_version}
							fallback={
								<p class="text-[13px] text-fg-subtle">
									<Show
										when={value().latest_version}
										fallback="No releases have been published yet."
									>
										You're on the latest version.
									</Show>
								</p>
							}
						>
							{(latest) => (
								<>
									<div class="flex items-center justify-between gap-3 text-[13px]">
										<span class="text-fg-subtle">Available</span>
										<span class="flex items-center gap-2">
											<Badge tone="accent">New</Badge>
											<span class="font-mono">{latest()}</span>
										</span>
									</div>
									<div class="flex items-center justify-between gap-3 text-[12.5px] text-fg-subtle">
										<span>Released {timeAgo(value().published_at)}</span>
										<Show when={value().release_url}>
											{(url) => (
												<a
													href={url()}
													target="_blank"
													rel="noreferrer"
													class="inline-flex items-center gap-1 text-fg-muted hover:text-fg"
												>
													Release notes
													<ExternalLink width={12} height={12} />
												</a>
											)}
										</Show>
									</div>
									<Show when={value().release_notes?.trim()}>
										{(notes) => (
											<pre class="max-h-40 overflow-auto rounded-md border border-border bg-surface-2 p-2.5 font-sans text-[12px] whitespace-pre-wrap text-fg-muted">
												{notes()}
											</pre>
										)}
									</Show>
									<Show
										when={value().can_install}
										fallback={<Notice tone="warning">{value().install_blocker}</Notice>}
									>
										<Button
											variant="primary"
											class="w-full"
											loading={installing()}
											onClick={() => void install(latest())}
										>
											<CircleArrowUp />
											Install {latest()}
										</Button>
									</Show>
								</>
							)}
						</Show>
					</div>
				)}
			</Show>
		</Card>
	);
};
