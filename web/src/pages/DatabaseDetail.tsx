import { A, useParams } from "@solidjs/router";
import {
	type Component,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	Show,
} from "solid-js";
import type { components } from "../api";
import { api } from "../api";
import ContainerMonitor from "../components/ContainerMonitor";

type DatabaseResponse = components["schemas"]["DatabaseResponse"];
type ContainerListItem = components["schemas"]["ContainerListItem"];
type BackupInfo = components["schemas"]["BackupInfo"];
type Bucket = components["schemas"]["BucketResponse"];
type ExportResponse = components["schemas"]["ExportResponse"];
type BaseBackupResponse = components["schemas"]["BaseBackupResponse"];
type RestorePointResponse = components["schemas"]["RestorePointResponse"];
type RecoverDatabaseResponse = components["schemas"]["RecoverDatabaseResponse"];
type DatabaseTab = "overview" | "connect" | "access" | "recovery" | "backups" | "container";

const primaryButtonClass =
	"border border-black bg-black px-4 py-2 text-sm text-white hover:bg-neutral-800 " +
	"disabled:opacity-50";
const secondaryButtonClass =
	"border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 " +
	"hover:border-neutral-400 hover:text-black disabled:opacity-50";
const subtleButtonClass =
	"border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-600 " +
	"hover:border-neutral-400 hover:text-black disabled:opacity-50";

const fetchDatabase = async (id: string): Promise<DatabaseResponse> => {
	const { data, error } = await api.GET("/api/databases/{id}", {
		params: { path: { id } },
	});
	if (error) throw error;
	return data;
};

const fetchContainers = async (): Promise<ContainerListItem[]> => {
	const { data, error } = await api.GET("/api/containers");
	if (error) throw error;
	return data ?? [];
};

const fetchBuckets = async (): Promise<Bucket[]> => {
	const { data, error } = await api.GET("/api/buckets");
	if (error) throw error;
	return data ?? [];
};

const fetchBackups = async (id: string): Promise<BackupInfo[]> => {
	const { data, error } = await api.GET("/api/databases/{id}/backups", {
		params: { path: { id } },
	});
	if (error) throw error;
	return data ?? [];
};

const startDatabase = async (id: string): Promise<DatabaseResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/start", {
		params: { path: { id } },
	});
	if (error) throw error;
	return data;
};

const stopDatabase = async (id: string): Promise<DatabaseResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/stop", {
		params: { path: { id } },
	});
	if (error) throw error;
	return data;
};

const restartDatabase = async (id: string): Promise<DatabaseResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/restart", {
		params: { path: { id } },
	});
	if (error) throw error;
	return data;
};

const toggleExternalAccess = async (
	id: string,
	enabled: boolean,
	externalPort?: number,
): Promise<DatabaseResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/expose", {
		params: { path: { id } },
		body: { enabled, external_port: externalPort },
	});
	if (error) throw error;
	return data;
};

const togglePitr = async (id: string, enabled: boolean): Promise<DatabaseResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/pitr", {
		params: { path: { id } },
		body: { enabled },
	});
	if (error) throw error;
	return data;
};

const toggleProxy = async (
	id: string,
	enabled: boolean,
	externalPort?: number,
): Promise<DatabaseResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/proxy", {
		params: { path: { id } },
		body: { enabled, external_port: externalPort },
	});
	if (error) throw error;
	return data;
};

const createPitrBaseBackup = async (id: string, label?: string): Promise<BaseBackupResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/pitr/base-backup", {
		params: { path: { id } },
		body: { label },
	});
	if (error) throw error;
	return data;
};

const createDatabaseRestorePoint = async (
	id: string,
	restorePoint?: string,
): Promise<RestorePointResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/pitr/restore-point", {
		params: { path: { id } },
		body: { restore_point: restorePoint },
	});
	if (error) throw error;
	return data;
};

const recoverDatabase = async (
	id: string,
	options: { restorePoint?: string; targetTime?: string },
): Promise<RecoverDatabaseResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/pitr/recover", {
		params: { path: { id } },
		body: {
			restore_point: options.restorePoint,
			target_time: options.targetTime,
		},
	});
	if (error) throw error;
	return data;
};

const createBackup = async (
	id: string,
	options?: { bucketId?: string; objectKeyPrefix?: string },
): Promise<ExportResponse> => {
	const { data, error } = await api.POST("/api/databases/{id}/export", {
		params: { path: { id } },
		body: {
			bucket_id: options?.bucketId,
			object_key_prefix: options?.objectKeyPrefix,
		},
	});
	if (error) throw error;
	return data;
};

const downloadBackup = async (id: string, filename: string) => {
	const token = localStorage.getItem("containr_token");
	if (!token) {
		throw new Error("missing auth token");
	}

	const response = await fetch(
		`/api/databases/${id}/backups/download?filename=${encodeURIComponent(filename)}`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
			},
		},
	);

	if (!response.ok) {
		throw new Error("failed to download backup");
	}

	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
};

const formatBytes = (bytes: number) => {
	if (!bytes) return "0 B";

	const units = ["B", "KB", "MB", "GB"];
	const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);

	return `${(bytes / 1024 ** idx).toFixed(1)} ${units[idx]}`;
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

const formatLocalDateTimeInput = (value?: string | null) => {
	if (!value) return "";

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "";
	}

	const pad = (input: number) => input.toString().padStart(2, "0");
	return (
		[date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-") +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}`
	);
};

const formatDateTime = (value?: string | null) => {
	if (!value) return "not available";

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "not available";
	}

	return date.toLocaleString();
};

const toTargetTimestamp = (value: string) => {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error("target time must be a valid date");
	}

	return parsed.toISOString();
};

const maskSecret = (value?: string | null) => {
	if (!value) return "not available";
	return "*".repeat(Math.max(12, Math.min(value.length, 28)));
};

const statusBadgeClass = (status?: string) => {
	switch (status) {
		case "running":
			return "border border-emerald-700 bg-emerald-950 text-emerald-300";
		case "starting":
			return "border border-amber-700 bg-amber-950 text-amber-300";
		case "failed":
			return "border border-red-700 bg-red-950 text-red-300";
		case "stopped":
			return "border border-neutral-700 bg-neutral-900 text-neutral-300";
		default:
			return "border border-neutral-700 bg-neutral-900 text-neutral-300";
	}
};

const statusDotClass = (status?: string) => {
	switch (status) {
		case "running":
			return "bg-emerald-400";
		case "starting":
			return "bg-amber-400 animate-pulse";
		case "failed":
			return "bg-red-400";
		case "stopped":
			return "bg-neutral-500";
		default:
			return "bg-neutral-500";
	}
};

const DatabaseDetail: Component = () => {
	const params = useParams();
	const [database, { refetch }] = createResource(() => params.id, fetchDatabase);
	const [containers] = createResource(fetchContainers);
	const [backups, { refetch: refetchBackups }] = createResource(() => params.id, fetchBackups);
	const [buckets] = createResource(fetchBuckets);
	const [selectedContainer, setSelectedContainer] = createSignal("");
	const [activeTab, setActiveTab] = createSignal<DatabaseTab>("overview");
	const [visibleSecrets, setVisibleSecrets] = createSignal<Record<string, boolean>>({});
	const [copiedField, setCopiedField] = createSignal("");
	const [powerAction, setPowerAction] = createSignal<"" | "start" | "stop" | "restart">("");
	const [serviceMessage, setServiceMessage] = createSignal("");
	const [exposing, setExposing] = createSignal(false);
	const [togglingPitr, setTogglingPitr] = createSignal(false);
	const [togglingProxy, setTogglingProxy] = createSignal(false);
	const [creatingBackup, setCreatingBackup] = createSignal(false);
	const [uploadingBackup, setUploadingBackup] = createSignal(false);
	const [creatingBaseBackup, setCreatingBaseBackup] = createSignal(false);
	const [creatingRestorePoint, setCreatingRestorePoint] = createSignal(false);
	const [recoveringDatabase, setRecoveringDatabase] = createSignal(false);
	const [externalPort, setExternalPort] = createSignal("");
	const [proxyExternalPort, setProxyExternalPort] = createSignal("");
	const [selectedBucketId, setSelectedBucketId] = createSignal("");
	const [bucketPrefix, setBucketPrefix] = createSignal("");
	const [accessMessage, setAccessMessage] = createSignal("");
	const [backupMessage, setBackupMessage] = createSignal("");
	const [proxyMessage, setProxyMessage] = createSignal("");
	const [pitrMessage, setPitrMessage] = createSignal("");
	const [baseBackupLabel, setBaseBackupLabel] = createSignal("");
	const [restorePointName, setRestorePointName] = createSignal("");
	const [recoveryRestorePoint, setRecoveryRestorePoint] = createSignal("");
	const [recoveryTargetTime, setRecoveryTargetTime] = createSignal("");

	const dbContainers = createMemo(() =>
		(containers() || []).filter(
			(item) => item.resource_type === "database" && item.resource_id === params.id,
		),
	);

	const isPostgres = createMemo(() => database()?.db_type === "postgresql");

	const tabs = createMemo(() => {
		const nextTabs: Array<{ id: DatabaseTab; label: string }> = [
			{ id: "overview", label: "overview" },
			{ id: "connect", label: "connect" },
			{ id: "access", label: "access" },
		];

		if (isPostgres()) {
			nextTabs.push({ id: "recovery", label: "recovery" });
		}

		nextTabs.push({ id: "backups", label: "backups" }, { id: "container", label: "container" });

		return nextTabs;
	});

	const directTarget = createMemo(() => {
		const db = database();
		return db ? `${db.internal_host}:${db.port}` : "";
	});

	const proxyInternalTarget = createMemo(() => {
		const db = database();
		if (!db?.proxy_port) return "";
		return `${db.internal_host}-proxy:${db.proxy_port}`;
	});

	const powerButtonLabel = createMemo(() => {
		if (powerAction() === "start") return "starting...";
		if (powerAction() === "stop") return "stopping...";
		if (powerAction() === "restart") return "restarting...";

		const status = database()?.status;
		if (status === "running") return "stop database";
		if (status === "failed") return "retry start";
		return "start database";
	});

	createEffect(() => {
		const nextContainer = dbContainers()[0]?.id ?? "";
		const currentContainer = selectedContainer();
		const hasCurrentContainer = dbContainers().some(
			(container) => container.id === currentContainer,
		);

		if (!currentContainer || !hasCurrentContainer) {
			setSelectedContainer(nextContainer);
		}
	});

	createEffect(() => {
		const port = database()?.external_port;
		setExternalPort(port ? String(port) : "");
	});

	createEffect(() => {
		const port = database()?.proxy_external_port;
		setProxyExternalPort(port ? String(port) : "");
	});

	createEffect(() => {
		const latestBackup = database()?.pitr_last_base_backup_at;
		if (!recoveryTargetTime() && latestBackup) {
			setRecoveryTargetTime(formatLocalDateTimeInput(latestBackup));
		}
	});

	createEffect(() => {
		if (!selectedBucketId() && buckets() && buckets()!.length > 0) {
			setSelectedBucketId(buckets()![0].id);
		}
	});

	createEffect(() => {
		params.id;
		setActiveTab("overview");
		setVisibleSecrets({});
		setCopiedField("");
		setServiceMessage("");
		setAccessMessage("");
		setBackupMessage("");
		setProxyMessage("");
		setPitrMessage("");
	});

	createEffect(() => {
		if (!isPostgres() && activeTab() === "recovery") {
			setActiveTab("overview");
		}
	});

	const isSecretVisible = (key: string) => Boolean(visibleSecrets()[key]);

	const toggleSecret = (key: string) => {
		setVisibleSecrets((current) => ({
			...current,
			[key]: !current[key],
		}));
	};

	const secretText = (key: string, value?: string | null) => {
		if (isSecretVisible(key)) {
			return value || "not available";
		}
		return maskSecret(value);
	};

	const copyLabel = (key: string) => (copiedField() === key ? "copied" : "copy");

	const copyToClipboard = async (key: string, text?: string | null) => {
		if (!text) return;

		try {
			await navigator.clipboard.writeText(text);
			setCopiedField(key);
			window.setTimeout(() => {
				setCopiedField((current) => (current === key ? "" : current));
			}, 2000);
		} catch (error) {
			setServiceMessage(describeError(error));
		}
	};

	const externalTarget = (port?: number | null) => {
		if (!port) return "";
		const host = typeof window === "undefined" ? "localhost" : window.location.hostname;
		return `${host}:${port}`;
	};

	const handlePowerAction = async () => {
		const db = database();
		if (!db || db.status === "starting") return;

		const nextAction = db.status === "running" ? "stop" : "start";
		setPowerAction(nextAction);
		setServiceMessage("");

		try {
			if (nextAction === "start") {
				await startDatabase(db.id);
			} else {
				await stopDatabase(db.id);
			}

			await refetch();
		} catch (error) {
			setServiceMessage(describeError(error));
		} finally {
			setPowerAction("");
		}
	};

	const handleRestart = async () => {
		const db = database();
		if (!db || db.status !== "running" || powerAction() !== "") return;

		setPowerAction("restart");
		setServiceMessage("");

		try {
			await restartDatabase(db.id);
			await refetch();
		} catch (error) {
			setServiceMessage(describeError(error));
		} finally {
			setPowerAction("");
		}
	};

	const handleRefresh = async () => {
		setServiceMessage("");

		try {
			await Promise.all([refetch(), refetchBackups()]);
		} catch (error) {
			setServiceMessage(describeError(error));
		}
	};

	const handleToggleExpose = async () => {
		const db = database();
		if (!db) return;

		setExposing(true);
		setAccessMessage("");

		try {
			const shouldEnable = db.external_port === null;
			const requestedPort = externalPort().trim();
			await toggleExternalAccess(
				db.id,
				shouldEnable,
				shouldEnable && requestedPort ? Number(requestedPort) : undefined,
			);
			setAccessMessage(shouldEnable ? "external access enabled" : "external access disabled");
			await refetch();
		} catch (error) {
			setAccessMessage(describeError(error));
		} finally {
			setExposing(false);
		}
	};

	const handleTogglePitr = async () => {
		const db = database();
		if (!db || !isPostgres()) return;

		setTogglingPitr(true);
		try {
			await togglePitr(db.id, !db.pitr_enabled);
			setPitrMessage(
				!db.pitr_enabled ? "point in time recovery enabled" : "point in time recovery disabled",
			);
			await refetch();
		} catch (error) {
			setPitrMessage(describeError(error));
		} finally {
			setTogglingPitr(false);
		}
	};

	const handleToggleProxy = async () => {
		const db = database();
		if (!db || !isPostgres()) return;

		setTogglingProxy(true);
		try {
			const shouldEnable = !db.proxy_enabled;
			const requestedPort = proxyExternalPort().trim();
			await toggleProxy(
				db.id,
				shouldEnable,
				shouldEnable && requestedPort ? Number(requestedPort) : undefined,
			);
			setProxyMessage(shouldEnable ? "pgdog proxy enabled" : "pgdog proxy disabled");
			await refetch();
		} catch (error) {
			setProxyMessage(describeError(error));
		} finally {
			setTogglingProxy(false);
		}
	};

	const handleCreateBackup = async () => {
		const db = database();
		if (!db) return;

		setCreatingBackup(true);
		try {
			const response = await createBackup(db.id);
			setBackupMessage(`local backup created: ${response.backup_path}`);
			await refetchBackups();
		} catch (error) {
			setBackupMessage(describeError(error));
		} finally {
			setCreatingBackup(false);
		}
	};

	const handleBackupToBucket = async () => {
		const db = database();
		if (!db || !selectedBucketId()) return;

		setUploadingBackup(true);
		try {
			const response = await createBackup(db.id, {
				bucketId: selectedBucketId(),
				objectKeyPrefix: bucketPrefix().trim() || undefined,
			});
			setBackupMessage(
				response.object_key
					? `uploaded to ${response.bucket_name}/${response.object_key}`
					: "backup uploaded",
			);
			await refetchBackups();
		} catch (error) {
			setBackupMessage(describeError(error));
		} finally {
			setUploadingBackup(false);
		}
	};

	const handleCreateBaseBackup = async () => {
		const db = database();
		if (!db || !isPostgres()) return;

		setCreatingBaseBackup(true);
		try {
			const response = await createPitrBaseBackup(db.id, baseBackupLabel().trim() || undefined);
			setPitrMessage(`base backup created: ${response.label}`);
			setBaseBackupLabel("");
			await refetch();
		} catch (error) {
			setPitrMessage(describeError(error));
		} finally {
			setCreatingBaseBackup(false);
		}
	};

	const handleCreateRestorePoint = async () => {
		const db = database();
		if (!db || !isPostgres()) return;

		setCreatingRestorePoint(true);
		try {
			const response = await createDatabaseRestorePoint(
				db.id,
				restorePointName().trim() || undefined,
			);
			setPitrMessage(`restore point created: ${response.restore_point}`);
			setRestorePointName(response.restore_point);
			setRecoveryRestorePoint(response.restore_point);
			await refetch();
		} catch (error) {
			setPitrMessage(describeError(error));
		} finally {
			setCreatingRestorePoint(false);
		}
	};

	const handleRecoverDatabase = async () => {
		const db = database();
		if (!db || !isPostgres()) return;

		const restorePoint = recoveryRestorePoint().trim();
		const targetTime = recoveryTargetTime().trim();

		if (!restorePoint && !targetTime) {
			setPitrMessage("enter a restore point or target time");
			return;
		}

		if (restorePoint && targetTime) {
			setPitrMessage("use either restore point or target time, not both");
			return;
		}

		const confirmed = window.confirm(
			"recover the database to the selected target? this replaces the current data directory.",
		);
		if (!confirmed) {
			return;
		}

		setRecoveringDatabase(true);
		try {
			const response = await recoverDatabase(db.id, {
				restorePoint: restorePoint || undefined,
				targetTime: targetTime ? toTargetTimestamp(targetTime) : undefined,
			});
			setPitrMessage(`database recovered to ${response.recovery_target}`);
			await refetch();
		} catch (error) {
			setPitrMessage(describeError(error));
		} finally {
			setRecoveringDatabase(false);
		}
	};

	const handleDownloadBackup = (filename: string) => {
		const db = database();
		if (!db) return;

		void downloadBackup(db.id, filename).catch((error) => {
			setBackupMessage(describeError(error));
		});
	};

	return (
		<div>
			<div class="mb-8 flex items-start justify-between gap-4">
				<div>
					<div class="flex items-center gap-3">
						<A href="/databases" class="text-xs text-neutral-400 hover:text-black">
							databases
						</A>
						<span class="text-xs text-neutral-300">/</span>
						<span class="text-xs text-neutral-500">{database()?.name || "..."}</span>
					</div>
					<h1 class="mt-2 text-2xl font-serif text-black">{database()?.name || "database"}</h1>
					<p class="mt-1 text-sm text-neutral-500">
						managed service detail with quick connect, exposure, recovery, and backups
					</p>
				</div>
			</div>

			<Show
				when={!database.loading && database()}
				fallback={
					<div class="border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
						{database.error ? describeError(database.error) : "loading database..."}
					</div>
				}
			>
				{(currentDatabase) => {
					const db = currentDatabase();

					return (
						<div class="space-y-6">
							<div class="border border-neutral-900 bg-neutral-950 text-white">
								<div class="grid gap-6 border-b border-neutral-800 px-6 py-6 lg:grid-cols-[1.5fr_1fr]">
									<div>
										<div class="flex flex-wrap items-center gap-3">
											<span
												class={`inline-flex items-center gap-2 px-3 py-1 text-xs uppercase tracking-[0.24em] ${statusBadgeClass(db.status)}`}
											>
												<span class={`h-2 w-2 ${statusDotClass(db.status)}`}></span>
												{db.status}
											</span>
											<span class="border border-neutral-800 px-3 py-1 text-xs uppercase tracking-[0.24em] text-neutral-400">
												{db.db_type}
											</span>
											<span class="border border-neutral-800 px-3 py-1 text-xs uppercase tracking-[0.24em] text-neutral-400">
												version {db.version}
											</span>
										</div>

										<h2 class="mt-5 text-3xl font-serif text-white">{db.name}</h2>
										<p class="mt-2 max-w-2xl text-sm leading-6 text-neutral-300">
											structured like a service overview: quick access up top, deep controls in
											separate tabs, and sensitive values masked until you explicitly reveal them.
										</p>

										<div class="mt-6 flex flex-wrap gap-3">
											<button
												type="button"
												onClick={handlePowerAction}
												disabled={powerAction() !== "" || db.status === "starting"}
												class={db.status === "running" ? secondaryButtonClass : primaryButtonClass}
											>
												{powerButtonLabel()}
											</button>
											<button
												type="button"
												onClick={() => void handleRestart()}
												disabled={powerAction() !== "" || db.status !== "running"}
												class={secondaryButtonClass}
											>
												{powerAction() === "restart" ? "restarting..." : "restart"}
											</button>
											<button
												type="button"
												onClick={() => void handleRefresh()}
												class={secondaryButtonClass}
											>
												refresh
											</button>
										</div>

										<Show when={serviceMessage()}>
											<div class="mt-4 border border-neutral-800 bg-black px-4 py-3 text-sm text-neutral-300">
												{serviceMessage()}
											</div>
										</Show>
									</div>

									<div class="border border-neutral-800 bg-black/40 p-5">
										<p class="text-[11px] uppercase tracking-[0.28em] text-neutral-500">
											quick connect
										</p>
										<p class="mt-2 text-sm text-neutral-300">
											copy the live uri without exposing it on screen, or reveal it when you need to
											inspect it.
										</p>

										<div class="mt-5 border border-neutral-800 bg-neutral-950 p-4">
											<p class="text-[11px] uppercase tracking-[0.28em] text-neutral-500">
												direct connection string
											</p>
											<code class="mt-3 block break-all font-mono text-sm text-neutral-100">
												{secretText("direct_uri", db.connection_string)}
											</code>
											<div class="mt-4 flex flex-wrap gap-2">
												<button
													type="button"
													onClick={() => toggleSecret("direct_uri")}
													class={subtleButtonClass}
												>
													{isSecretVisible("direct_uri") ? "hide" : "show"}
												</button>
												<button
													type="button"
													onClick={() => void copyToClipboard("direct_uri", db.connection_string)}
													class={subtleButtonClass}
												>
													{copyLabel("direct_uri")}
												</button>
											</div>
										</div>

										<Show when={db.proxy_connection_string}>
											<div class="mt-4 border border-neutral-800 bg-neutral-950 p-4">
												<p class="text-[11px] uppercase tracking-[0.28em] text-neutral-500">
													pgdog connection string
												</p>
												<code class="mt-3 block break-all font-mono text-sm text-neutral-100">
													{secretText("proxy_uri", db.proxy_connection_string)}
												</code>
												<div class="mt-4 flex flex-wrap gap-2">
													<button
														type="button"
														onClick={() => toggleSecret("proxy_uri")}
														class={subtleButtonClass}
													>
														{isSecretVisible("proxy_uri") ? "hide" : "show"}
													</button>
													<button
														type="button"
														onClick={() =>
															void copyToClipboard("proxy_uri", db.proxy_connection_string)
														}
														class={subtleButtonClass}
													>
														{copyLabel("proxy_uri")}
													</button>
												</div>
											</div>
										</Show>
									</div>
								</div>

								<div class="grid gap-px bg-neutral-800 sm:grid-cols-2 xl:grid-cols-4">
									<div class="bg-neutral-950 px-6 py-4">
										<p class="text-[11px] uppercase tracking-[0.28em] text-neutral-500">
											internal endpoint
										</p>
										<p class="mt-2 font-mono text-sm text-neutral-100">{directTarget()}</p>
									</div>
									<div class="bg-neutral-950 px-6 py-4">
										<p class="text-[11px] uppercase tracking-[0.28em] text-neutral-500">
											resources
										</p>
										<p class="mt-2 text-sm text-neutral-100">
											{db.memory_limit_mb}mb / {db.cpu_limit} cpu
										</p>
									</div>
									<div class="bg-neutral-950 px-6 py-4">
										<p class="text-[11px] uppercase tracking-[0.28em] text-neutral-500">
											public access
										</p>
										<p class="mt-2 text-sm text-neutral-100">
											{db.external_port ? externalTarget(db.external_port) : "internal only"}
										</p>
									</div>
									<div class="bg-neutral-950 px-6 py-4">
										<p class="text-[11px] uppercase tracking-[0.28em] text-neutral-500">created</p>
										<p class="mt-2 text-sm text-neutral-100">{formatDateTime(db.created_at)}</p>
									</div>
								</div>
							</div>

							<div class="overflow-x-auto border border-neutral-200 bg-white">
								<div class="flex min-w-max gap-px bg-neutral-200 p-px">
									<For each={tabs()}>
										{(tab) => (
											<button
												type="button"
												onClick={() => setActiveTab(tab.id)}
												class={`px-5 py-3 text-xs uppercase tracking-[0.24em] ${
													activeTab() === tab.id
														? "bg-neutral-950 text-white"
														: "bg-white text-neutral-500 hover:text-black"
												}`}
											>
												{tab.label}
											</button>
										)}
									</For>
								</div>
							</div>

							<Show when={activeTab() === "overview"}>
								<div class="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
									<div class="space-y-6">
										<div class="border border-neutral-200 bg-white">
											<div class="border-b border-neutral-200 px-5 py-3">
												<h3 class="text-sm font-serif text-black">service state</h3>
											</div>
											<div class="grid gap-4 p-5 md:grid-cols-2">
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">status</p>
													<p class="mt-2 text-sm text-neutral-800">{db.status}</p>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">engine</p>
													<p class="mt-2 text-sm text-neutral-800">
														{db.db_type} {db.version}
													</p>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														internal endpoint
													</p>
													<div class="mt-2 flex items-center gap-2">
														<code class="font-mono text-sm text-neutral-800">{directTarget()}</code>
														<button
															type="button"
															onClick={() => void copyToClipboard("direct_target", directTarget())}
															class={subtleButtonClass}
														>
															{copyLabel("direct_target")}
														</button>
													</div>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														public endpoint
													</p>
													<div class="mt-2 flex items-center gap-2">
														<code class="font-mono text-sm text-neutral-800">
															{db.external_port ? externalTarget(db.external_port) : "not exposed"}
														</code>
														<Show when={db.external_port}>
															<button
																type="button"
																onClick={() =>
																	void copyToClipboard(
																		"public_target",
																		externalTarget(db.external_port),
																	)
																}
																class={subtleButtonClass}
															>
																{copyLabel("public_target")}
															</button>
														</Show>
													</div>
												</div>
											</div>
										</div>

										<div class="border border-neutral-200 bg-white">
											<div class="border-b border-neutral-200 px-5 py-3">
												<h3 class="text-sm font-serif text-black">routing and exposure</h3>
											</div>
											<div class="grid gap-4 p-5 md:grid-cols-3">
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														direct access
													</p>
													<p class="mt-2 text-sm text-neutral-800">
														{db.external_port ? "internal + public" : "internal only"}
													</p>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">pgdog</p>
													<p class="mt-2 text-sm text-neutral-800">
														{db.proxy_enabled ? "enabled" : "disabled"}
													</p>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">pitr</p>
													<p class="mt-2 text-sm text-neutral-800">
														{db.pitr_enabled ? "enabled" : "disabled"}
													</p>
												</div>
											</div>
										</div>
									</div>

									<div class="space-y-6">
										<div class="border border-neutral-200 bg-white">
											<div class="border-b border-neutral-200 px-5 py-3">
												<h3 class="text-sm font-serif text-black">credentials</h3>
											</div>
											<div class="space-y-4 p-5">
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														username
													</p>
													<div class="mt-2 flex items-center gap-2">
														<code class="font-mono text-sm text-neutral-800">{db.username}</code>
														<button
															type="button"
															onClick={() => void copyToClipboard("username", db.username)}
															class={subtleButtonClass}
														>
															{copyLabel("username")}
														</button>
													</div>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														database name
													</p>
													<div class="mt-2 flex items-center gap-2">
														<code class="font-mono text-sm text-neutral-800">
															{db.database_name}
														</code>
														<button
															type="button"
															onClick={() =>
																void copyToClipboard("database_name", db.database_name)
															}
															class={subtleButtonClass}
														>
															{copyLabel("database_name")}
														</button>
													</div>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														password
													</p>
													<code class="mt-2 block break-all font-mono text-sm text-neutral-800">
														{secretText("password", db.password)}
													</code>
													<div class="mt-3 flex flex-wrap gap-2">
														<button
															type="button"
															onClick={() => toggleSecret("password")}
															class={subtleButtonClass}
														>
															{isSecretVisible("password") ? "hide" : "show"}
														</button>
														<button
															type="button"
															onClick={() => void copyToClipboard("password", db.password)}
															class={subtleButtonClass}
														>
															{copyLabel("password")}
														</button>
													</div>
												</div>
											</div>
										</div>

										<div class="border border-neutral-200 bg-white">
											<div class="border-b border-neutral-200 px-5 py-3">
												<h3 class="text-sm font-serif text-black">recovery posture</h3>
											</div>
											<div class="space-y-4 p-5 text-sm text-neutral-700">
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														latest base backup
													</p>
													<p class="mt-2 text-neutral-800">
														{db.pitr_last_base_backup_label || "none"}
													</p>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														latest backup time
													</p>
													<p class="mt-2 text-neutral-800">
														{formatDateTime(db.pitr_last_base_backup_at)}
													</p>
												</div>
											</div>
										</div>
									</div>
								</div>
							</Show>

							<Show when={activeTab() === "connect"}>
								<div class="space-y-6">
									<div class="border border-neutral-200 bg-white">
										<div class="border-b border-neutral-200 px-5 py-3">
											<h3 class="text-sm font-serif text-black">direct connection</h3>
										</div>
										<div class="space-y-5 p-5">
											<p class="text-sm text-neutral-600">
												connection details stay masked until you reveal them. copy always uses the
												real value.
											</p>

											<div class="border border-neutral-200 bg-neutral-50 p-4">
												<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
													connection string
												</p>
												<code class="mt-3 block break-all font-mono text-sm text-neutral-800">
													{secretText("direct_uri", db.connection_string)}
												</code>
												<div class="mt-4 flex flex-wrap gap-2">
													<button
														type="button"
														onClick={() => toggleSecret("direct_uri")}
														class={subtleButtonClass}
													>
														{isSecretVisible("direct_uri") ? "hide" : "show"}
													</button>
													<button
														type="button"
														onClick={() => void copyToClipboard("direct_uri", db.connection_string)}
														class={subtleButtonClass}
													>
														{copyLabel("direct_uri")}
													</button>
												</div>
											</div>

											<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">host</p>
													<div class="mt-2 flex items-center gap-2">
														<code class="font-mono text-sm text-neutral-800">
															{db.internal_host}
														</code>
														<button
															type="button"
															onClick={() => void copyToClipboard("host", db.internal_host)}
															class={subtleButtonClass}
														>
															{copyLabel("host")}
														</button>
													</div>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">port</p>
													<div class="mt-2 flex items-center gap-2">
														<code class="font-mono text-sm text-neutral-800">{db.port}</code>
														<button
															type="button"
															onClick={() => void copyToClipboard("port", String(db.port))}
															class={subtleButtonClass}
														>
															{copyLabel("port")}
														</button>
													</div>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														username
													</p>
													<div class="mt-2 flex items-center gap-2">
														<code class="font-mono text-sm text-neutral-800">{db.username}</code>
														<button
															type="button"
															onClick={() => void copyToClipboard("username", db.username)}
															class={subtleButtonClass}
														>
															{copyLabel("username")}
														</button>
													</div>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														database
													</p>
													<div class="mt-2 flex items-center gap-2">
														<code class="font-mono text-sm text-neutral-800">
															{db.database_name}
														</code>
														<button
															type="button"
															onClick={() =>
																void copyToClipboard("database_name", db.database_name)
															}
															class={subtleButtonClass}
														>
															{copyLabel("database_name")}
														</button>
													</div>
												</div>
											</div>

											<div class="border border-neutral-200 bg-white p-4">
												<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">password</p>
												<code class="mt-3 block break-all font-mono text-sm text-neutral-800">
													{secretText("password", db.password)}
												</code>
												<div class="mt-4 flex flex-wrap gap-2">
													<button
														type="button"
														onClick={() => toggleSecret("password")}
														class={subtleButtonClass}
													>
														{isSecretVisible("password") ? "hide" : "show"}
													</button>
													<button
														type="button"
														onClick={() => void copyToClipboard("password", db.password)}
														class={subtleButtonClass}
													>
														{copyLabel("password")}
													</button>
												</div>
											</div>
										</div>
									</div>

									<Show when={db.proxy_connection_string}>
										<div class="border border-neutral-200 bg-white">
											<div class="border-b border-neutral-200 px-5 py-3">
												<h3 class="text-sm font-serif text-black">pgdog frontend</h3>
											</div>
											<div class="space-y-5 p-5">
												<div class="border border-neutral-200 bg-neutral-50 p-4">
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														connection string
													</p>
													<code class="mt-3 block break-all font-mono text-sm text-neutral-800">
														{secretText("proxy_uri", db.proxy_connection_string)}
													</code>
													<div class="mt-4 flex flex-wrap gap-2">
														<button
															type="button"
															onClick={() => toggleSecret("proxy_uri")}
															class={subtleButtonClass}
														>
															{isSecretVisible("proxy_uri") ? "hide" : "show"}
														</button>
														<button
															type="button"
															onClick={() =>
																void copyToClipboard("proxy_uri", db.proxy_connection_string)
															}
															class={subtleButtonClass}
														>
															{copyLabel("proxy_uri")}
														</button>
													</div>
												</div>

												<div class="grid gap-4 md:grid-cols-3">
													<div>
														<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
															internal frontend
														</p>
														<div class="mt-2 flex items-center gap-2">
															<code class="font-mono text-sm text-neutral-800">
																{proxyInternalTarget()}
															</code>
															<button
																type="button"
																onClick={() =>
																	void copyToClipboard(
																		"proxy_internal_target",
																		proxyInternalTarget(),
																	)
																}
																class={subtleButtonClass}
															>
																{copyLabel("proxy_internal_target")}
															</button>
														</div>
													</div>
													<div>
														<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
															public frontend
														</p>
														<div class="mt-2 flex items-center gap-2">
															<code class="font-mono text-sm text-neutral-800">
																{db.proxy_external_port
																	? externalTarget(db.proxy_external_port)
																	: "internal only"}
															</code>
															<Show when={db.proxy_external_port}>
																<button
																	type="button"
																	onClick={() =>
																		void copyToClipboard(
																			"proxy_external_target",
																			externalTarget(db.proxy_external_port),
																		)
																	}
																	class={subtleButtonClass}
																>
																	{copyLabel("proxy_external_target")}
																</button>
															</Show>
														</div>
													</div>
													<div>
														<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
															status
														</p>
														<p class="mt-2 text-sm text-neutral-800">
															{db.proxy_external_port ? "internal + public" : "internal only"}
														</p>
													</div>
												</div>
											</div>
										</div>
									</Show>
								</div>
							</Show>

							<Show when={activeTab() === "access"}>
								<div class="space-y-6">
									<div class="border border-neutral-200 bg-white">
										<div class="border-b border-neutral-200 px-5 py-3">
											<h3 class="text-sm font-serif text-black">external access</h3>
										</div>
										<div class="space-y-4 p-5 text-sm text-neutral-700">
											<div class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
												<div>
													<p class="text-sm text-neutral-900">
														expose the primary database endpoint publicly
													</p>
													<p class="mt-2 text-xs uppercase tracking-[0.24em] text-neutral-400">
														direct clients outside the internal network can connect when enabled
													</p>
												</div>
												<div class="w-full max-w-xs">
													<label class="mb-2 block text-xs uppercase tracking-[0.24em] text-neutral-400">
														external port
													</label>
													<input
														type="number"
														min="1024"
														max="65535"
														value={externalPort()}
														onInput={(event) => setExternalPort(event.currentTarget.value)}
														placeholder="auto"
														class="w-full border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
													/>
												</div>
												<button
													type="button"
													onClick={handleToggleExpose}
													disabled={exposing()}
													class={
														db.external_port === null ? primaryButtonClass : secondaryButtonClass
													}
												>
													{exposing()
														? "saving..."
														: db.external_port === null
															? "enable public access"
															: "disable public access"}
												</button>
											</div>

											<Show when={db.external_port !== null}>
												<div class="border border-neutral-200 bg-neutral-50 p-4">
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														public endpoint
													</p>
													<div class="mt-3 flex items-center gap-2">
														<code class="font-mono text-sm text-neutral-800">
															{externalTarget(db.external_port)}
														</code>
														<button
															type="button"
															onClick={() =>
																void copyToClipboard(
																	"public_target",
																	externalTarget(db.external_port),
																)
															}
															class={subtleButtonClass}
														>
															{copyLabel("public_target")}
														</button>
													</div>
												</div>
											</Show>

											<Show when={accessMessage()}>
												<div class="border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-700">
													{accessMessage()}
												</div>
											</Show>
										</div>
									</div>

									<Show when={isPostgres()}>
										<div class="border border-neutral-200 bg-white">
											<div class="border-b border-neutral-200 px-5 py-3">
												<h3 class="text-sm font-serif text-black">pgdog proxy</h3>
											</div>
											<div class="space-y-4 p-5 text-sm text-neutral-700">
												<div class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
													<div>
														<p class="text-sm text-neutral-900">
															enable the pooled postgres frontend for shared-network clients
														</p>
														<p class="mt-2 text-xs uppercase tracking-[0.24em] text-neutral-400">
															optionally publish the proxy on a separate public port
														</p>
													</div>
													<div class="w-full max-w-xs">
														<label class="mb-2 block text-xs uppercase tracking-[0.24em] text-neutral-400">
															public port
														</label>
														<input
															type="number"
															min="1024"
															max="65535"
															value={proxyExternalPort()}
															onInput={(event) => setProxyExternalPort(event.currentTarget.value)}
															placeholder="internal only"
															class="w-full border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
														/>
													</div>
													<button
														type="button"
														onClick={handleToggleProxy}
														disabled={togglingProxy()}
														class={db.proxy_enabled ? secondaryButtonClass : primaryButtonClass}
													>
														{togglingProxy()
															? "saving..."
															: db.proxy_enabled
																? "disable pgdog"
																: "enable pgdog"}
													</button>
												</div>

												<Show when={db.proxy_enabled}>
													<div class="grid gap-4 md:grid-cols-3">
														<div class="border border-neutral-200 bg-neutral-50 p-4">
															<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
																internal frontend
															</p>
															<p class="mt-3 font-mono text-sm text-neutral-800">
																{proxyInternalTarget()}
															</p>
														</div>
														<div class="border border-neutral-200 bg-neutral-50 p-4">
															<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
																public frontend
															</p>
															<p class="mt-3 font-mono text-sm text-neutral-800">
																{db.proxy_external_port
																	? externalTarget(db.proxy_external_port)
																	: "internal only"}
															</p>
														</div>
														<div class="border border-neutral-200 bg-neutral-50 p-4">
															<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
																connection string
															</p>
															<code class="mt-3 block break-all font-mono text-sm text-neutral-800">
																{secretText("proxy_uri", db.proxy_connection_string)}
															</code>
														</div>
													</div>
												</Show>

												<Show when={proxyMessage()}>
													<div class="border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-700">
														{proxyMessage()}
													</div>
												</Show>
											</div>
										</div>
									</Show>
								</div>
							</Show>

							<Show when={activeTab() === "recovery"}>
								<Show
									when={isPostgres()}
									fallback={
										<div class="border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
											point in time recovery is currently available only for postgresql databases.
										</div>
									}
								>
									<div class="space-y-6">
										<div class="border border-neutral-200 bg-white">
											<div class="border-b border-neutral-200 px-5 py-3">
												<div class="flex items-center justify-between gap-4">
													<h3 class="text-sm font-serif text-black">point in time recovery</h3>
													<button
														type="button"
														onClick={handleTogglePitr}
														disabled={togglingPitr()}
														class={db.pitr_enabled ? secondaryButtonClass : primaryButtonClass}
													>
														{togglingPitr()
															? "saving..."
															: db.pitr_enabled
																? "disable pitr"
																: "enable pitr"}
													</button>
												</div>
											</div>
											<div class="grid gap-4 p-5 md:grid-cols-3">
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">status</p>
													<p class="mt-2 text-sm text-neutral-800">
														{db.pitr_enabled ? "enabled" : "disabled"}
													</p>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														latest base backup
													</p>
													<p class="mt-2 text-sm text-neutral-800">
														{db.pitr_last_base_backup_label || "none"}
													</p>
												</div>
												<div>
													<p class="text-xs uppercase tracking-[0.24em] text-neutral-400">
														latest backup time
													</p>
													<p class="mt-2 text-sm text-neutral-800">
														{formatDateTime(db.pitr_last_base_backup_at)}
													</p>
												</div>
											</div>
										</div>

										<div class="grid gap-6 xl:grid-cols-2">
											<div class="border border-neutral-200 bg-white">
												<div class="border-b border-neutral-200 px-5 py-3">
													<h3 class="text-sm font-serif text-black">base backup</h3>
												</div>
												<div class="space-y-4 p-5">
													<div>
														<label class="mb-2 block text-xs uppercase tracking-[0.24em] text-neutral-400">
															base backup label
														</label>
														<input
															type="text"
															value={baseBackupLabel()}
															onInput={(event) => setBaseBackupLabel(event.currentTarget.value)}
															placeholder="base-20260308"
															class="w-full border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
														/>
													</div>
													<button
														type="button"
														onClick={handleCreateBaseBackup}
														disabled={
															creatingBaseBackup() || !db.pitr_enabled || db.status !== "running"
														}
														class={primaryButtonClass}
													>
														{creatingBaseBackup() ? "creating..." : "create base backup"}
													</button>
												</div>
											</div>

											<div class="border border-neutral-200 bg-white">
												<div class="border-b border-neutral-200 px-5 py-3">
													<h3 class="text-sm font-serif text-black">restore point</h3>
												</div>
												<div class="space-y-4 p-5">
													<div>
														<label class="mb-2 block text-xs uppercase tracking-[0.24em] text-neutral-400">
															restore point name
														</label>
														<input
															type="text"
															value={restorePointName()}
															onInput={(event) => setRestorePointName(event.currentTarget.value)}
															placeholder="restore-before-migration"
															class="w-full border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
														/>
													</div>
													<button
														type="button"
														onClick={handleCreateRestorePoint}
														disabled={
															creatingRestorePoint() || !db.pitr_enabled || db.status !== "running"
														}
														class={secondaryButtonClass}
													>
														{creatingRestorePoint() ? "creating..." : "create restore point"}
													</button>
												</div>
											</div>
										</div>

										<div class="border border-neutral-200 bg-white">
											<div class="border-b border-neutral-200 px-5 py-3">
												<h3 class="text-sm font-serif text-black">recover database</h3>
											</div>
											<div class="space-y-5 p-5">
												<p class="text-sm text-neutral-600">
													recover from the latest base backup using either a named restore point or
													a target timestamp.
												</p>
												<div class="grid gap-4 md:grid-cols-2">
													<div>
														<label class="mb-2 block text-xs uppercase tracking-[0.24em] text-neutral-400">
															restore point
														</label>
														<input
															type="text"
															value={recoveryRestorePoint()}
															onInput={(event) =>
																setRecoveryRestorePoint(event.currentTarget.value)
															}
															placeholder="restore-before-migration"
															class="w-full border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
														/>
													</div>
													<div>
														<label class="mb-2 block text-xs uppercase tracking-[0.24em] text-neutral-400">
															target time
														</label>
														<input
															type="datetime-local"
															value={recoveryTargetTime()}
															onInput={(event) => setRecoveryTargetTime(event.currentTarget.value)}
															class="w-full border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
														/>
													</div>
												</div>
												<button
													type="button"
													onClick={handleRecoverDatabase}
													disabled={
														recoveringDatabase() ||
														!db.pitr_enabled ||
														!db.pitr_last_base_backup_label
													}
													class={primaryButtonClass}
												>
													{recoveringDatabase() ? "recovering..." : "recover database"}
												</button>
											</div>
										</div>

										<Show when={pitrMessage()}>
											<div class="border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-700">
												{pitrMessage()}
											</div>
										</Show>
									</div>
								</Show>
							</Show>

							<Show when={activeTab() === "backups"}>
								<div class="space-y-6">
									<div class="border border-neutral-200 bg-white">
										<div class="border-b border-neutral-200 px-5 py-3">
											<h3 class="text-sm font-serif text-black">create backup</h3>
										</div>
										<div class="space-y-5 p-5">
											<div class="flex flex-wrap gap-3">
												<button
													type="button"
													onClick={handleCreateBackup}
													disabled={creatingBackup() || db.status !== "running"}
													class={primaryButtonClass}
												>
													{creatingBackup() ? "creating..." : "create local backup"}
												</button>
												<button
													type="button"
													onClick={handleBackupToBucket}
													disabled={
														uploadingBackup() || db.status !== "running" || !selectedBucketId()
													}
													class={secondaryButtonClass}
												>
													{uploadingBackup() ? "uploading..." : "backup to bucket"}
												</button>
											</div>

											<div class="grid gap-4 md:grid-cols-2">
												<div>
													<label class="mb-2 block text-xs uppercase tracking-[0.24em] text-neutral-400">
														bucket
													</label>
													<select
														value={selectedBucketId()}
														onChange={(event) => setSelectedBucketId(event.currentTarget.value)}
														class="w-full border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-800"
													>
														<option value="">select bucket</option>
														<For each={buckets()}>
															{(bucket) => <option value={bucket.id}>{bucket.name}</option>}
														</For>
													</select>
												</div>
												<div>
													<label class="mb-2 block text-xs uppercase tracking-[0.24em] text-neutral-400">
														object prefix
													</label>
													<input
														type="text"
														value={bucketPrefix()}
														onInput={(event) => setBucketPrefix(event.currentTarget.value)}
														placeholder={`databases/${db.name}`}
														class="w-full border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
													/>
												</div>
											</div>

											<p class="text-sm text-neutral-500">
												uploads keep the local backup file and optionally mirror it into a selected
												bucket.
											</p>

											<Show when={backupMessage()}>
												<div class="border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-700">
													{backupMessage()}
												</div>
											</Show>
										</div>
									</div>

									<div class="border border-neutral-200 bg-white">
										<div class="border-b border-neutral-200 px-5 py-3">
											<h3 class="text-sm font-serif text-black">backup history</h3>
										</div>
										<Show
											when={backups() && backups()!.length > 0}
											fallback={
												<div class="p-8 text-center text-sm text-neutral-400">no backups yet</div>
											}
										>
											<div>
												<For each={backups()}>
													{(backup) => (
														<div class="flex flex-col gap-4 border-b border-neutral-200 px-5 py-4 last:border-b-0 md:flex-row md:items-center md:justify-between">
															<div>
																<p class="font-mono text-sm text-neutral-800">{backup.filename}</p>
																<p class="mt-1 text-xs uppercase tracking-[0.18em] text-neutral-400">
																	{formatBytes(backup.size_bytes)} ·{" "}
																	{formatDateTime(backup.created_at)}
																</p>
															</div>
															<button
																type="button"
																onClick={() => handleDownloadBackup(backup.filename)}
																class={subtleButtonClass}
															>
																download
															</button>
														</div>
													)}
												</For>
											</div>
										</Show>
									</div>
								</div>
							</Show>

							<Show when={activeTab() === "container"}>
								<div class="space-y-6">
									<div class="border border-neutral-200 bg-white">
										<div class="border-b border-neutral-200 px-5 py-3">
											<h3 class="text-sm font-serif text-black">container monitor</h3>
										</div>
										<div class="p-5">
											<Show
												when={dbContainers().length > 0}
												fallback={
													<div class="border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-400">
														no running container for this database
													</div>
												}
											>
												<ContainerMonitor containerId={selectedContainer()} />
											</Show>
										</div>
									</div>
								</div>
							</Show>
						</div>
					);
				}}
			</Show>
		</div>
	);
};

export default DatabaseDetail;
