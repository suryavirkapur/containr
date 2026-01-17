import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { useParams, A } from "@solidjs/router";
import ContainerMonitor from "../components/ContainerMonitor";

interface BackupInfo {
  filename: string;
  size_bytes: number;
  created_at: string;
}

interface Database {
  id: string;
  name: string;
  db_type: string;
  version: string;
  status: string;
  internal_host: string;
  port: number;
  connection_string: string;
  username: string;
  password: string;
  database_name: string;
  external_port: number | null;
  memory_limit_mb: number;
  cpu_limit: number;
  created_at: string;
}

interface ContainerListItem {
  id: string;
  resource_type: string;
  resource_id: string;
  name: string;
}

const fetchDatabase = async (id: string): Promise<Database> => {
  const token = localStorage.getItem("znskr_token");
  const res = await fetch(`/api/databases/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("failed to fetch database");
  }
  return res.json();
};

const fetchContainers = async (): Promise<ContainerListItem[]> => {
  const token = localStorage.getItem("znskr_token");
  const res = await fetch("/api/containers", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("failed to fetch containers");
  }
  return res.json();
};

const toggleExternalAccess = async (
  id: string,
  enabled: boolean,
): Promise<Database> => {
  const token = localStorage.getItem("znskr_token");
  const res = await fetch(`/api/databases/${id}/expose`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    throw new Error("failed to toggle external access");
  }
  return res.json();
};

const fetchBackups = async (id: string): Promise<BackupInfo[]> => {
  const token = localStorage.getItem("znskr_token");
  const res = await fetch(`/api/databases/${id}/backups`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return [];
  }
  return res.json();
};

const createBackup = async (id: string): Promise<void> => {
  const token = localStorage.getItem("znskr_token");
  const res = await fetch(`/api/databases/${id}/export`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("failed to create backup");
  }
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

const DatabaseDetail: Component = () => {
  const params = useParams();
  const [database, { refetch }] = createResource(
    () => params.id,
    fetchDatabase,
  );
  const [containers] = createResource(fetchContainers);
  const [backups, { refetch: refetchBackups }] = createResource(
    () => params.id,
    fetchBackups,
  );
  const [selectedContainer, setSelectedContainer] = createSignal("");
  const [showPassword, setShowPassword] = createSignal(false);
  const [exposing, setExposing] = createSignal(false);
  const [creatingBackup, setCreatingBackup] = createSignal(false);

  const dbContainers = createMemo(() =>
    (containers() || []).filter(
      (item) =>
        item.resource_type === "database" && item.resource_id === params.id,
    ),
  );

  createEffect(() => {
    if (!selectedContainer() && dbContainers().length > 0) {
      setSelectedContainer(dbContainers()[0].id);
    }
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleToggleExpose = async () => {
    const db = database();
    if (!db) return;
    setExposing(true);
    try {
      await toggleExternalAccess(db.id, db.external_port === null);
      refetch();
    } finally {
      setExposing(false);
    }
  };

  const handleCreateBackup = async () => {
    const db = database();
    if (!db) return;
    setCreatingBackup(true);
    try {
      await createBackup(db.id);
      refetchBackups();
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleDownloadBackup = (filename: string) => {
    const db = database();
    if (!db) return;
    const token = localStorage.getItem("znskr_token");
    window.open(
      `/api/databases/${db.id}/backups/download?filename=${encodeURIComponent(filename)}`,
      "_blank",
    );
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
              <p class="text-xs text-neutral-400">connection string</p>
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
          </div>
        </div>

        <div class="mb-6">
          <h2 class="text-lg font-serif text-black mb-3">external access</h2>
          <div class="border border-neutral-200 p-5 text-sm text-neutral-600">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-neutral-800">expose database externally</p>
                <p class="text-xs text-neutral-400 mt-1">
                  allow connections from outside the internal network
                </p>
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
              <div class="mt-4 pt-4 border-t border-neutral-200">
                <p class="text-xs text-neutral-400">external connection</p>
                <div class="flex items-center gap-2 mt-1">
                  <p class="font-mono text-neutral-800">
                    {window.location.hostname}:{database()!.external_port}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(
                        `${window.location.hostname}:${database()!.external_port}`,
                      )
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

        <div class="mb-6">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-lg font-serif text-black">backups</h2>
            <button
              type="button"
              onClick={handleCreateBackup}
              disabled={creatingBackup() || database()!.status !== "running"}
              class="px-4 py-2 text-xs bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {creatingBackup() ? "creating..." : "create backup"}
            </button>
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
