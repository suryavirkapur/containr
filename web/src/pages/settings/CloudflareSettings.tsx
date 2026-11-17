import Cloud from "lucide-solid/icons/cloud";
import CloudOff from "lucide-solid/icons/cloud-off";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import ShieldCheck from "lucide-solid/icons/shield-check";
import { createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { errorMessage } from "../../api/http";
import {
	connectCloudflare,
	disconnectCloudflare,
	getCloudflareStatus,
	listCloudflareZones,
} from "../../api/settings";
import {
	Badge,
	Button,
	Card,
	Field,
	Input,
	Notice,
	PasswordInput,
	Skeleton,
} from "../../components/ui";
import { confirm, toast } from "../../components/ui/overlay";
import { timeAgo } from "../../lib/format";

const CloudflareSettings = () => {
	const [status, { refetch }] = createResource(() =>
		getCloudflareStatus().catch(() => null),
	);
	const [zones, { refetch: refetchZones }] = createResource(
		() => status()?.connected ?? false,
		(connected) => (connected ? listCloudflareZones().catch(() => []) : []),
	);
	const [apiToken, setApiToken] = createSignal("");
	const [accountId, setAccountId] = createSignal("");
	const [saving, setSaving] = createSignal(false);

	const connect = async () => {
		setSaving(true);
		try {
			await connectCloudflare(apiToken().trim(), accountId().trim());
			toast.success(
				"Connected to Cloudflare",
				"The tunnel is up. Mark a domain for Cloudflare in a service's networking tab.",
			);
			setApiToken("");
			setAccountId("");
			await refetch();
			await refetchZones();
		} catch (error) {
			toast.error("Could not connect to Cloudflare", error);
		} finally {
			setSaving(false);
		}
	};

	const disconnect = async () => {
		const ok = await confirm({
			title: "Disconnect Cloudflare?",
			description:
				"The tunnel and its DNS records are removed and Cloudflare domains become directly reachable again.",
			confirmLabel: "Disconnect",
			danger: true,
		});
		if (!ok) return;
		setSaving(true);
		try {
			await disconnectCloudflare();
			toast.success("Cloudflare disconnected");
			await refetch();
		} catch (error) {
			toast.error("Could not disconnect Cloudflare", error);
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<Switch>
				<Match when={status.loading && !status()}>
					<Card title="Cloudflare Tunnel">
						<div class="p-4">
							<Skeleton class="h-24" />
						</div>
					</Card>
				</Match>
				<Match when={status()?.connected ? status() : null}>
					{(connected) => (
						<>
							<Card
								title="Cloudflare Tunnel"
								description="Traffic reaches this server through an outbound tunnel, so Cloudflare domains need no public ports."
								actions={
									<Button
										variant="danger"
										size="sm"
										loading={saving()}
										onClick={() => void disconnect()}
									>
										<CloudOff />
										Disconnect
									</Button>
								}
							>
								<div class="space-y-3 p-4">
									<div class="flex flex-wrap items-center gap-2">
										<Badge tone="success">
											<Cloud width={11} height={11} />
											Connected
										</Badge>
										<Show when={connected().tunnel_name}>
											<span class="text-[13px] text-fg-muted">
												tunnel {connected().tunnel_name}
											</span>
										</Show>
										<Badge
											tone={
												connected().cloudflared_running ? "success" : "neutral"
											}
										>
											cloudflared{" "}
											{connected().cloudflared_running
												? "running"
												: connected().cloudflared_installed
													? "installed"
													: "not installed"}
										</Badge>
										<Badge
											tone={connected().firewall_active ? "success" : "neutral"}
										>
											{connected().firewall_active
												? "ports 80/443 closed"
												: connected().firewall_required
													? "ports 80/443 still open"
													: "ports 80/443 open"}
										</Badge>
									</div>
									<Show when={connected().firewall_required && !connected().firewall_active}>
										<Notice tone="warning">
											Every public domain is tunnel-fronted, but the firewall could
											not close ports 80/443. containr needs nftables and root
											privileges to manage the host firewall.
										</Notice>
									</Show>
									<Show when={connected().last_error}>
										<Notice tone="danger">{connected().last_error}</Notice>
									</Show>
									<Show when={connected().last_sync_at}>
										<div class="text-[12px] text-fg-subtle">
											Last synced {timeAgo(connected().last_sync_at)}
										</div>
									</Show>
								</div>
							</Card>

							<Card
								title="Tunneled domains"
								description="Mark a domain for Cloudflare in a service's networking tab; containr points a proxied DNS record at the tunnel."
								flush
								actions={
									<Button
										variant="secondary"
										size="sm"
										onClick={() => void refetch()}
									>
										<RefreshCw />
										Refresh
									</Button>
								}
							>
								<Switch>
									<Match when={!connected().domains?.length}>
										<div class="p-4 text-[13px] text-fg-muted">
											No Cloudflare domains yet. Open a service's networking tab
											and switch a domain to Cloudflare.
										</div>
									</Match>
									<Match when={true}>
										<ul class="divide-y divide-border">
											<For each={connected().domains}>
												{(domain) => (
													<li class="flex items-center gap-3 px-4 py-3">
														<span class="flex h-8 w-8 items-center justify-center rounded-md bg-surface-2 text-fg-subtle">
															<Cloud width={15} height={15} />
														</span>
														<div class="min-w-0 flex-1">
															<div class="truncate font-mono text-[13px]">
																{domain.domain}
															</div>
															<Show when={domain.error}>
																<div class="text-[12px] text-danger">
																	{domain.error}
																</div>
															</Show>
														</div>
														<Badge
															tone={domain.dns_ready ? "success" : "warning"}
														>
															<ShieldCheck width={11} height={11} />
															{domain.dns_ready ? "DNS ready" : "DNS pending"}
														</Badge>
													</li>
												)}
											</For>
										</ul>
									</Match>
								</Switch>
							</Card>

							<Card title="Zones" flush>
								<div class="p-4">
									<Show
										when={zones()?.length}
										fallback={
											<span class="text-[13px] text-fg-muted">
												No zones visible to this token.
											</span>
										}
									>
										<div class="flex flex-wrap gap-2">
											<For each={zones()}>
												{(zone) => <Badge>{zone.name}</Badge>}
											</For>
										</div>
									</Show>
								</div>
							</Card>
						</>
					)}
				</Match>
				<Match when={true}>
					<Card
						title="Connect to Cloudflare"
						description="Serve domains through a Cloudflare Tunnel instead of public ports. Cloudflare terminates TLS and contains the tunnel; containr manages DNS records and closes ports 80/443 once nothing else needs them."
					>
						<div class="space-y-4 p-4">
							<Notice tone="info">
								Create an API token in the Cloudflare dashboard with
								"Cloudflare Tunnel: Edit" and "Zone → DNS: Edit" permissions,
								then paste it here. The token is stored encrypted and never
								shown again.
							</Notice>
							<Field label="API token">
								<PasswordInput
									autofocus
									placeholder="cloudflare api token"
									value={apiToken()}
									onInput={(event) => setApiToken(event.currentTarget.value)}
								/>
							</Field>
							<Field
								label="Account ID"
								hint="Found on any domain's overview page in the Cloudflare dashboard."
							>
								<Input
									mono
									placeholder="cloudflare account id"
									value={accountId()}
									onInput={(event) => setAccountId(event.currentTarget.value)}
								/>
							</Field>
							<div class="flex justify-end">
								<Button
									variant="primary"
									loading={saving()}
									disabled={!apiToken().trim() || !accountId().trim()}
									onClick={() => void connect()}
								>
									<Cloud />
									Connect to Cloudflare
								</Button>
							</div>
						</div>
					</Card>
					<Show when={status.error}>
						<div class="mt-4">
							<Notice tone="danger">{errorMessage(status.error)}</Notice>
						</div>
					</Show>
				</Match>
			</Switch>
		</>
	);
};

export default CloudflareSettings;
