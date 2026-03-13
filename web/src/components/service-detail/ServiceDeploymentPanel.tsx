import { createMemo, createSignal, For, Show, type Component } from "solid-js";

import type { ServiceDeployment } from "../../api/services";
import { parseAnsi } from "../../utils/ansi";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	EmptyState,
	Skeleton,
} from "../ui";
import {
	describeError,
	formatDate,
	formatDeploymentStatus,
	statusVariant,
} from "./formatters";

interface ServiceDeploymentPanelProps {
	deployments?: ServiceDeployment[];
	deploymentsLoading: boolean;
	deploymentsError: unknown;
	selectedDeploymentId: string;
	onSelectDeployment: (id: string) => void;
	selectedDeployment?: ServiceDeployment;
	selectedDeploymentLoading: boolean;
	selectedDeploymentError: unknown;
	deploymentLogs?: string[];
	deploymentLogsLoading: boolean;
	deploymentLogsError: unknown;
	deploying: boolean;
	rollbacking: boolean;
	onDeploy: () => void | Promise<void>;
	onRollback: (rolloutStrategy?: string) => void | Promise<void>;
	onRefreshDeployments: () => void | Promise<void>;
	onRefreshDeploymentDetails: () => void | Promise<void>;
	onRefreshDeploymentLogs: () => void | Promise<void>;
}

const rolloutStrategyInputClass =
	"flex h-11 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--input)] px-3 py-2 text-sm font-medium text-[var(--foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]";

export const ServiceDeploymentPanel: Component<
	ServiceDeploymentPanelProps
> = (props) => {
	const [rollbackStrategy, setRollbackStrategy] = createSignal("");

	const activeDeployment = createMemo(
		() =>
			props.selectedDeployment ??
			props.deployments?.find(
				(deployment) => deployment.id === props.selectedDeploymentId,
			),
	);
	const deploymentLogMarkup = createMemo(() =>
		parseAnsi((props.deploymentLogs ?? []).join("\n")),
	);

	const handleRollback = async () => {
		const deployment = activeDeployment();
		if (!deployment) {
			return;
		}

		if (
			!confirm(
				`queue a rollback to deployment ${deployment.commit_sha}? this creates a new deployment.`,
			)
		) {
			return;
		}

		await props.onRollback(rollbackStrategy().trim() || undefined);
	};

	return (
		<div class="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)]">
			<Card>
				<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
					<div>
						<CardTitle>service deployments</CardTitle>
						<CardDescription>
							Deployments are scoped to this service and selectable for
							inspection or rollback.
						</CardDescription>
					</div>
					<div class="flex flex-wrap gap-2">
						<Button
							variant="outline"
							onClick={() => void props.onRefreshDeployments()}
						>
							refresh
						</Button>
						<Button
							isLoading={props.deploying}
							onClick={() => void props.onDeploy()}
						>
							deploy latest
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					<Show when={props.deploymentsError}>
						<Alert variant="destructive" title="failed to load deployments">
							{describeError(props.deploymentsError)}
						</Alert>
					</Show>
					<Show when={props.deploymentsLoading}>
						<Skeleton class="h-56 w-full" />
					</Show>
					<Show
						when={!props.deploymentsLoading && (props.deployments?.length ?? 0) > 0}
						fallback={
							<EmptyState
								title="no deployments yet"
								description="queue a deployment to track rollout history for this service."
							/>
						}
					>
						<div class="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
							<For each={props.deployments ?? []}>
								{(deployment) => (
									<button
										type="button"
										class={`flex w-full flex-col gap-3 px-4 py-4 text-left transition-colors hover:bg-[var(--muted)] ${
											props.selectedDeploymentId === deployment.id
												? "bg-[var(--muted)]"
												: "bg-[var(--card)]"
										}`}
										onClick={() => props.onSelectDeployment(deployment.id)}
									>
										<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
											<div class="space-y-1">
												<p class="font-medium text-[var(--foreground)]">
													{deployment.commit_sha}
												</p>
												<p class="text-sm text-[var(--muted-foreground)]">
													{deployment.commit_message || "manual deployment"}
												</p>
											</div>
											<div class="flex items-center gap-3">
												<Badge variant={statusVariant(deployment.status)}>
													{formatDeploymentStatus(deployment)}
												</Badge>
												<p class="text-xs text-[var(--muted-foreground)]">
													{formatDate(deployment.created_at)}
												</p>
											</div>
										</div>
									</button>
								)}
							</For>
						</div>
					</Show>
				</CardContent>
			</Card>

			<div class="space-y-4">
				<Show
					when={activeDeployment()}
					fallback={
						<EmptyState
							title="select a deployment"
							description="Choose a deployment from the list to inspect its status and logs."
						/>
					}
				>
					{(deployment) => (
						<>
							<Card>
								<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
									<div>
										<CardTitle>deployment details</CardTitle>
										<CardDescription>
											Live data from the selected deployment endpoint.
										</CardDescription>
									</div>
									<div class="flex flex-wrap gap-2">
										<Button
											variant="outline"
											onClick={() => void props.onRefreshDeploymentDetails()}
										>
											refresh details
										</Button>
										<Button
											variant="secondary"
											isLoading={props.rollbacking}
											onClick={() => void handleRollback()}
										>
											rollback to this deploy
										</Button>
									</div>
								</CardHeader>
								<CardContent class="space-y-4">
									<Show when={props.selectedDeploymentError}>
										<Alert
											variant="destructive"
											title="failed to load deployment details"
										>
											{describeError(props.selectedDeploymentError)}
										</Alert>
									</Show>
									<Show when={props.selectedDeploymentLoading}>
										<Skeleton class="h-32 w-full" />
									</Show>
									<div class="grid gap-4 md:grid-cols-2">
										<div class="space-y-2">
											<p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
												commit
											</p>
											<p class="font-mono text-sm text-[var(--foreground)]">
												{deployment().commit_sha}
											</p>
											<p class="text-sm text-[var(--muted-foreground)]">
												{deployment().commit_message || "manual deployment"}
											</p>
										</div>
										<div class="space-y-2">
											<p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
												status
											</p>
											<Badge variant={statusVariant(deployment().status)}>
												{formatDeploymentStatus(deployment())}
											</Badge>
											<p class="text-sm text-[var(--muted-foreground)]">
												container {deployment().container_id || "not assigned"}
											</p>
										</div>
									</div>
									<div class="grid gap-4 md:grid-cols-2">
										<div class="space-y-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-4 py-3">
											<p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
												created
											</p>
											<p class="text-sm text-[var(--foreground)]">
												{formatDate(deployment().created_at)}
											</p>
										</div>
										<div class="space-y-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-4 py-3">
											<p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
												started
											</p>
											<p class="text-sm text-[var(--foreground)]">
												{formatDate(deployment().started_at)}
											</p>
										</div>
										<div class="space-y-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-4 py-3 md:col-span-2">
											<p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
												finished
											</p>
											<p class="text-sm text-[var(--foreground)]">
												{formatDate(deployment().finished_at)}
											</p>
										</div>
									</div>
									<div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
										<div class="space-y-2">
											<label
												class="text-sm font-medium text-[var(--foreground)]"
												for="rollback-strategy"
											>
												rollback rollout strategy
											</label>
											<select
												id="rollback-strategy"
												class={rolloutStrategyInputClass}
												value={rollbackStrategy()}
												onChange={(event) =>
													setRollbackStrategy(event.currentTarget.value)
												}
											>
												<option value="">use saved service strategy</option>
												<option value="stop_first">stop first</option>
												<option value="start_first">start first</option>
											</select>
										</div>
										<Button
											variant="secondary"
											isLoading={props.rollbacking}
											onClick={() => void handleRollback()}
										>
											queue rollback
										</Button>
									</div>
								</CardContent>
							</Card>

							<Card>
								<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
									<div>
										<CardTitle>deployment logs</CardTitle>
										<CardDescription>
											{deployment().commit_message || "manual deployment"} ·{" "}
											{deployment().commit_sha}
										</CardDescription>
									</div>
									<Button
										variant="outline"
										onClick={() => void props.onRefreshDeploymentLogs()}
									>
										refresh deployment logs
									</Button>
								</CardHeader>
								<CardContent>
									<Show when={props.deploymentLogsError}>
										<Alert
											variant="destructive"
											title="failed to load deployment logs"
										>
											{describeError(props.deploymentLogsError)}
										</Alert>
									</Show>
									<Show when={props.deploymentLogsLoading}>
										<Skeleton class="h-80 w-full" />
									</Show>
									<Show when={!props.deploymentLogsLoading}>
										<div
											class="min-h-80 overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-black px-4 py-4 font-mono text-xs leading-6 text-white"
											innerHTML={deploymentLogMarkup()}
										/>
									</Show>
								</CardContent>
							</Card>
						</>
					)}
				</Show>
			</div>
		</div>
	);
};
