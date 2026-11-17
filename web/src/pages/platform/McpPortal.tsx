import BookOpen from "lucide-solid/icons/book-open";
import KeyRound from "lucide-solid/icons/key-round";
import Plus from "lucide-solid/icons/plus";
import Search from "lucide-solid/icons/search";
import Trash from "lucide-solid/icons/trash";
import Wrench from "lucide-solid/icons/wrench";
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { errorMessage } from "../../api/http";
import {
	type ApiToken,
	type ApiTokenScope,
	createApiToken,
	deleteApiToken,
	getMcpInfo,
	listApiTokens,
	type McpTool,
} from "../../api/platform";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Badge,
	Button,
	Card,
	CopyButton,
	CopyField,
	DescriptionList,
	EmptyState,
	Field,
	Input,
	LinkButton,
	Notice,
	PageHeader,
	Segmented,
	Select,
	Skeleton,
} from "../../components/ui";
import { confirm, Modal, toast } from "../../components/ui/overlay";
import { formatDateTime, pluralize, timeAgo } from "../../lib/format";

type Client = "claude-code" | "cursor" | "claude-desktop" | "vscode" | "curl";

const CLIENTS: Array<{ value: Client; label: string }> = [
	{ value: "claude-code", label: "Claude Code" },
	{ value: "cursor", label: "Cursor" },
	{ value: "claude-desktop", label: "Claude Desktop" },
	{ value: "vscode", label: "VS Code" },
	{ value: "curl", label: "curl" },
];

const TOKEN_PLACEHOLDER = "<your-token>";

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** connection snippet for a client; `origin` is the dashboard's url */
const snippet = (client: Client, origin: string, token: string) => {
	const url = `${origin}/mcp`;
	const auth = `Bearer ${token}`;
	switch (client) {
		case "claude-code":
			return `claude mcp add --transport http containr ${url} \\\n  --header "Authorization: ${auth}"`;
		case "cursor":
			return json({ mcpServers: { containr: { url, headers: { Authorization: auth } } } });
		case "claude-desktop":
			return json({
				mcpServers: {
					containr: {
						command: "npx",
						// mcp-remote expands the variable itself
						// biome-ignore lint/suspicious/noTemplateCurlyInString: literal for mcp-remote
						args: ["-y", "mcp-remote", url, "--header", "Authorization:${CONTAINR_AUTH}"],
						env: { CONTAINR_AUTH: auth },
					},
				},
			});
		case "vscode":
			return json({
				servers: { containr: { type: "http", url, headers: { Authorization: auth } } },
			});
		case "curl":
			return [
				"# rest api",
				`curl -H "Authorization: ${auth}" ${origin}/api/services`,
				"",
				"# mcp: list the tools",
				`curl -X POST ${url} \\`,
				`  -H "Authorization: ${auth}" \\`,
				'  -H "Content-Type: application/json" \\',
				`  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
			].join("\n");
	}
};

const SNIPPET_HINTS: Record<Client, string> = {
	"claude-code": "Run in a terminal. Add --scope user to use containr from every project.",
	cursor: "Add to ~/.cursor/mcp.json, or .cursor/mcp.json in a project.",
	"claude-desktop":
		"Add to claude_desktop_config.json. Needs Node.js; mcp-remote bridges to the http endpoint.",
	vscode: "Add to .vscode/mcp.json in your workspace.",
	curl: "Any http client works. The full rest reference is at /api/docs.",
};

const EXPIRY_OPTIONS = [
	{ value: "", label: "Never" },
	{ value: "7", label: "7 days" },
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
	{ value: "365", label: "1 year" },
];

const TAG_LABELS: Record<string, string> = {
	api: "Any endpoint",
	auth: "Account and users",
	certificates: "Certificates",
	containers: "Containers",
	"github-app": "GitHub",
	projects: "Projects",
	registries: "Registries",
	services: "Services",
	settings: "Server settings",
	storage: "Storage",
	system: "System",
};

const METHOD_TONE: Record<string, "info" | "success" | "warning" | "danger" | "neutral"> = {
	GET: "info",
	POST: "success",
	PUT: "warning",
	PATCH: "warning",
	DELETE: "danger",
};

const firstSentence = (text: string) => text.split("\n\n")[0];

const McpPortal = () => {
	useBreadcrumbs(() => [{ label: "MCP & API" }]);
	const origin = window.location.origin;
	const [info] = createResource(getMcpInfo);
	const [tokens, { refetch }] = createResource(listApiTokens);
	const [client, setClient] = createSignal<Client>("claude-code");
	const [created, setCreated] = createSignal<string | null>(null);

	const [open, setOpen] = createSignal(false);
	const [name, setName] = createSignal("");
	const [scope, setScope] = createSignal<ApiTokenScope>("full");
	const [expiry, setExpiry] = createSignal("");
	const [saving, setSaving] = createSignal(false);

	const [query, setQuery] = createSignal("");
	const [access, setAccess] = createSignal<"all" | "read" | "write">("all");

	const tools = () => info()?.tools ?? [];
	const readCount = () => tools().filter((tool) => tool.read_only).length;

	const groups = createMemo(() => {
		const needle = query().trim().toLowerCase();
		const filtered = tools().filter((tool) => {
			if (access() === "read" && !tool.read_only) return false;
			if (access() === "write" && tool.read_only) return false;
			if (!needle) return true;
			return `${tool.name} ${tool.description} ${tool.path}`.toLowerCase().includes(needle);
		});
		const byTag = new Map<string, McpTool[]>();
		for (const tool of filtered) {
			const list = byTag.get(tool.tag) ?? [];
			list.push(tool);
			byTag.set(tool.tag, list);
		}
		return [...byTag.entries()]
			.map(([tag, items]) => ({ tag, label: TAG_LABELS[tag] ?? tag, items }))
			.sort((a, b) =>
				a.tag === "api" ? 1 : b.tag === "api" ? -1 : a.label.localeCompare(b.label),
			);
	});

	const resetForm = () => {
		setName("");
		setScope("full");
		setExpiry("");
	};

	const create = async () => {
		setSaving(true);
		try {
			const result = await createApiToken(
				name().trim(),
				scope(),
				expiry() ? Number(expiry()) : null,
			);
			setCreated(result.token);
			setOpen(false);
			resetForm();
			void refetch();
		} catch (error) {
			toast.error("Could not create the token", error);
		} finally {
			setSaving(false);
		}
	};

	const revoke = async (token: ApiToken) => {
		const ok = await confirm({
			title: `Revoke ${token.name}?`,
			description:
				"Assistants and scripts using it lose access straight away. This cannot be undone.",
			confirmLabel: "Revoke token",
			danger: true,
		});
		if (!ok) return;
		try {
			await deleteApiToken(token.id);
			toast.success("Token revoked");
			void refetch();
		} catch (error) {
			toast.error("Could not revoke the token", error);
		}
	};

	const expired = (token: ApiToken) =>
		token.expires_at !== null && new Date(token.expires_at).getTime() <= Date.now();

	const code = () => snippet(client(), origin, created() ?? TOKEN_PLACEHOLDER);

	return (
		<div class="animate-fade-in">
			<PageHeader
				title="MCP & API"
				description="Connect AI assistants and scripts to containr. A token acts as your account, so an assistant can deploy, configure and inspect anything you can."
				actions={
					<>
						<LinkButton href="/api/docs" external>
							<BookOpen />
							Open API reference
						</LinkButton>
						<Button variant="primary" onClick={() => setOpen(true)}>
							<Plus />
							Create token
						</Button>
					</>
				}
			/>

			<div class="grid max-w-5xl gap-6">
				<Card
					title="MCP endpoint"
					description="Streamable HTTP transport with bearer token auth. Works with any MCP client."
				>
					<div class="space-y-4">
						<CopyField value={`${origin}/mcp`} />
						<Show when={info()} fallback={<Skeleton class="h-24" />}>
							{(data) => (
								<DescriptionList
									items={[
										{ label: "Server", value: `${data().server_name} ${data().server_version}` },
										{ label: "Protocol", value: data().protocol_version, mono: true },
										{
											label: "Tools",
											value: `${data().tools.length} (${readCount()} read-only)`,
										},
										{ label: "REST base", value: `${origin}/api`, mono: true },
									]}
								/>
							)}
						</Show>
					</div>
				</Card>

				<Card
					title="Connect a client"
					description="Create a token, then paste this into your client's config."
				>
					<div class="space-y-3">
						<Segmented value={client()} options={CLIENTS} onChange={setClient} />
						<Show when={created()}>
							<Notice tone="warning" title="Copy your new token now">
								It is filled in below and won't be shown again. Store it like a password.
							</Notice>
						</Show>
						<div class="relative">
							<pre class="overflow-x-auto rounded-md border border-border bg-surface-2 px-3 py-2.5 pr-10 font-mono text-[12px] text-fg">
								{code()}
							</pre>
							<CopyButton value={code()} class="absolute top-2 right-2" label="Copy snippet" />
						</div>
						<p class="hint">{SNIPPET_HINTS[client()]}</p>
					</div>
				</Card>

				<Card
					title="API tokens"
					description="Tokens work for the MCP endpoint and the REST API. Read-only tokens can only call GET endpoints and read-only tools."
					flush
				>
					<Switch>
						<Match when={tokens.loading && !tokens()}>
							<div class="p-4">
								<Skeleton class="h-12" />
							</div>
						</Match>
						<Match when={tokens.error}>
							<div class="p-4">
								<Notice tone="danger">{errorMessage(tokens.error)}</Notice>
							</div>
						</Match>
						<Match when={!tokens()?.length}>
							<div class="p-4">
								<EmptyState
									icon={<KeyRound />}
									title="No tokens yet"
									description="Create one for each assistant or script, so you can revoke them one at a time."
								>
									<Button variant="primary" size="sm" onClick={() => setOpen(true)}>
										<Plus />
										Create token
									</Button>
								</EmptyState>
							</div>
						</Match>
						<Match when={true}>
							<ul class="divide-y divide-border">
								<For each={tokens()}>
									{(token) => (
										<li class="flex items-center gap-3 px-4 py-3">
											<span class="flex h-8 w-8 items-center justify-center rounded-md bg-surface-2 text-fg-subtle">
												<KeyRound width={15} height={15} />
											</span>
											<div class="min-w-0 flex-1">
												<div class="flex items-center gap-2">
													<span class="truncate text-[13px] font-medium">{token.name}</span>
													<Badge tone={token.scope === "full" ? "accent" : "neutral"}>
														{token.scope === "full" ? "Full access" : "Read-only"}
													</Badge>
													<Show when={expired(token)}>
														<Badge tone="danger">Expired</Badge>
													</Show>
												</div>
												<div class="truncate text-[12px] text-fg-subtle">
													<span class="font-mono">{token.prefix}…</span> · created{" "}
													{timeAgo(token.created_at)} ·{" "}
													{token.last_used_at
														? `used ${timeAgo(token.last_used_at)}`
														: "never used"}
													<Show when={token.expires_at && !expired(token)}>
														{" "}
														· expires {formatDateTime(token.expires_at)}
													</Show>
												</div>
											</div>
											<button
												type="button"
												class="btn btn-ghost btn-icon btn-sm hover:text-danger!"
												aria-label={`Revoke ${token.name}`}
												title="Revoke token"
												onClick={() => void revoke(token)}
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

				<Card
					title="Tools"
					description="Generated from the REST API, so new endpoints show up here automatically. api_request reaches anything without a dedicated tool."
					flush
				>
					<div class="flex flex-wrap items-center gap-2 border-b border-border p-3">
						<div class="relative min-w-48 flex-1">
							<Search
								width={14}
								height={14}
								class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle"
							/>
							<Input
								class="pl-8"
								placeholder="Search tools"
								value={query()}
								onInput={(event) => setQuery(event.currentTarget.value)}
							/>
						</div>
						<Segmented
							value={access()}
							onChange={setAccess}
							options={[
								{ value: "all", label: "All" },
								{ value: "read", label: "Read" },
								{ value: "write", label: "Write" },
							]}
						/>
					</div>
					<Switch>
						<Match when={info.loading && !info()}>
							<div class="p-4">
								<Skeleton class="h-40" />
							</div>
						</Match>
						<Match when={info.error}>
							<div class="p-4">
								<Notice tone="danger">{errorMessage(info.error)}</Notice>
							</div>
						</Match>
						<Match when={!groups().length}>
							<div class="p-4">
								<EmptyState icon={<Wrench />} title="No matching tools" />
							</div>
						</Match>
						<Match when={true}>
							<For each={groups()}>
								{(group) => (
									<section>
										<h3 class="border-b border-border bg-surface-2 px-4 py-1.5 text-[12px] font-medium text-fg-subtle">
											{group.label} · {pluralize(group.items.length, "tool")}
										</h3>
										<ul class="divide-y divide-border">
											<For each={group.items}>
												{(tool) => (
													<li class="flex items-start gap-3 px-4 py-2.5">
														<div class="min-w-0 flex-1">
															<div class="flex flex-wrap items-center gap-2">
																<code class="text-[12.5px] font-medium">{tool.name}</code>
																<Show when={tool.read_only}>
																	<Badge tone="neutral">Read-only</Badge>
																</Show>
																<Show when={tool.destructive}>
																	<Badge tone="warning">Destructive</Badge>
																</Show>
															</div>
															<p class="mt-0.5 text-[12.5px] text-fg-subtle">
																{firstSentence(tool.description)}
															</p>
														</div>
														<Show when={tool.tag !== "api"}>
															<div class="hidden shrink-0 items-center gap-1.5 sm:flex">
																<Badge tone={METHOD_TONE[tool.method] ?? "neutral"}>
																	{tool.method}
																</Badge>
																<code class="max-w-64 truncate text-[11.5px] text-fg-faint">
																	{tool.path}
																</code>
															</div>
														</Show>
													</li>
												)}
											</For>
										</ul>
									</section>
								)}
							</For>
						</Match>
					</Switch>
				</Card>
			</div>

			<Modal
				open={open()}
				onClose={() => setOpen(false)}
				title="Create API token"
				footer={
					<>
						<Button variant="secondary" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							variant="primary"
							loading={saving()}
							disabled={!name().trim()}
							onClick={() => void create()}
						>
							Create token
						</Button>
					</>
				}
			>
				<div class="space-y-4">
					<Field label="Name" hint="Where it will be used, e.g. Claude Code on my laptop.">
						<Input
							autofocus
							maxLength={64}
							placeholder="Claude Code"
							value={name()}
							onInput={(event) => setName(event.currentTarget.value)}
						/>
					</Field>
					<Field
						label="Access"
						hint={
							scope() === "full"
								? "Can do anything your account can, including deleting services."
								: "Can list and inspect, but not change anything."
						}
					>
						<Segmented
							value={scope()}
							onChange={setScope}
							options={[
								{ value: "full", label: "Full access" },
								{ value: "read", label: "Read-only" },
							]}
						/>
					</Field>
					<Field label="Expires">
						<Select value={expiry()} onChange={(event) => setExpiry(event.currentTarget.value)}>
							<For each={EXPIRY_OPTIONS}>
								{(option) => <option value={option.value}>{option.label}</option>}
							</For>
						</Select>
					</Field>
					<Notice tone="info">Tokens can't create other tokens or change your password.</Notice>
				</div>
			</Modal>
		</div>
	);
};

export default McpPortal;
