import ExternalLink from "lucide-solid/icons/external-link";
import Plus from "lucide-solid/icons/plus";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import ShieldCheck from "lucide-solid/icons/shield-check";
import Trash from "lucide-solid/icons/trash";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	Index,
	on,
	Show,
} from "solid-js";
import type { PortMapping } from "../../api/platform";
import { getServiceCertificates, reissueServiceCertificate } from "../../api/services";
import { getSettings } from "../../api/settings";
import {
	Badge,
	Button,
	Card,
	CopyButton,
	CopyField,
	Field,
	Input,
	Notice,
	PasswordInput,
	SaveBar,
	Segmented,
	Select,
	SettingRow,
	Switch,
} from "../../components/ui";
import { isValidDomain } from "../../components/ui/editors";
import { toast } from "../../components/ui/overlay";
import { timeAgo } from "../../lib/format";
import { statusLabel, type Tone } from "../../lib/status";
import { useService } from "./context";

type DomainRow = { domain: string; https: boolean };

const certTone = (status?: string): Tone => {
	switch (status) {
		case "valid":
		case "active":
		case "issued":
			return "success";
		case "pending":
		case "requested":
		case "issuing":
			return "info";
		case "expiring":
		case "expiring_soon":
			return "warning";
		case "failed":
		case "expired":
		case "error":
			return "danger";
		default:
			return "neutral";
	}
};

type Access = "public" | "login" | "password";
type LoginScope = "owner" | "all_users";

const ServiceNetworking = () => {
	const ctx = useService();
	const [platform] = createResource(() => getSettings().catch(() => null));
	const [certificates, { refetch: refetchCertificates }] = createResource(ctx.id, (id) =>
		getServiceCertificates(id).catch(() => []),
	);

	const settingsService = () =>
		ctx.settings()?.service as
			| (NonNullable<ReturnType<typeof ctx.settings>>["service"] & {
					basic_auth?: { username: string } | null;
					login_gate?: { scope: LoginScope } | null;
					port_mappings?: PortMapping[];
			  })
			| undefined;
	const supportsParity = () =>
		Boolean(settingsService() && "port_mappings" in (settingsService() ?? {}));

	const [exposeHttp, setExposeHttp] = createSignal(false);
	const [port, setPort] = createSignal("");
	const [domains, setDomains] = createSignal<DomainRow[]>([]);
	const [mappings, setMappings] = createSignal<PortMapping[]>([]);
	const [access, setAccess] = createSignal<Access>("public");
	const [loginScope, setLoginScope] = createSignal<LoginScope>("owner");
	const authEnabled = () => access() === "password";
	const [authUser, setAuthUser] = createSignal("");
	const [authPassword, setAuthPassword] = createSignal("");
	const [newDomain, setNewDomain] = createSignal("");
	const [domainError, setDomainError] = createSignal<string | null>(null);
	const [saving, setSaving] = createSignal(false);
	const [reissuing, setReissuing] = createSignal(false);

	const initial = createMemo(() => {
		const current = settingsService();
		if (!current) return null;
		return {
			exposeHttp: current.expose_http,
			port: String(current.port || ""),
			domains: current.domains.map((domain) => ({
				domain,
				https: !current.http_only_domains.includes(domain),
			})),
			mappings: (current.port_mappings ?? []).map((item) => ({
				...item,
				protocol: (item.protocol ?? "tcp") as "tcp" | "udp",
			})),
			access: (current.login_gate ? "login" : current.basic_auth ? "password" : "public") as Access,
			loginScope: (current.login_gate?.scope ?? "owner") as LoginScope,
			authEnabled: Boolean(current.basic_auth),
			authUser: current.basic_auth?.username ?? "",
		};
	});

	const reset = () => {
		const value = initial();
		if (!value) return;
		setExposeHttp(value.exposeHttp);
		setPort(value.port);
		setDomains(value.domains);
		setMappings(value.mappings);
		setAccess(value.access);
		setLoginScope(value.loginScope);
		setAuthUser(value.authUser);
		setAuthPassword("");
	};
	createEffect(on(initial, reset));

	const dirty = () => {
		const value = initial();
		if (!value) return false;
		return (
			exposeHttp() !== value.exposeHttp ||
			port() !== value.port ||
			JSON.stringify(domains()) !== JSON.stringify(value.domains) ||
			JSON.stringify(mappings()) !== JSON.stringify(value.mappings) ||
			access() !== value.access ||
			(access() === "login" && loginScope() !== value.loginScope) ||
			authUser() !== value.authUser ||
			authPassword() !== ""
		);
	};

	const addDomain = () => {
		const value = newDomain().trim().toLowerCase();
		const problem = isValidDomain(value);
		if (problem) {
			setDomainError(problem);
			return;
		}
		if (domains().some((row) => row.domain === value)) {
			setDomainError("This domain is already attached");
			return;
		}
		setDomains([...domains(), { domain: value, https: true }]);
		setNewDomain("");
		setDomainError(null);
		if (!exposeHttp()) setExposeHttp(true);
	};

	const save = async () => {
		const portNumber = Number.parseInt(port(), 10);
		if (!Number.isFinite(portNumber) || portNumber < 1 || portNumber > 65535) {
			toast.error("Enter a container port between 1 and 65535");
			return;
		}
		if (authEnabled() && !authUser().trim()) {
			toast.error("Basic auth needs a username");
			return;
		}
		if (authEnabled() && !initial()?.authEnabled && !authPassword()) {
			toast.error("Set a password for basic auth");
			return;
		}
		const patch: Record<string, unknown> = {
			expose_http: exposeHttp(),
			port: portNumber,
			domains: domains().map((row) => row.domain),
			http_only_domains: domains()
				.filter((row) => !row.https)
				.map((row) => row.domain),
		};
		if (supportsParity()) {
			patch.port_mappings = mappings().filter((item) => item.host_port && item.container_port);
			patch.basic_auth = authEnabled()
				? { username: authUser().trim(), ...(authPassword() ? { password: authPassword() } : {}) }
				: null;
			patch.login_gate = access() === "login" ? { scope: loginScope() } : null;
		}
		const request = ctx.serviceRequest(patch);
		if (!request) return;
		setSaving(true);
		const ok = await ctx.save({ service: request }, "Networking saved");
		setSaving(false);
		if (ok) {
			setAuthPassword("");
			void refetchCertificates();
		}
	};

	const reissue = async () => {
		setReissuing(true);
		try {
			const result = await reissueServiceCertificate(ctx.id());
			toast.success("Certificate requested", result.message);
			setTimeout(() => void refetchCertificates(), 4000);
		} catch (error) {
			toast.error("Could not request a certificate", error);
		} finally {
			setReissuing(false);
		}
	};

	const certFor = (domain: string) => certificates()?.find((item) => item.domain === domain);
	const publicIp = () => platform()?.public_ip ?? ctx.service()?.public_ip ?? null;

	return (
		<div class="space-y-6">
			<Card title="HTTP" description="Route web traffic from the containr proxy to this service.">
				<div class="-my-4 divide-y divide-border">
					<SettingRow
						title="Public HTTP access"
						description="Serve this service on its default URL and any custom domains below."
					>
						<Switch checked={exposeHttp()} onChange={setExposeHttp} label="Public HTTP access" />
					</SettingRow>
					<SettingRow
						title="Container port"
						description="The port your app listens on inside the container. Requests are proxied to it."
					>
						<Input
							mono
							class="w-28 text-right"
							inputmode="numeric"
							value={port()}
							onInput={(event) => setPort(event.currentTarget.value)}
						/>
					</SettingRow>
					<Show when={ctx.service()?.default_urls.length}>
						<div class="py-4">
							<div class="mb-2 text-[13px] font-medium">Default URL</div>
							<For each={ctx.service()?.default_urls}>
								{(url) => (
									<div class="flex items-center gap-2 text-[13px]">
										<a
											href={url}
											target="_blank"
											rel="noreferrer"
											class="inline-flex items-center gap-1 text-fg-muted hover:text-fg"
										>
											{url}
											<ExternalLink width={12} height={12} />
										</a>
										<CopyButton value={url} />
									</div>
								)}
							</For>
						</div>
					</Show>
				</div>
			</Card>

			<Card
				title="Custom domains"
				description="HTTPS certificates are issued automatically with Let's Encrypt."
				actions={
					<Show when={domains().some((row) => row.https)}>
						<Button
							variant="secondary"
							size="sm"
							loading={reissuing()}
							onClick={() => void reissue()}
						>
							<RefreshCw />
							Reissue certificates
						</Button>
					</Show>
				}
			>
				<div class="space-y-2">
					<For each={domains()}>
						{(row) => {
							const cert = () => certFor(row.domain);
							return (
								<div class="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2.5">
									<div class="min-w-0 flex-1">
										<a
											href={`${row.https ? "https" : "http"}://${row.domain}`}
											target="_blank"
											rel="noreferrer"
											class="inline-flex items-center gap-1.5 text-[13.5px] font-medium hover:underline"
										>
											{row.domain}
											<ExternalLink width={12} height={12} class="text-fg-faint" />
										</a>
										<div class="mt-0.5 flex items-center gap-2 text-[12px] text-fg-subtle">
											<Show when={row.https} fallback="Plain HTTP, no certificate">
												<Show
													when={cert()}
													fallback="Certificate issued after you save and DNS resolves"
												>
													{(value) => (
														<>
															<Badge tone={certTone(value().status)}>
																<ShieldCheck width={11} height={11} />
																{value().status === "none"
																	? "Not issued yet"
																	: statusLabel(value().status)}
															</Badge>
															<Show when={value().expires_at}>
																<span>expires {timeAgo(value().expires_at)}</span>
															</Show>
														</>
													)}
												</Show>
											</Show>
										</div>
									</div>
									<div class="flex items-center gap-2 text-[12.5px] text-fg-muted">
										HTTPS
										<Switch
											checked={row.https}
											onChange={(value) =>
												setDomains(
													domains().map((item) =>
														item.domain === row.domain ? { ...item, https: value } : item,
													),
												)
											}
											label={`HTTPS for ${row.domain}`}
										/>
									</div>
									<button
										type="button"
										class="btn btn-ghost btn-icon btn-sm hover:text-danger!"
										aria-label={`Remove ${row.domain}`}
										onClick={() =>
											setDomains(domains().filter((item) => item.domain !== row.domain))
										}
									>
										<Trash />
									</button>
								</div>
							);
						}}
					</For>
					<div class="flex gap-2 pt-1">
						<Input
							placeholder="app.example.com"
							value={newDomain()}
							aria-invalid={Boolean(domainError())}
							onInput={(event) => {
								setNewDomain(event.currentTarget.value);
								setDomainError(null);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									addDomain();
								}
							}}
						/>
						<Button variant="secondary" onClick={addDomain} disabled={!newDomain().trim()}>
							<Plus />
							Add domain
						</Button>
					</div>
					<Show when={domainError()}>
						<p class="text-xs text-danger">{domainError()}</p>
					</Show>
				</div>
				<Notice class="mt-4" title="DNS setup">
					Point an <code>A</code> record for each domain at{" "}
					<Show when={publicIp()} fallback="this server's public IP (set it in Settings)">
						<code class="inline-flex items-center gap-1">
							{publicIp()}
							<CopyButton value={publicIp() ?? ""} />
						</code>
					</Show>
					. Wildcard records work too.
				</Notice>
			</Card>

			<Card
				title="Access"
				description="Choose who can open this service's domains. Apps with their own login can stay public."
			>
				<Show
					when={supportsParity()}
					fallback={<Notice>Update containr on this server to protect services.</Notice>}
				>
					<div class="-my-4 divide-y divide-border">
						<SettingRow title="Protection" description="Applies to every domain of this service.">
							<Segmented<Access>
								value={access()}
								onChange={setAccess}
								options={[
									{ value: "public", label: "Public" },
									{ value: "login", label: "containr login" },
									{ value: "password", label: "Password" },
								]}
							/>
						</SettingRow>
						<Show when={access() === "login"}>
							<SettingRow
								title="Who can open it"
								description="Visitors sign in with their containr account and are sent straight back."
							>
								<Select
									value={loginScope()}
									onChange={(event) => setLoginScope(event.currentTarget.value as LoginScope)}
								>
									<option value="owner">Only me</option>
									<option value="all_users">Anyone with a containr account</option>
								</Select>
							</SettingRow>
							<div class="py-4">
								<Notice>
									Best for dashboards you open in a browser, like Adminer or Grafana. Scripts,
									webhooks and API clients can't sign in, so they get a 401; use a password or keep
									the service public for those.
								</Notice>
							</div>
						</Show>
						<Show when={access() === "password"}>
							<div class="grid gap-4 py-4 sm:grid-cols-2">
								<Field label="Username">
									<Input
										value={authUser()}
										autocomplete="off"
										onInput={(event) => setAuthUser(event.currentTarget.value)}
									/>
								</Field>
								<Field
									label="Password"
									hint={
										initial()?.authEnabled ? "Leave empty to keep the current password." : undefined
									}
								>
									<PasswordInput
										value={authPassword()}
										autocomplete="new-password"
										onInput={(event) => setAuthPassword(event.currentTarget.value)}
									/>
								</Field>
							</div>
						</Show>
					</div>
				</Show>
			</Card>

			<Card
				title="Port mappings"
				description="Publish container ports directly on the server, for TCP or UDP traffic that doesn't go through the HTTP proxy."
			>
				<Show
					when={supportsParity()}
					fallback={<Notice>Update containr on this server to publish host ports.</Notice>}
				>
					<div class="space-y-2">
						<Show when={mappings().length > 0}>
							<div class="grid grid-cols-[1fr_1fr_110px_32px] gap-2 px-0.5 text-[12px] text-fg-subtle">
								<span>Server port</span>
								<span>Container port</span>
								<span>Protocol</span>
								<span />
							</div>
						</Show>
						<Index each={mappings()}>
							{(mapping, index) => (
								<div class="grid grid-cols-[1fr_1fr_110px_32px] items-center gap-2">
									<Input
										mono
										inputmode="numeric"
										placeholder="5432"
										value={mapping().host_port || ""}
										onInput={(event) =>
											setMappings(
												mappings().map((item, i) =>
													i === index
														? {
																...item,
																host_port: Number.parseInt(event.currentTarget.value, 10) || 0,
															}
														: item,
												),
											)
										}
									/>
									<Input
										mono
										inputmode="numeric"
										placeholder="5432"
										value={mapping().container_port || ""}
										onInput={(event) =>
											setMappings(
												mappings().map((item, i) =>
													i === index
														? {
																...item,
																container_port: Number.parseInt(event.currentTarget.value, 10) || 0,
															}
														: item,
												),
											)
										}
									/>
									<Select
										value={mapping().protocol ?? "tcp"}
										onChange={(event) =>
											setMappings(
												mappings().map((item, i) =>
													i === index
														? { ...item, protocol: event.currentTarget.value as "tcp" | "udp" }
														: item,
												),
											)
										}
									>
										<option value="tcp">TCP</option>
										<option value="udp">UDP</option>
									</Select>
									<button
										type="button"
										class="btn btn-ghost btn-icon hover:text-danger!"
										aria-label="Remove mapping"
										onClick={() => setMappings(mappings().filter((_, i) => i !== index))}
									>
										<Trash />
									</button>
								</div>
							)}
						</Index>
						<Button
							variant="secondary"
							size="sm"
							onClick={() =>
								setMappings([...mappings(), { host_port: 0, container_port: 0, protocol: "tcp" }])
							}
						>
							<Plus />
							Add port mapping
						</Button>
					</div>
				</Show>
			</Card>

			<Card
				title="Internal network"
				description="How other services in the same project reach this one."
			>
				<CopyField
					value={`${ctx.service()?.internal_host ?? ctx.service()?.name ?? ""}${ctx.service()?.port ? `:${ctx.service()?.port}` : ""}`}
				/>
				<p class="hint">
					Services in the same project share the <code>{ctx.service()?.network_name}</code> network.
					Services in other projects can't reach it.
				</p>
			</Card>

			<SaveBar
				dirty={dirty()}
				saving={saving()}
				onSave={() => void save()}
				onReset={reset}
				label="Unsaved networking changes"
			/>
		</div>
	);
};

export default ServiceNetworking;
