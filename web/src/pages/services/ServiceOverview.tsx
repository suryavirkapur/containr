import { A } from "@solidjs/router";
import ArrowRight from "lucide-solid/icons/arrow-right";
import ExternalLink from "lucide-solid/icons/external-link";
import GitCommitHorizontal from "lucide-solid/icons/git-commit-horizontal";
import { type Component, createResource, For, type JSX, Match, Show, Switch } from "solid-js";
import { getServiceMetrics } from "../../api/platform";
import { listServiceDeployments } from "../../api/services";
import {
	Card,
	CopyButton,
	CopyField,
	DescriptionList,
	LinkButton,
	Meter,
	Notice,
	Skeleton,
	StatusBadge,
	StatusDot,
} from "../../components/ui";
import { formatBytes, formatDuration, formatPercent, shortId, timeAgo } from "../../lib/format";
import { displayHost, publicPorts, typeLabel } from "../../lib/services";
import { useService } from "./context";

const UrlRow: Component<{ url: string; label?: JSX.Element }> = (props) => (
	<div class="group flex items-center gap-2 py-2">
		<a
			href={props.url}
			target="_blank"
			rel="noreferrer"
			class="inline-flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium hover:underline"
		>
			{displayHost(props.url)}
			<ExternalLink width={12} height={12} class="shrink-0 text-fg-faint" />
		</a>
		<Show when={props.label}>{props.label}</Show>
		<CopyButton value={props.url} class="ml-auto opacity-0 group-hover:opacity-100" />
	</div>
);

const ServiceOverview = () => {
	const ctx = useService();
	const service = () => ctx.service();

	const [deployments] = createResource(
		() => (ctx.isApp() ? ctx.id() : null),
		(id) => listServiceDeployments(id).catch(() => []),
	);
	const [metrics] = createResource(
		() => (service()?.status === "running" ? ctx.id() : null),
		(id) => getServiceMetrics(id).catch(() => null),
	);

	const latest = () => deployments()?.[0];
	const totals = () => {
		const containers = metrics()?.containers ?? [];
		return {
			cpu: containers.reduce((sum, item) => sum + item.cpu_percent, 0),
			memory: containers.reduce((sum, item) => sum + item.memory_used_bytes, 0),
			limit: containers.reduce((sum, item) => sum + item.memory_limit_bytes, 0),
		};
	};
	const settingsService = () =>
		ctx.settings()?.service as
			| (NonNullable<ReturnType<typeof ctx.settings>>["service"] & { notes?: string | null })
			| undefined;

	const urls = () => {
		const current = service();
		if (!current) return [] as Array<{ url: string; https: boolean; custom: boolean }>;
		return [
			...current.domains.map((domain) => ({
				url: `${current.http_only_domains.includes(domain) ? "http" : "https"}://${domain}`,
				https: !current.http_only_domains.includes(domain),
				custom: true,
			})),
			...current.default_urls.map((url) => ({
				url,
				https: url.startsWith("https"),
				custom: false,
			})),
		];
	};

	return (
		<Show when={service()}>
			{(current) => (
				<div class="grid gap-6 lg:grid-cols-[1fr_340px]">
					<div class="space-y-6">
						<Show when={ctx.isApp()}>
							<Card
								title="Latest deployment"
								actions={
									<LinkButton href={`/services/${ctx.id()}/deployments`} variant="ghost" size="sm">
										All deployments
										<ArrowRight />
									</LinkButton>
								}
							>
								<Switch>
									<Match when={deployments.loading}>
										<Skeleton class="h-12" />
									</Match>
									<Match when={!latest()}>
										<p class="text-[13px] text-fg-subtle">
											No deployments yet. Press <span class="font-medium text-fg">Deploy</span> to
											build and start this service.
										</p>
									</Match>
									<Match when={latest()}>
										{(deployment) => (
											<div class="flex flex-wrap items-center gap-4">
												<StatusBadge status={deployment().status} />
												<div class="min-w-0 flex-1">
													<div class="truncate text-[13.5px] font-medium">
														{deployment().commit_message || "Manual deployment"}
													</div>
													<div class="mt-0.5 flex items-center gap-1.5 text-[12px] text-fg-subtle">
														<GitCommitHorizontal width={13} height={13} />
														<code>{shortId(deployment().commit_sha)}</code>
														<span>·</span>
														<span>{timeAgo(deployment().created_at)}</span>
														<Show when={deployment().started_at}>
															<span>·</span>
															<span>
																{formatDuration(deployment().started_at, deployment().finished_at)}
															</span>
														</Show>
													</div>
												</div>
											</div>
										)}
									</Match>
								</Switch>
							</Card>
						</Show>

						<Card
							title={ctx.isApp() ? "Domains" : "Connection"}
							actions={
								<Show when={ctx.isApp()}>
									<LinkButton href={`/services/${ctx.id()}/networking`} variant="ghost" size="sm">
										Manage
										<ArrowRight />
									</LinkButton>
								</Show>
							}
						>
							<Show
								when={ctx.isApp()}
								fallback={
									<div class="space-y-4">
										<Show when={current().connection_string}>
											<div>
												<div class="label">Internal connection string</div>
												<CopyField value={current().connection_string ?? ""} secret />
												<p class="hint">Use this from services in the same project network.</p>
											</div>
										</Show>
										<Show when={current().proxy_connection_string}>
											<div>
												<div class="label">External connection string</div>
												<CopyField value={current().proxy_connection_string ?? ""} secret />
											</div>
										</Show>
										<DescriptionList
											items={[
												{ label: "Host", value: current().internal_host ?? "–", mono: true },
												{ label: "Port", value: String(current().port ?? "–"), mono: true },
												{
													label: "Public port",
													value: current().external_port
														? `${current().public_ip ?? "server"}:${current().external_port}`
														: "Not exposed",
													mono: Boolean(current().external_port),
												},
												{ label: "Network", value: current().network_name, mono: true },
											]}
										/>
									</div>
								}
							>
								<Show
									when={urls().length > 0}
									fallback={
										<p class="text-[13px] text-fg-subtle">
											{current().public_http
												? "No domains yet."
												: publicPorts(current()).length > 0
													? `Not exposed over HTTP, but published on ${publicPorts(current()).join(", ")}: anyone on the internet can connect to that port. Remove the port mapping under Networking to make it private.`
													: "This service isn't exposed over HTTP. Other services reach it on the internal network."}
										</p>
									}
								>
									<div class="-my-2 divide-y divide-border">
										<For each={urls()}>
											{(item) => (
												<UrlRow
													url={item.url}
													label={
														<span class="text-[11.5px] text-fg-faint">
															{item.custom ? "custom" : "default"}
															{item.https ? "" : " · http only"}
														</span>
													}
												/>
											)}
										</For>
									</div>
								</Show>
							</Show>
						</Card>

						<Show when={settingsService()?.notes}>
							<Card title="Notes">
								<p class="text-[13px] whitespace-pre-wrap text-fg-muted">
									{settingsService()?.notes}
								</p>
							</Card>
						</Show>
					</div>

					<div class="space-y-6">
						<Card title="Instances">
							<div class="flex items-baseline gap-1.5">
								<span class="text-[24px] font-semibold tabular-nums">
									{current().running_instances}
								</span>
								<span class="text-[13px] text-fg-subtle">
									of {current().desired_instances} running
								</span>
							</div>
							<Show when={current().container_ids.length > 0}>
								<ul class="mt-3 space-y-1.5">
									<For each={current().container_ids}>
										{(container) => (
											<li class="flex items-center gap-2 text-[12px]">
												<StatusDot status={current().status} />
												<code class="truncate text-fg-muted">{container}</code>
											</li>
										)}
									</For>
								</ul>
							</Show>
							<Show when={metrics()?.containers.length}>
								<div class="mt-4 space-y-3 border-t border-border pt-4">
									<div>
										<div class="mb-1.5 flex justify-between text-[12px]">
											<span class="text-fg-subtle">CPU</span>
											<span class="tabular-nums">{formatPercent(totals().cpu)}</span>
										</div>
										<Meter value={totals().cpu} />
									</div>
									<div>
										<div class="mb-1.5 flex justify-between text-[12px]">
											<span class="text-fg-subtle">Memory</span>
											<span class="tabular-nums">
												{formatBytes(totals().memory)}
												<Show when={totals().limit}> / {formatBytes(totals().limit)}</Show>
											</span>
										</div>
										<Meter value={totals().limit ? (totals().memory / totals().limit) * 100 : 0} />
									</div>
									<A
										href={`/services/${ctx.id()}/metrics`}
										class="block text-[12px] text-fg-subtle hover:text-fg"
									>
										View metrics →
									</A>
								</div>
							</Show>
						</Card>

						<Card title="Details">
							<DescriptionList
								class="-my-2.5"
								items={[
									{ label: "Type", value: typeLabel(current().service_type) },
									...(ctx.isApp()
										? [
												{
													label: "Source",
													value: (
														<Show
															when={ctx.settings()?.github_url}
															fallback={
																<span class="font-mono text-[12.5px]">
																	{current().image || "–"}
																</span>
															}
														>
															<span
																class="font-mono text-[12.5px]"
																title={ctx.settings()?.github_url}
															>
																{ctx
																	.settings()
																	?.github_url.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
																<span class="text-fg-faint">@{ctx.settings()?.branch}</span>
															</span>
														</Show>
													),
												},
											]
										: [{ label: "Image", value: current().image ?? "–", mono: true }]),
									{
										label: "Internal host",
										value: (
											<span class="inline-flex items-center gap-1">
												<code class="truncate">
													{current().internal_host ?? "–"}
													<Show when={current().port}>:{current().port}</Show>
												</code>
												<Show when={current().internal_host}>
													<CopyButton
														value={`${current().internal_host}:${current().port ?? ""}`}
													/>
												</Show>
											</span>
										),
									},
									...(current().schedule
										? [{ label: "Schedule", value: current().schedule ?? "", mono: true }]
										: []),
									{ label: "Created", value: timeAgo(current().created_at) },
								]}
							/>
						</Card>

						<Show when={current().status === "failed"}>
							<Notice tone="danger" title="This service is failing">
								Check the{" "}
								<A class="underline" href={`/services/${ctx.id()}/logs`}>
									logs
								</A>{" "}
								and the latest build output.
							</Notice>
						</Show>
					</div>
				</div>
			)}
		</Show>
	);
};

export default ServiceOverview;
