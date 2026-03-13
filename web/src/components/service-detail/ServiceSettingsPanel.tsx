import { Show, type Component } from "solid-js";

import EnvVarEditor from "../EnvVarEditor";
import ServiceForm from "../ServiceForm";
import {
	Alert,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Skeleton,
	Switch,
	Textarea,
} from "../ui";
import { describeError } from "./formatters";
import type { SettingsFormState } from "./types";

interface ServiceSettingsPanelProps {
	settingsForm: SettingsFormState | null;
	settingsLoading: boolean;
	settingsError: unknown;
	deployWebhookUrl: string;
	saving: boolean;
	onUpdateSetting: <K extends keyof SettingsFormState>(
		key: K,
		value: SettingsFormState[K],
	) => void;
	onCopyWebhook: () => void | Promise<void>;
	onSave: () => void | Promise<void>;
}

const selectClass =
	"flex h-11 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--input)] px-3 py-2 text-sm font-medium text-[var(--foreground)] focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]";

export const ServiceSettingsPanel: Component<ServiceSettingsPanelProps> = (
	props,
) => (
	<>
		<Alert title="save config, then deploy">
			Settings are stored immediately, but runtime changes only apply after the
			next deployment.
		</Alert>

		<Show when={props.settingsError}>
			<Alert variant="destructive" title="failed to load settings">
				{describeError(props.settingsError)}
			</Alert>
		</Show>

		<Show when={props.settingsLoading && !props.settingsForm}>
			<Skeleton class="h-80 w-full" />
		</Show>

		<Show when={props.settingsForm}>
			{(form) => (
				<div class="space-y-4">
					<Card>
						<CardHeader>
							<CardTitle>repository</CardTitle>
							<CardDescription>
								Git source and rollout behavior for this service.
							</CardDescription>
						</CardHeader>
						<CardContent class="grid gap-4 md:grid-cols-2">
							<Input
								label="github url"
								value={form().githubUrl}
								onInput={(event) =>
									props.onUpdateSetting("githubUrl", event.currentTarget.value)
								}
								placeholder="https://github.com/org/repo.git"
							/>
							<Input
								label="branch"
								value={form().branch}
								onInput={(event) =>
									props.onUpdateSetting("branch", event.currentTarget.value)
								}
								placeholder="main"
							/>
							<div class="space-y-2 md:col-span-2">
								<label
									class="text-sm font-medium text-[var(--foreground)]"
									for="rollout-strategy"
								>
									rollout strategy
								</label>
								<select
									id="rollout-strategy"
									class={selectClass}
									value={form().rolloutStrategy}
									onChange={(event) =>
										props.onUpdateSetting(
											"rolloutStrategy",
											event.currentTarget.value,
										)
									}
								>
									<option value="stop_first">stop first</option>
									<option value="start_first">start first</option>
								</select>
							</div>
						</CardContent>
					</Card>

					<EnvVarEditor
						envVars={form().envVars}
						onChange={(envVars) => props.onUpdateSetting("envVars", envVars)}
						title="shared environment variables"
						description="applied to every container in this repository service."
						emptyText="no shared variables configured"
						addLabel="add shared variable"
					/>

					<div class="space-y-2">
						<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
							service definition
						</p>
						<h2 class="font-serif text-2xl text-[var(--foreground)]">
							build, runtime, and storage
						</h2>
					</div>
					<ServiceForm
						service={form().service}
						index={0}
						allServices={[form().service]}
						showServiceTypePicker={false}
						onUpdate={(_, next) => props.onUpdateSetting("service", next)}
						onRemove={() => {}}
						allowRemove={false}
					/>

					<Card>
						<CardHeader>
							<CardTitle>auto deploy</CardTitle>
							<CardDescription>
								Control github push deploys, watched paths, and CI-triggered
								deploy hooks.
							</CardDescription>
						</CardHeader>
						<CardContent class="space-y-4">
							<div class="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-4 py-4">
								<div class="space-y-1">
									<p class="font-medium text-[var(--foreground)]">
										github push auto-deploy
									</p>
									<p class="text-sm text-[var(--muted-foreground)]">
										Deploy automatically when matching pushes land on the tracked
										branch.
									</p>
								</div>
								<Switch
									checked={form().autoDeployEnabled}
									onChange={(checked) =>
										props.onUpdateSetting("autoDeployEnabled", checked)
									}
								/>
							</div>

							<div class="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-4 py-4">
								<div class="space-y-1">
									<p class="font-medium text-[var(--foreground)]">
										cleanup stale auto-deploys
									</p>
									<p class="text-sm text-[var(--muted-foreground)]">
										Stop queued or in-progress auto-deploys when a newer deploy
										is triggered.
									</p>
								</div>
								<Switch
									checked={form().cleanupStaleDeployments}
									onChange={(checked) =>
										props.onUpdateSetting("cleanupStaleDeployments", checked)
									}
								/>
							</div>

							<Textarea
								label="watch paths"
								description="Optional newline-delimited repo paths or glob patterns. Leave empty to deploy on every push."
								value={form().autoDeployWatchPathsText}
								onInput={(event) =>
									props.onUpdateSetting(
										"autoDeployWatchPathsText",
										event.currentTarget.value,
									)
								}
								placeholder={"apps/api/**\nDockerfile\npackage.json"}
								class="min-h-32 font-mono"
							/>

							<Input
								label="deploy webhook"
								description="Use this webhook from CI to trigger a deployment without GitHub push webhooks."
								value={props.deployWebhookUrl}
								readOnly
								class="font-mono text-xs"
							/>

							<div class="flex flex-wrap gap-3">
								<Button
									variant="outline"
									onClick={() => void props.onCopyWebhook()}
								>
									copy webhook
								</Button>
								<Button
									variant={
										form().regenerateWebhookToken ? "secondary" : "outline"
									}
									onClick={() =>
										props.onUpdateSetting(
											"regenerateWebhookToken",
											!form().regenerateWebhookToken,
										)
									}
								>
									{form().regenerateWebhookToken
										? "token rotates on save"
										: "rotate token on save"}
								</Button>
							</div>
						</CardContent>
					</Card>

					<div class="flex justify-end">
						<Button
							isLoading={props.saving}
							onClick={() => void props.onSave()}
						>
							save settings
						</Button>
					</div>
				</div>
			)}
		</Show>
	</>
);
