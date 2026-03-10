import { A, useNavigate } from "@solidjs/router";
import {
	Component,
	createMemo,
	createResource,
	createSignal,
	For,
	Match,
	Show,
	Switch,
} from "solid-js";

import { api, type components } from "../api";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
	EmptyState,
	PageHeader,
} from "../components/ui";

type Database = components["schemas"]["DatabaseResponse"];

type Feedback = {
	text: string;
	variant: "default" | "destructive" | "success";
};

const fetchDatabases = async (): Promise<Database[]> => {
	const { data, error } = await api.GET("/api/databases");
	if (error) {
		throw error;
	}
	return data ?? [];
};

const describeError = (error: unknown) => {
	if (error instanceof Error) {
		return error.message;
	}

	if (
		typeof error === "object" &&
		error !== null &&
		"error" in error &&
		typeof error.error === "string"
	) {
		return error.error;
	}

	return "request failed";
};

const databaseTypeLabel = (database: Database) => {
	switch (database.db_type) {
		case "postgres":
			return "containr postgres";
		case "mariadb":
			return "containr mariadb";
		case "redis":
			return "containr valkey";
		case "qdrant":
			return "containr qdrant";
		default:
			return database.db_type;
	}
};

const statusVariant = (status: string) => {
	switch (status) {
		case "running":
			return "success";
		case "starting":
			return "warning";
		case "failed":
			return "error";
		default:
			return "secondary";
	}
};

const resolveExternalTarget = (port?: number | null) => {
	if (!port) {
		return "not exposed";
	}

	const host =
		typeof window === "undefined" ? "localhost" : window.location.hostname;
	return `${host}:${port}`;
};

const quickCreateOptions = [
	{
		title: "postgres",
		description: "transactional data with pitr and pgdog support",
		type: "postgresql",
	},
	{
		title: "valkey",
		description: "redis-compatible caching with managed credentials",
		type: "redis",
	},
	{
		title: "mariadb",
		description: "mysql-compatible relational storage",
		type: "mariadb",
	},
	{
		title: "qdrant",
		description: "vector search with optional public api exposure",
		type: "qdrant",
	},
] as const;

const Databases: Component = () => {
	const navigate = useNavigate();
	const [databases, { refetch }] = createResource(fetchDatabases);
	const [copiedId, setCopiedId] = createSignal<string | null>(null);
	const [activeAction, setActiveAction] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<Feedback | null>(null);

	const databaseList = createMemo(() => databases() ?? []);

	const stats = createMemo(() => {
		const items = databaseList();
		return {
			total: items.length,
			running: items.filter((item) => item.status === "running").length,
			exposed: items.filter((item) => item.external_port !== null).length,
			groups: new Set(
				items
					.map((item) => item.group_id)
					.filter((groupId): groupId is string => Boolean(groupId)),
			).size,
		};
	});

	const createUrl = (type = "postgresql") =>
		`/projects/new?kind=database&type=${type}`;

	const actionKey = (id: string, action: string) => `${id}:${action}`;

	const runAction = async (
		id: string,
		action: string,
		request: () => Promise<void>,
		successMessage: string,
	) => {
		setActiveAction(actionKey(id, action));
		setFeedback(null);

		try {
			await request();
			await refetch();
			setFeedback({
				text: successMessage,
				variant: "success",
			});
		} catch (error) {
			setFeedback({
				text: describeError(error),
				variant: "destructive",
			});
		} finally {
			setActiveAction(null);
		}
	};

	const handleDelete = async (database: Database) => {
		const confirmed = window.confirm(
			`delete ${database.name}? data will be lost.`,
		);
		if (!confirmed) {
			return;
		}

		await runAction(
			database.id,
			"delete",
			async () => {
				const { error } = await api.DELETE("/api/databases/{id}", {
					params: { path: { id: database.id } },
				});
				if (error) {
					throw error;
				}
			},
			`${database.name} deleted`,
		);
	};

	const handleStart = async (database: Database) => {
		await runAction(
			database.id,
			"start",
			async () => {
				const { error } = await api.POST("/api/databases/{id}/start", {
					params: { path: { id: database.id } },
				});
				if (error) {
					throw error;
				}
			},
			`${database.name} started`,
		);
	};

	const handleStop = async (database: Database) => {
		await runAction(
			database.id,
			"stop",
			async () => {
				const { error } = await api.POST("/api/databases/{id}/stop", {
					params: { path: { id: database.id } },
				});
				if (error) {
					throw error;
				}
			},
			`${database.name} stopped`,
		);
	};

	const handleRestart = async (database: Database) => {
		await runAction(
			database.id,
			"restart",
			async () => {
				const { error } = await api.POST("/api/databases/{id}/restart", {
					params: { path: { id: database.id } },
				});
				if (error) {
					throw error;
				}
			},
			`${database.name} restarted`,
		);
	};

	const copyToClipboard = async (database: Database) => {
		try {
			await navigator.clipboard.writeText(database.connection_string);
			setCopiedId(database.id);
			setFeedback({
				text: `${database.name} connection string copied`,
				variant: "success",
			});
			window.setTimeout(() => {
				setCopiedId((current) => (current === database.id ? null : current));
			}, 2000);
		} catch (error) {
			setFeedback({
				text: describeError(error),
				variant: "destructive",
			});
		}
	};

	return (
		<div class="space-y-8">
			<PageHeader
				eyebrow="managed services"
				title="databases"
				description={
					"managed postgres, mariadb, valkey, and qdrant services " +
					"with direct visibility into status, access, and grouping"
				}
				actions={
					<Button onClick={() => navigate(createUrl())}>new database</Button>
				}
			/>

			<div class="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
				<Card>
					<CardHeader>
						<CardTitle>quick create</CardTitle>
						<CardDescription>
							start from the service type you want instead of digging through
							forms
						</CardDescription>
					</CardHeader>
					<CardContent class="grid gap-3 md:grid-cols-2">
						<For each={quickCreateOptions}>
							{(option) => (
								<button
									type="button"
									class="border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-4 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--card)]"
									onClick={() => navigate(createUrl(option.type))}
								>
									<p class="text-[11px] uppercase tracking-[0.22em] text-[var(--muted-foreground)]">
										{option.title}
									</p>
									<p class="mt-2 font-serif text-lg text-[var(--foreground)]">
										{option.title}
									</p>
									<p class="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
										{option.description}
									</p>
								</button>
							)}
						</For>
					</CardContent>
				</Card>

				<div class="grid gap-4 sm:grid-cols-2">
					<Card>
						<CardHeader class="pb-3">
							<CardDescription>inventory</CardDescription>
							<CardTitle class="text-3xl">{stats().total}</CardTitle>
						</CardHeader>
						<CardContent class="pt-0 text-sm text-[var(--muted-foreground)]">
							total managed databases
						</CardContent>
					</Card>
					<Card>
						<CardHeader class="pb-3">
							<CardDescription>healthy</CardDescription>
							<CardTitle class="text-3xl">{stats().running}</CardTitle>
						</CardHeader>
						<CardContent class="pt-0 text-sm text-[var(--muted-foreground)]">
							currently running
						</CardContent>
					</Card>
					<Card>
						<CardHeader class="pb-3">
							<CardDescription>public</CardDescription>
							<CardTitle class="text-3xl">{stats().exposed}</CardTitle>
						</CardHeader>
						<CardContent class="pt-0 text-sm text-[var(--muted-foreground)]">
							exposed over direct ports
						</CardContent>
					</Card>
					<Card>
						<CardHeader class="pb-3">
							<CardDescription>groups</CardDescription>
							<CardTitle class="text-3xl">{stats().groups}</CardTitle>
						</CardHeader>
						<CardContent class="pt-0 text-sm text-[var(--muted-foreground)]">
							network boundaries in use
						</CardContent>
					</Card>
				</div>
			</div>

			<Show when={feedback()}>
				{(currentFeedback) => (
					<Alert variant={currentFeedback().variant}>
						{currentFeedback().text}
					</Alert>
				)}
			</Show>

			<Switch>
				<Match when={databases.loading}>
					<div class="grid gap-4 xl:grid-cols-2">
						<For each={[0, 1, 2, 3]}>
							{() => (
								<Card class="animate-pulse">
									<CardHeader>
										<div class="h-4 w-32 bg-[var(--muted)]" />
										<div class="h-8 w-48 bg-[var(--muted)]" />
									</CardHeader>
									<CardContent>
										<div class="h-20 bg-[var(--muted)]" />
									</CardContent>
								</Card>
							)}
						</For>
					</div>
				</Match>

				<Match when={!databases.loading && databaseList().length === 0}>
					<EmptyState
						title="no databases yet"
						description={
							"create postgres, valkey, mariadb, or qdrant directly " +
							"from the service flow and they will show up here"
						}
						action={
							<Button onClick={() => navigate(createUrl())}>
								create database
							</Button>
						}
					/>
				</Match>

				<Match when={!databases.loading && databaseList().length > 0}>
					<div class="grid gap-4 xl:grid-cols-2">
						<For each={databaseList()}>
							{(database) => (
								<Card>
									<CardHeader class="gap-4 border-b-0 pb-0">
										<div class="flex flex-wrap items-start justify-between gap-4">
											<div class="space-y-3">
												<div class="flex flex-wrap items-center gap-2">
													<Badge variant={statusVariant(database.status)}>
														{database.status}
													</Badge>
													<Badge variant="outline">
														{databaseTypeLabel(database)}
													</Badge>
													<Show when={database.group_id}>
														<Badge variant="secondary">group attached</Badge>
													</Show>
													<Show when={database.external_port !== null}>
														<Badge variant="secondary">public port</Badge>
													</Show>
												</div>
												<div>
													<CardTitle class="text-2xl">
														<A
															href={`/databases/${database.id}`}
															class="transition-colors hover:text-[var(--muted-foreground)]"
														>
															{database.name}
														</A>
													</CardTitle>
													<CardDescription class="mt-2">
														{database.internal_host}:{database.port}
													</CardDescription>
												</div>
											</div>

											<div class="text-right text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
												version {database.version}
											</div>
										</div>
									</CardHeader>

									<CardContent class="grid gap-4 md:grid-cols-3">
										<div class="space-y-2">
											<p class="text-[11px] uppercase tracking-[0.22em] text-[var(--muted-foreground)]">
												routing
											</p>
											<p class="font-mono text-sm text-[var(--foreground)]">
												{database.internal_host}:{database.port}
											</p>
											<p class="text-sm text-[var(--muted-foreground)]">
												public: {resolveExternalTarget(database.external_port)}
											</p>
											<Show when={database.proxy_enabled}>
												<p class="text-sm text-[var(--muted-foreground)]">
													pgdog:{" "}
													{resolveExternalTarget(database.proxy_external_port)}
												</p>
											</Show>
										</div>

										<div class="space-y-2">
											<p class="text-[11px] uppercase tracking-[0.22em] text-[var(--muted-foreground)]">
												credentials
											</p>
											<p class="text-sm text-[var(--foreground)]">
												user {database.username}
											</p>
											<p class="text-sm text-[var(--muted-foreground)]">
												db {database.database_name}
											</p>
											<p class="text-sm text-[var(--muted-foreground)]">
												network {database.network_name}
											</p>
										</div>

										<div class="space-y-2">
											<p class="text-[11px] uppercase tracking-[0.22em] text-[var(--muted-foreground)]">
												resources
											</p>
											<p class="text-sm text-[var(--foreground)]">
												{database.memory_limit_mb} mb memory
											</p>
											<p class="text-sm text-[var(--muted-foreground)]">
												{database.cpu_limit} cpu
											</p>
											<Show when={database.pitr_enabled}>
												<p class="text-sm text-[var(--muted-foreground)]">
													pitr enabled
												</p>
											</Show>
										</div>
									</CardContent>

									<CardFooter class="flex flex-wrap gap-3">
										<Button
											variant="secondary"
											onClick={() => void copyToClipboard(database)}
										>
											{copiedId() === database.id ? "copied" : "copy url"}
										</Button>
										<Button
											variant="outline"
											isLoading={
												activeAction() === actionKey(database.id, "restart")
											}
											onClick={() => void handleRestart(database)}
											disabled={database.status !== "running"}
										>
											restart
										</Button>
										<Show
											when={database.status === "running"}
											fallback={
												<Button
													variant="outline"
													isLoading={
														activeAction() === actionKey(database.id, "start")
													}
													onClick={() => void handleStart(database)}
													disabled={database.status === "starting"}
												>
													start
												</Button>
											}
										>
											<Button
												variant="outline"
												isLoading={
													activeAction() === actionKey(database.id, "stop")
												}
												onClick={() => void handleStop(database)}
											>
												stop
											</Button>
										</Show>
										<Button
											variant="danger"
											isLoading={
												activeAction() === actionKey(database.id, "delete")
											}
											onClick={() => void handleDelete(database)}
										>
											delete
										</Button>
									</CardFooter>
								</Card>
							)}
						</For>
					</div>
				</Match>
			</Switch>
		</div>
	);
};

export default Databases;
