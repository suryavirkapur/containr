import { A, useParams } from "@solidjs/router";
import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";
import ContainerMonitor from "../components/ContainerMonitor";
import { api, components } from "../api";

type DatabaseResponse = components["schemas"]["DatabaseResponse"];
type ContainerListItem = components["schemas"]["ContainerListItem"];
type BackupInfo = components["schemas"]["BackupInfo"];
type Bucket = components["schemas"]["BucketResponse"];
type ExportResponse = components["schemas"]["ExportResponse"];
type BaseBackupResponse = components["schemas"]["BaseBackupResponse"];
type RestorePointResponse = components["schemas"]["RestorePointResponse"];
type RecoverDatabaseResponse = components["schemas"]["RecoverDatabaseResponse"];

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
  return data;
};

const fetchBuckets = async (): Promise<Bucket[]> => {
  const { data, error } = await api.GET("/api/buckets");
  if (error) throw error;
  return data;
};

const fetchBackups = async (id: string): Promise<BackupInfo[]> => {
  const { data, error } = await api.GET("/api/databases/{id}/backups", {
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

const togglePitr = async (
  id: string,
  enabled: boolean,
): Promise<DatabaseResponse> => {
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

const createPitrBaseBackup = async (
  id: string,
  label?: string,
): Promise<BaseBackupResponse> => {
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
  const idx = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / Math.pow(1024, idx)).toFixed(1)} ${units[idx]}`;
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
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const toTargetTimestamp = (value: string) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("target time must be a valid date");
  }

  return parsed.toISOString();
};

const DatabaseDetail: Component = () => {
  const params = useParams();
  const [database, { refetch }] = createResource(() => params.id, fetchDatabase);
  const [containers] = createResource(fetchContainers);
  const [backups, { refetch: refetchBackups }] = createResource(
    () => params.id,
    fetchBackups,
  );
  const [buckets] = createResource(fetchBuckets);
  const [selectedContainer, setSelectedContainer] = createSignal("");
  const [showPassword, setShowPassword] = createSignal(false);
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
  const [backupMessage, setBackupMessage] = createSignal("");
  const [proxyMessage, setProxyMessage] = createSignal("");
  const [pitrMessage, setPitrMessage] = createSignal("");
  const [baseBackupLabel, setBaseBackupLabel] = createSignal("");
  const [restorePointName, setRestorePointName] = createSignal("");
  const [recoveryRestorePoint, setRecoveryRestorePoint] = createSignal("");
  const [recoveryTargetTime, setRecoveryTargetTime] = createSignal("");

  const dbContainers = createMemo(() =>
    (containers() || []).filter(
      (item) =>
        item.resource_type === "database" && item.resource_id === params.id,
    ),
  );

  const isPostgres = createMemo(
    () => database()?.db_type === "postgresql",
  );

  createEffect(() => {
    if (!selectedContainer() && dbContainers().length > 0) {
      setSelectedContainer(dbContainers()[0].id);
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

  const copyToClipboard = (text?: string | null) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
  };

  const externalTarget = (port?: number | null) =>
    port ? `${window.location.hostname}:${port}` : "";

  const handleToggleExpose = async () => {
    const db = database();
    if (!db) return;

    setExposing(true);
    try {
      const shouldEnable = db.external_port === null;
      const requestedPort = externalPort().trim();
      await toggleExternalAccess(
        db.id,
        shouldEnable,
        shouldEnable && requestedPort ? Number(requestedPort) : undefined,
      );
      setBackupMessage("");
      await refetch();
    } catch (error) {
      setBackupMessage(describeError(error));
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
      const response = await createPitrBaseBackup(
        db.id,
        baseBackupLabel().trim() || undefined,
      );
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
      <div class="flex items-center justify-between mb-8">
        <div>
          <div class="flex items-center gap-3">
            <A
              href="/databases"
              class="text-xs text-neutral-400 hover:text-black"
            >
              databases
            </A>
            <span class="text-xs text-neutral-300">/</span>
            <span class="text-xs text-neutral-500">
              {database()?.name || "..."}
            </span>
          </div>
          <h1 class="text-2xl font-serif text-black mt-2">
            {database()?.name}
          </h1>
          <p class="text-neutral-500 mt-1 text-sm">
            {database()?.db_type} {database()?.version}
          </p>
        </div>
      </div>

      <Show when={database()}>
        <div class="border border-neutral-200 p-5 mb-6 text-sm text-neutral-600 grid grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-neutral-400">host</p>
            <p class="font-mono text-neutral-800">
              {database()!.internal_host}:{database()!.port}
            </p>
          </div>
          <div>
            <p class="text-xs text-neutral-400">status</p>
            <p class="text-neutral-800">{database()!.status}</p>
          </div>
          <div>
            <p class="text-xs text-neutral-400">resources</p>
            <p class="text-neutral-800">
              {database()!.memory_limit_mb}mb / {database()!.cpu_limit} cpu
            </p>
          </div>
          <div>
            <p class="text-xs text-neutral-400">created</p>
            <p class="text-neutral-800">
              {new Date(database()!.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>

        <div class="mb-6">
          <h2 class="text-lg font-serif text-black mb-3">credentials</h2>
          <div class="border border-neutral-200 p-5 text-sm text-neutral-600 space-y-4">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <p class="text-xs text-neutral-400">username</p>
                <div class="flex items-center gap-2">
                  <p class="font-mono text-neutral-800">
                    {database()!.username}
                  </p>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(database()!.username)}
                    class="text-xs text-neutral-400 hover:text-black"
                  >
                    copy
                  </button>
                </div>
              </div>
              <div>
                <p class="text-xs text-neutral-400">database</p>
                <div class="flex items-center gap-2">
                  <p class="font-mono text-neutral-800">
                    {database()!.database_name}
                  </p>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(database()!.database_name)}
                    class="text-xs text-neutral-400 hover:text-black"
                  >
                    copy
                  </button>
                </div>
              </div>
            </div>
            <div>
              <p class="text-xs text-neutral-400">password</p>
              <div class="flex items-center gap-2">
                <p class="font-mono text-neutral-800">
                  {showPassword() ? database()!.password : "••••••••••••"}
                </p>
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword())}
                  class="text-xs text-neutral-400 hover:text-black"
                >
                  {showPassword() ? "hide" : "show"}
                </button>
                <button
                  type="button"
                  onClick={() => copyToClipboard(database()!.password)}
                  class="text-xs text-neutral-400 hover:text-black"
                >
                  copy
                </button>
              </div>
            </div>
            <div>
              <p class="text-xs text-neutral-400">direct connection string</p>
              <div class="flex items-center gap-2">
                <p class="font-mono text-neutral-800 break-all">
                  {database()!.connection_string}
                </p>
                <button
                  type="button"
                  onClick={() => copyToClipboard(database()!.connection_string)}
                  class="text-xs text-neutral-400 hover:text-black flex-shrink-0"
                >
                  copy
                </button>
              </div>
            </div>
            <Show when={database()!.proxy_connection_string}>
              <div>
                <p class="text-xs text-neutral-400">pgdog connection string</p>
                <div class="flex items-center gap-2">
                  <p class="font-mono text-neutral-800 break-all">
                    {database()!.proxy_connection_string}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(database()!.proxy_connection_string)
                    }
                    class="text-xs text-neutral-400 hover:text-black flex-shrink-0"
                  >
                    copy
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </div>

        <div class="mb-6">
          <h2 class="text-lg font-serif text-black mb-3">external access</h2>
          <div class="border border-neutral-200 p-5 text-sm text-neutral-600 space-y-4">
            <div class="flex items-end justify-between gap-4">
              <div>
                <p class="text-neutral-800">expose database externally</p>
                <p class="text-xs text-neutral-400 mt-1">
                  allow direct connections from outside the internal network
                </p>
              </div>
              <div class="w-40">
                <label class="block text-xs text-neutral-400 mb-1">
                  external port
                </label>
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={externalPort()}
                  onInput={(event) => setExternalPort(event.currentTarget.value)}
                  placeholder="auto"
                  class="w-full px-3 py-2 border border-neutral-300 text-neutral-800"
                />
              </div>
              <button
                type="button"
                onClick={handleToggleExpose}
                disabled={exposing()}
                class={`px-4 py-2 text-xs ${
                  database()!.external_port !== null
                    ? "bg-neutral-200 text-neutral-800 hover:bg-neutral-300"
                    : "bg-black text-white hover:bg-neutral-800"
                } disabled:opacity-50`}
              >
                {exposing()
                  ? "..."
                  : database()!.external_port !== null
                    ? "disable"
                    : "enable"}
              </button>
            </div>
            <Show when={database()!.external_port !== null}>
              <div class="pt-4 border-t border-neutral-200">
                <p class="text-xs text-neutral-400">external connection</p>
                <div class="flex items-center gap-2 mt-1">
                  <p class="font-mono text-neutral-800">
                    {externalTarget(database()!.external_port)}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(externalTarget(database()!.external_port))
                    }
                    class="text-xs text-neutral-400 hover:text-black"
                  >
                    copy
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </div>

        <Show
          when={isPostgres()}
          fallback={
            <div class="border border-neutral-200 p-5 mb-6 text-sm text-neutral-500">
              point in time recovery and pgdog frontends are currently available
              only for postgresql databases.
            </div>
          }
        >
          <div class="mb-6">
            <h2 class="text-lg font-serif text-black mb-3">pgdog frontend</h2>
            <div class="border border-neutral-200 p-5 text-sm text-neutral-600 space-y-4">
              <div class="flex items-end justify-between gap-4">
                <div>
                  <p class="text-neutral-800">enable pgdog proxy</p>
                  <p class="text-xs text-neutral-400 mt-1">
                    provide a pooled postgres frontend inside the shared network
                  </p>
                </div>
                <div class="w-40">
                  <label class="block text-xs text-neutral-400 mb-1">
                    public port
                  </label>
                  <input
                    type="number"
                    min="1024"
                    max="65535"
                    value={proxyExternalPort()}
                    onInput={(event) =>
                      setProxyExternalPort(event.currentTarget.value)
                    }
                    placeholder="internal only"
                    class="w-full px-3 py-2 border border-neutral-300 text-neutral-800"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleToggleProxy}
                  disabled={togglingProxy()}
                  class={`px-4 py-2 text-xs ${
                    database()!.proxy_enabled
                      ? "bg-neutral-200 text-neutral-800 hover:bg-neutral-300"
                      : "bg-black text-white hover:bg-neutral-800"
                  } disabled:opacity-50`}
                >
                  {togglingProxy()
                    ? "..."
                    : database()!.proxy_enabled
                      ? "disable"
                      : "enable"}
                </button>
              </div>
              <Show when={database()!.proxy_enabled}>
                <div class="grid grid-cols-2 gap-4 pt-4 border-t border-neutral-200">
                  <div>
                    <p class="text-xs text-neutral-400">internal frontend</p>
                    <p class="font-mono text-neutral-800 mt-1">
                      {database()!.database_name}:{database()!.proxy_port}
                    </p>
                  </div>
                  <div>
                    <p class="text-xs text-neutral-400">proxy status</p>
                    <p class="text-neutral-800 mt-1">
                      {database()!.proxy_external_port
                        ? "internal + public"
                        : "internal only"}
                    </p>
                  </div>
                </div>
                <Show when={database()!.proxy_connection_string}>
                  <div class="pt-4 border-t border-neutral-200">
                    <p class="text-xs text-neutral-400">connection string</p>
                    <div class="flex items-center gap-2 mt-1">
                      <p class="font-mono text-neutral-800 break-all">
                        {database()!.proxy_connection_string}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(database()!.proxy_connection_string)
                        }
                        class="text-xs text-neutral-400 hover:text-black"
                      >
                        copy
                      </button>
                    </div>
                  </div>
                </Show>
                <Show when={database()!.proxy_external_port !== null}>
                  <div class="pt-4 border-t border-neutral-200">
                    <p class="text-xs text-neutral-400">public frontend</p>
                    <div class="flex items-center gap-2 mt-1">
                      <p class="font-mono text-neutral-800">
                        {externalTarget(database()!.proxy_external_port)}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(
                            externalTarget(database()!.proxy_external_port),
                          )
                        }
                        class="text-xs text-neutral-400 hover:text-black"
                      >
                        copy
                      </button>
                    </div>
                  </div>
                </Show>
              </Show>
              <Show when={proxyMessage()}>
                <p class="text-xs text-neutral-500">{proxyMessage()}</p>
              </Show>
            </div>
          </div>

          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <h2 class="text-lg font-serif text-black">point in time recovery</h2>
              <button
                type="button"
                onClick={handleTogglePitr}
                disabled={togglingPitr()}
                class={`px-4 py-2 text-xs ${
                  database()!.pitr_enabled
                    ? "bg-neutral-200 text-neutral-800 hover:bg-neutral-300"
                    : "bg-black text-white hover:bg-neutral-800"
                } disabled:opacity-50`}
              >
                {togglingPitr()
                  ? "..."
                  : database()!.pitr_enabled
                    ? "disable"
                    : "enable"}
              </button>
            </div>
            <div class="border border-neutral-200 p-5 text-sm text-neutral-600 space-y-4">
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <p class="text-xs text-neutral-400">status</p>
                  <p class="text-neutral-800 mt-1">
                    {database()!.pitr_enabled ? "enabled" : "disabled"}
                  </p>
                </div>
                <div>
                  <p class="text-xs text-neutral-400">latest base backup</p>
                  <p class="text-neutral-800 mt-1">
                    {database()!.pitr_last_base_backup_label || "none"}
                  </p>
                  <Show when={database()!.pitr_last_base_backup_at}>
                    <p class="text-xs text-neutral-400 mt-1">
                      {new Date(
                        database()!.pitr_last_base_backup_at!,
                      ).toLocaleString()}
                    </p>
                  </Show>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-xs text-neutral-400 mb-1">
                    base backup label
                  </label>
                  <input
                    type="text"
                    value={baseBackupLabel()}
                    onInput={(event) =>
                      setBaseBackupLabel(event.currentTarget.value)
                    }
                    placeholder="base-20260307"
                    class="w-full px-3 py-2 border border-neutral-300 text-neutral-800"
                  />
                </div>
                <div class="flex items-end">
                  <button
                    type="button"
                    onClick={handleCreateBaseBackup}
                    disabled={
                      creatingBaseBackup() ||
                      !database()!.pitr_enabled ||
                      database()!.status !== "running"
                    }
                    class="px-4 py-2 text-xs bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                  >
                    {creatingBaseBackup() ? "creating..." : "create base backup"}
                  </button>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-xs text-neutral-400 mb-1">
                    restore point
                  </label>
                  <input
                    type="text"
                    value={restorePointName()}
                    onInput={(event) =>
                      setRestorePointName(event.currentTarget.value)
                    }
                    placeholder="restore-before-migration"
                    class="w-full px-3 py-2 border border-neutral-300 text-neutral-800"
                  />
                </div>
                <div class="flex items-end">
                  <button
                    type="button"
                    onClick={handleCreateRestorePoint}
                    disabled={
                      creatingRestorePoint() ||
                      !database()!.pitr_enabled ||
                      database()!.status !== "running"
                    }
                    class="px-4 py-2 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400 disabled:opacity-50"
                  >
                    {creatingRestorePoint()
                      ? "creating..."
                      : "create restore point"}
                  </button>
                </div>
              </div>

              <div class="pt-4 border-t border-neutral-200 space-y-4">
                <p class="text-neutral-800">recover from latest base backup</p>
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label class="block text-xs text-neutral-400 mb-1">
                      restore point
                    </label>
                    <input
                      type="text"
                      value={recoveryRestorePoint()}
                      onInput={(event) =>
                        setRecoveryRestorePoint(event.currentTarget.value)
                      }
                      placeholder="restore-before-migration"
                      class="w-full px-3 py-2 border border-neutral-300 text-neutral-800"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-neutral-400 mb-1">
                      target time
                    </label>
                    <input
                      type="datetime-local"
                      value={recoveryTargetTime()}
                      onInput={(event) =>
                        setRecoveryTargetTime(event.currentTarget.value)
                      }
                      class="w-full px-3 py-2 border border-neutral-300 text-neutral-800"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleRecoverDatabase}
                  disabled={
                    recoveringDatabase() ||
                    !database()!.pitr_enabled ||
                    !database()!.pitr_last_base_backup_label
                  }
                  class="px-4 py-2 text-xs bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  {recoveringDatabase() ? "recovering..." : "recover database"}
                </button>
              </div>

              <Show when={pitrMessage()}>
                <p class="text-xs text-neutral-500">{pitrMessage()}</p>
              </Show>
            </div>
          </div>
        </Show>

        <div class="mb-6">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-lg font-serif text-black">backups</h2>
            <div class="flex gap-2">
              <button
                type="button"
                onClick={handleCreateBackup}
                disabled={creatingBackup() || database()!.status !== "running"}
                class="px-4 py-2 text-xs bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
              >
                {creatingBackup() ? "creating..." : "create local backup"}
              </button>
              <button
                type="button"
                onClick={handleBackupToBucket}
                disabled={
                  uploadingBackup() ||
                  database()!.status !== "running" ||
                  !selectedBucketId()
                }
                class="px-4 py-2 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400 disabled:opacity-50"
              >
                {uploadingBackup() ? "uploading..." : "backup to bucket"}
              </button>
            </div>
          </div>
          <div class="border border-neutral-200 p-5 mb-4 space-y-4 text-sm text-neutral-600">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs text-neutral-400 mb-1">bucket</label>
                <select
                  value={selectedBucketId()}
                  onChange={(event) => setSelectedBucketId(event.currentTarget.value)}
                  class="w-full px-3 py-2 border border-neutral-300 text-neutral-800 bg-white"
                >
                  <option value="">select bucket</option>
                  <For each={buckets()}>
                    {(bucket) => <option value={bucket.id}>{bucket.name}</option>}
                  </For>
                </select>
              </div>
              <div>
                <label class="block text-xs text-neutral-400 mb-1">
                  object prefix
                </label>
                <input
                  type="text"
                  value={bucketPrefix()}
                  onInput={(event) => setBucketPrefix(event.currentTarget.value)}
                  placeholder={`databases/${database()!.name}`}
                  class="w-full px-3 py-2 border border-neutral-300 text-neutral-800"
                />
              </div>
            </div>
            <p class="text-xs text-neutral-400">
              uploading to a bucket also keeps the local backup file.
            </p>
            <Show when={backupMessage()}>
              <p class="text-xs text-neutral-500">{backupMessage()}</p>
            </Show>
          </div>
          <div class="border border-neutral-200">
            <Show
              when={backups() && backups()!.length > 0}
              fallback={
                <div class="p-8 text-center text-neutral-400 text-sm">
                  no backups yet
                </div>
              }
            >
              <For each={backups()}>
                {(backup) => (
                  <div class="flex items-center justify-between px-5 py-3 border-b border-neutral-100 last:border-b-0">
                    <div>
                      <p class="text-sm text-neutral-800 font-mono">
                        {backup.filename}
                      </p>
                      <p class="text-xs text-neutral-400 mt-1">
                        {formatBytes(backup.size_bytes)} ·{" "}
                        {new Date(backup.created_at).toLocaleString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDownloadBackup(backup.filename)}
                      class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
                    >
                      download
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>

      <div>
        <h2 class="text-lg font-serif text-black mb-3">container</h2>
        <Show
          when={dbContainers().length > 0}
          fallback={
            <div class="border border-dashed border-neutral-200 p-8 text-center text-neutral-400 text-sm">
              no running container for this database
            </div>
          }
        >
          <ContainerMonitor containerId={selectedContainer()} />
        </Show>
      </div>
    </div>
  );
};

export default DatabaseDetail;
