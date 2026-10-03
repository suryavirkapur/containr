import { Navigate } from "@solidjs/router";
import ShieldCheck from "lucide-solid/icons/shield-check";
import { createEffect, createResource, createSignal, on, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { getSettings, issueDashboardCertificate, updateSettings } from "../../api/settings";
import {
	Button,
	Card,
	CopyField,
	Field,
	Input,
	Notice,
	SaveBar,
	SettingRow,
	Skeleton,
	Switch,
} from "../../components/ui";
import { toast } from "../../components/ui/overlay";
import { useAuth } from "../../context/AuthContext";

type Form = {
	base_domain: string;
	public_ip: string;
	acme_email: string;
	acme_staging: boolean;
	log_retention_days: string;
	storage_public_hostname: string;
	storage_management_endpoint: string;
	storage_internal_host: string;
	storage_port: string;
};

const GeneralSettings = () => {
	const auth = useAuth();
	const [settings, { refetch, mutate }] = createResource(getSettings);
	const [form, setForm] = createStore<Form>({} as Form);
	const [saving, setSaving] = createSignal(false);
	const [issuing, setIssuing] = createSignal(false);

	const initial = (): Form | null => {
		const value = settings();
		if (!value) return null;
		return {
			base_domain: value.base_domain,
			public_ip: value.public_ip ?? "",
			acme_email: value.acme_email,
			acme_staging: value.acme_staging,
			log_retention_days: String(value.log_retention_days),
			storage_public_hostname: value.storage_public_hostname ?? "",
			storage_management_endpoint: value.storage_management_endpoint,
			storage_internal_host: value.storage_internal_host,
			storage_port: String(value.storage_port),
		};
	};
	const reset = () => {
		const value = initial();
		if (value) setForm(value);
	};
	createEffect(on(settings, reset));
	// stringify the store proxy itself so every field is tracked
	const dirty = () => JSON.stringify(form) !== JSON.stringify(initial());

	const save = async () => {
		const retention = Number.parseInt(form.log_retention_days, 10);
		const port = Number.parseInt(form.storage_port, 10);
		setSaving(true);
		try {
			const updated = await updateSettings({
				base_domain: form.base_domain.trim() || null,
				public_ip: form.public_ip.trim() || null,
				acme_email: form.acme_email.trim() || null,
				acme_staging: form.acme_staging,
				log_retention_days: Number.isFinite(retention) && retention >= 0 ? retention : null,
				storage_public_hostname: form.storage_public_hostname.trim() || null,
				storage_management_endpoint: form.storage_management_endpoint.trim() || null,
				storage_internal_host: form.storage_internal_host.trim() || null,
				storage_port: Number.isFinite(port) ? port : null,
			});
			mutate(updated);
			toast.success("Settings saved");
		} catch (error) {
			toast.error("Could not save settings", error);
		} finally {
			setSaving(false);
		}
	};

	const issue = async () => {
		setIssuing(true);
		try {
			const result = await issueDashboardCertificate();
			toast.success("Certificate requested", result.message);
			setTimeout(() => void refetch(), 5000);
		} catch (error) {
			toast.error("Could not request a certificate", error);
		} finally {
			setIssuing(false);
		}
	};

	return (
		<Show when={auth.user()?.is_admin} fallback={<Navigate href="/settings/account" />}>
			<Show when={settings()} fallback={<Skeleton class="h-80" />}>
				<div class="space-y-6">
					<Card
						title="Root domain"
						description="Every service gets a subdomain of it, and the dashboard can live on it too."
					>
						<div class="grid gap-4 sm:grid-cols-2">
							<Field
								label="Root domain"
								hint={
									<>
										Point a wildcard <code>*.{form.base_domain || "example.com"}</code> A record at
										this server.
									</>
								}
							>
								<Input
									mono
									placeholder="apps.example.com"
									value={form.base_domain ?? ""}
									onInput={(event) =>
										setForm("base_domain", event.currentTarget.value.trim().toLowerCase())
									}
								/>
							</Field>
							<Field label="Public IP" hint="Shown in DNS instructions and used for direct ports.">
								<Input
									mono
									placeholder="203.0.113.10"
									value={form.public_ip ?? ""}
									onInput={(event) => setForm("public_ip", event.currentTarget.value.trim())}
								/>
							</Field>
						</div>
					</Card>

					<Card
						title="HTTPS"
						description="Certificates are issued and renewed automatically with Let's Encrypt."
						actions={
							<Button
								variant="secondary"
								size="sm"
								loading={issuing()}
								onClick={() => void issue()}
								disabled={!settings()?.base_domain}
							>
								<ShieldCheck />
								Secure dashboard
							</Button>
						}
					>
						<Show when={settings()?.dashboard_url}>
							<Field label="Dashboard URL" class="mb-4">
								<CopyField value={settings()?.dashboard_url ?? ""} />
							</Field>
						</Show>
						<div class="grid gap-4 sm:grid-cols-2">
							<Field label="Contact email" hint="Let's Encrypt sends expiry warnings here.">
								<Input
									type="email"
									value={form.acme_email ?? ""}
									onInput={(event) => setForm("acme_email", event.currentTarget.value)}
								/>
							</Field>
						</div>
						<div class="mt-2 divide-y divide-border">
							<SettingRow
								title="Use Let's Encrypt staging"
								description="Test certificates that browsers don't trust, with much higher rate limits. Turn off for production."
							>
								<Switch
									checked={form.acme_staging}
									onChange={(value) => setForm("acme_staging", value)}
									label="Use staging"
								/>
							</SettingRow>
						</div>
						<Show when={form.acme_staging}>
							<Notice tone="warning" class="mt-2">
								Staging certificates show a browser warning. Switch off staging once DNS works.
							</Notice>
						</Show>
					</Card>

					<Card title="Logs" description="containr's own log files on this server.">
						<div class="grid gap-4 sm:grid-cols-2">
							<Field label="Retention (days)" hint="0 keeps logs forever.">
								<Input
									type="number"
									min="0"
									value={form.log_retention_days ?? ""}
									onInput={(event) => setForm("log_retention_days", event.currentTarget.value)}
								/>
							</Field>
							<Field label="Log directory">
								<CopyField value={settings()?.log_dir ?? ""} />
							</Field>
						</div>
					</Card>

					<Card
						title="Object storage"
						description="Connection to the built-in S3-compatible store used by Storage buckets."
					>
						<div class="grid gap-4 sm:grid-cols-2">
							<Field
								label="Public S3 hostname"
								optional
								hint="Exposes buckets publicly through the proxy."
							>
								<Input
									mono
									placeholder="s3.example.com"
									value={form.storage_public_hostname ?? ""}
									onInput={(event) => setForm("storage_public_hostname", event.currentTarget.value)}
								/>
							</Field>
							<Field label="Management endpoint">
								<Input
									mono
									value={form.storage_management_endpoint ?? ""}
									onInput={(event) =>
										setForm("storage_management_endpoint", event.currentTarget.value)
									}
								/>
							</Field>
							<Field label="Internal host">
								<Input
									mono
									value={form.storage_internal_host ?? ""}
									onInput={(event) => setForm("storage_internal_host", event.currentTarget.value)}
								/>
							</Field>
							<Field label="Port">
								<Input
									mono
									value={form.storage_port ?? ""}
									onInput={(event) => setForm("storage_port", event.currentTarget.value)}
								/>
							</Field>
						</div>
					</Card>

					<Card title="Ports" description="Set in containr.toml on the server.">
						<div class="grid gap-4 sm:grid-cols-3">
							<Field label="HTTP">
								<CopyField value={String(settings()?.http_port ?? "")} />
							</Field>
							<Field label="HTTPS">
								<CopyField value={String(settings()?.https_port ?? "")} />
							</Field>
							<Field label="API">
								<CopyField value={String(settings()?.api_port ?? "")} />
							</Field>
						</div>
					</Card>

					<SaveBar dirty={dirty()} saving={saving()} onSave={() => void save()} onReset={reset} />
				</div>
			</Show>
		</Show>
	);
};

export default GeneralSettings;
