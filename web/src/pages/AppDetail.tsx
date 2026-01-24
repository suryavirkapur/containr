import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { parseAnsi } from "../utils/ansi";
import ContainerMonitor from "../components/ContainerMonitor";
import { api } from "../api";
import { apiGet, apiPost } from "../api/client";

interface AppService {
  id: string;
  name: string;
  image: string;
  port: number;
  replicas: number;
  memory_limit_mb: number | null;
  cpu_limit: number | null;
  depends_on: string[];
  restart_policy: string;
}

interface App {
  id: string;
  name: string;
  github_url: string;
  branch: string;
  domain: string | null;
  port: number;
  created_at: string;
  env_vars: { key: string; value: string; secret: boolean }[];
  services: AppService[];
}

interface Deployment {
  id: string;
  app_id: string;
  commit_sha: string;
  commit_message: string | null;
  status: string;
  container_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface CertificateStatus {
  domain: string;
  status: "none" | "pending" | "valid" | "expiringsoon" | "expired" | "failed";
  expires_at: string | null;
  issued_at: string | null;
}

interface ContainerListItem {
  id: string;
  resource_type: string;
  resource_id: string;
  name: string;
}

/**
 * fetches app details
 */
const fetchApp = async (id: string): Promise<App> => {
  const { data, error } = await api.GET("/api/apps/{id}", {
    params: { path: { id } },
  });
  if (error) throw error;
  return data as App;
};

/**
 * fetches deployments for an app
 */
const fetchDeployments = async (appId: string): Promise<Deployment[]> => {
  return apiGet<Deployment[]>(`/api/apps/${appId}/deployments`);
};

/**
 * fetches certificate status for an app
 */
const fetchCertificate = async (appId: string): Promise<CertificateStatus> => {
  return apiGet<CertificateStatus>(`/api/apps/${appId}/certificate`);
};

/**
 * fetches containers for the user
 */
const fetchContainers = async (): Promise<ContainerListItem[]> => {
  const { data, error } = await api.GET("/api/containers");
  if (error) throw error;
  return data as ContainerListItem[];
};

/**
 * app detail page
 */
const AppDetail: Component = () => {
  const params = useParams();
  const navigate = useNavigate();
  const [deploying, setDeploying] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);

  // deployment logs state
  const [selectedDeployment, setSelectedDeployment] =
    createSignal<Deployment | null>(null);
  const [deploymentLogs, setDeploymentLogs] = createSignal<string[]>([]);
  const [deploymentLogsConnected, setDeploymentLogsConnected] =
    createSignal(false);
  const [deploymentLogsLoading, setDeploymentLogsLoading] = createSignal(false);
  let deploymentLogsSocket: WebSocket | null = null;
  let deploymentLogsRef: HTMLDivElement | undefined;

  const [app, { refetch: refetchApp }] = createResource(
    () => params.id,
    fetchApp,
  );

  const [deployments, { refetch: refetchDeployments }] = createResource(
    () => params.id,
    fetchDeployments,
  );

  const [certificate, { refetch: refetchCertificate }] = createResource(
    () => params.id,
    fetchCertificate,
  );

  const [containers] = createResource(fetchContainers);
  const [selectedContainer, setSelectedContainer] = createSignal("");

  const appContainers = createMemo(() =>
    (containers() || []).filter(
      (item) => item.resource_type === "app" && item.resource_id === params.id,
    ),
  );

  createEffect(() => {
    if (!selectedContainer() && appContainers().length > 0) {
      setSelectedContainer(appContainers()[0].id);
    }
  });

  const [reissuing, setReissuing] = createSignal(false);

  const reissueCertificate = async () => {
    setReissuing(true);
    try {
      await apiPost(`/api/apps/${params.id}/certificate/reissue`);

      refetchCertificate();
    } catch (err) {
      console.error(err);
    } finally {
      setReissuing(false);
    }
  };

  // Edit form state
  const [editing, setEditing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [bulkEditEnv, setBulkEditEnv] = createSignal(false);
  const [bulkEnvText, setBulkEnvText] = createSignal("");
  const [deployingImage, setDeployingImage] = createSignal(false);
  const [imageNameInput, setImageNameInput] = createSignal("");
  const [editForm, setEditForm] = createSignal({
    domain: "",
    port: 8080,
    github_url: "",
    branch: "main",
    replicas: 1,
    env_vars: [] as { key: string; value: string; secret: boolean }[],
  });

  const openEditModal = () => {
    const currentApp = app();
    if (currentApp) {
      setEditForm({
        domain: currentApp.domain || "",
        port: currentApp.port,
        github_url: currentApp.github_url,
        branch: currentApp.branch,
        replicas: currentApp.services?.[0]?.replicas || 1,
        env_vars: currentApp.env_vars
          ? currentApp.env_vars.map((e) => ({ ...e }))
          : [],
      });
      setBulkEditEnv(false);
      setEditing(true);
    }
  };

  // convert env vars to bulk text format
  const envVarsToBulkText = (
    vars: { key: string; value: string; secret: boolean }[],
  ) => {
    return vars.map((v) => `${v.key}=${v.value}`).join("\n");
  };

  // convert bulk text to env vars array
  const bulkTextToEnvVars = (text: string) => {
    return text
      .split("\n")
      .filter((line) => line.trim() && line.includes("="))
      .map((line) => {
        const idx = line.indexOf("=");
        return {
          key: line.substring(0, idx).trim(),
          value: line.substring(idx + 1).trim(),
          secret: false,
        };
      });
  };

  // toggle bulk edit mode
  const toggleBulkEdit = () => {
    if (bulkEditEnv()) {
      // switching from bulk to individual - parse the text
      setEditForm((prev) => ({
        ...prev,
        env_vars: bulkTextToEnvVars(bulkEnvText()),
      }));
    } else {
      // switching to bulk - convert vars to text
      setBulkEnvText(envVarsToBulkText(editForm().env_vars));
    }
    setBulkEditEnv(!bulkEditEnv());
  };

  // deploy from docker image
  const deployFromImage = async () => {
    const imageName = imageNameInput().trim();
    if (!imageName) return;

    setDeployingImage(true);
    try {
      await apiPost(`/api/apps/${params.id}/deployments`, { image: imageName });

      setImageNameInput("");
      refetchDeployments();
    } catch (err) {
      console.error(err);
    } finally {
      setDeployingImage(false);
    }
  };

  const updateApp = async () => {
    setSaving(true);
    try {
      const form = editForm();
      const { error } = await api.PUT("/api/apps/{id}", {
        params: { path: { id: params.id! } },
        body: {
          domain: form.domain || null,
          port: form.port,
          github_url: form.github_url,
          branch: form.branch,
          env_vars: bulkEditEnv()
            ? bulkTextToEnvVars(bulkEnvText())
            : form.env_vars,
          services: [
            {
              name: "web",
              port: form.port,
              replicas: form.replicas,
            },
          ],
        },
      });
      if (error) throw error;

      setEditing(false);
      refetchApp();
      refetchCertificate();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  // Logs state
  const [logs, setLogs] = createSignal<string[]>([]);
  const [logsConnected, setLogsConnected] = createSignal(false);
  const [showLogs, setShowLogs] = createSignal(false);
  let logsSocket: WebSocket | null = null;
  let logsRef: HTMLDivElement | undefined;

  const connectLogs = () => {
    if (typeof window === "undefined") return;

    try {
      if (logsSocket) {
        logsSocket.close();
      }

      setLogs([]);
      setLogsConnected(false);

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/apps/${params.id}/logs/ws?tail=100`;

      setLogs(["connecting..."]);

      logsSocket = new WebSocket(wsUrl);

      logsSocket.onopen = () => {
        setLogsConnected(true);
        setLogs((prev) => [...prev, "[connected]"]);
      };

      logsSocket.onmessage = (event) => {
        setLogs((prev) => [...prev, event.data]);
        if (logsRef) {
          logsRef.scrollTop = logsRef.scrollHeight;
        }
      };

      logsSocket.onclose = (event) => {
        setLogsConnected(false);
        setLogs((prev) => [...prev, `[disconnected: ${event.code}]`]);
      };

      logsSocket.onerror = () => {
        setLogsConnected(false);
        setLogs((prev) => [...prev, "[error]"]);
      };
    } catch (err) {
      setLogsConnected(false);
      setLogs([`error: ${err}`]);
    }
  };

  const disconnectLogs = () => {
    if (logsSocket) {
      logsSocket.close();
      logsSocket = null;
    }
    setLogsConnected(false);
  };

  const toggleLogs = () => {
    if (showLogs()) {
      disconnectLogs();
      setShowLogs(false);
    } else {
      setShowLogs(true);
      connectLogs();
    }
  };

  // fetch historical deployment logs
  const fetchDeploymentLogs = async (deploymentId: string) => {
    setDeploymentLogsLoading(true);
    try {
      const logs = await apiGet<string[]>(
        `/api/apps/${params.id}/deployments/${deploymentId}/logs`,
      );
      setDeploymentLogs(logs);
    } catch (err) {
      console.error(err);
      setDeploymentLogs(["error fetching logs"]);
    } finally {
      setDeploymentLogsLoading(false);
    }
  };

  // connect to live deployment logs
  const connectDeploymentLogs = (deploymentId: string) => {
    if (typeof window === "undefined") return;

    try {
      if (deploymentLogsSocket) {
        deploymentLogsSocket.close();
      }

      setDeploymentLogsConnected(false);

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/apps/${params.id}/deployments/${deploymentId}/logs/ws`;

      deploymentLogsSocket = new WebSocket(wsUrl);

      deploymentLogsSocket.onopen = () => {
        setDeploymentLogsConnected(true);
        setDeploymentLogs((prev) => [...prev, "[live connection established]"]);
      };

      deploymentLogsSocket.onmessage = (event) => {
        setDeploymentLogs((prev) => [...prev, event.data]);
        if (deploymentLogsRef) {
          deploymentLogsRef.scrollTop = deploymentLogsRef.scrollHeight;
        }
      };

      deploymentLogsSocket.onclose = () => {
        setDeploymentLogsConnected(false);
      };

      deploymentLogsSocket.onerror = () => {
        setDeploymentLogsConnected(false);
      };
    } catch (err) {
      setDeploymentLogsConnected(false);
    }
  };

  const openDeploymentLogs = async (deployment: Deployment) => {
    setSelectedDeployment(deployment);
    setDeploymentLogs([]);
    await fetchDeploymentLogs(deployment.id);

    // connect live logs for running deployments
    if (
      ["pending", "cloning", "building", "starting"].includes(deployment.status)
    ) {
      connectDeploymentLogs(deployment.id);
    }
  };

  const closeDeploymentLogs = () => {
    if (deploymentLogsSocket) {
      deploymentLogsSocket.close();
      deploymentLogsSocket = null;
    }
    setSelectedDeployment(null);
    setDeploymentLogs([]);
    setDeploymentLogsConnected(false);
  };

  const triggerDeploy = async () => {
    setDeploying(true);
    try {
      await apiPost(`/api/apps/${params.id}/deployments`);

      refetchDeployments();
    } catch (err) {
      console.error(err);
    } finally {
      setDeploying(false);
    }
  };

  const deleteApp = async () => {
    if (!confirm("are you sure you want to delete this app?")) {
      return;
    }

    setDeleting(true);
    try {
      const { error } = await api.DELETE("/api/apps/{id}", {
        params: { path: { id: params.id! } },
      });
      if (error) throw error;

      navigate("/");
    } catch (err) {
      console.error(err);
      setDeleting(false);
    }
  };

  const statusIndicator = (status: string) => {
    switch (status) {
      case "running":
        return "bg-black";
      case "pending":
      case "cloning":
      case "building":
      case "starting":
        return "bg-neutral-400 animate-pulse";
      case "failed":
        return "bg-neutral-300";
      case "stopped":
        return "bg-neutral-200";
      default:
        return "bg-neutral-200";
    }
  };

  return (
    <div>
      {/* loading */}
      <Show when={app.loading}>
        <div class="animate-pulse">
          <div class="h-7 bg-neutral-100 w-1/4 mb-3"></div>
          <div class="h-4 bg-neutral-50 w-1/2 mb-10"></div>
          <div class="border border-neutral-200 p-8">
            <div class="h-5 bg-neutral-100 w-full mb-4"></div>
            <div class="h-5 bg-neutral-50 w-3/4"></div>
          </div>
        </div>
      </Show>

      {/* content */}
      <Show when={!app.loading && app()}>
        {/* header */}
        <div class="flex justify-between items-start mb-10">
          <div>
            <h1 class="text-2xl font-serif text-black">{app()!.name}</h1>
            <p class="text-neutral-500 mt-1 text-sm font-mono">
              {app()!.github_url}
            </p>
          </div>
          <div class="flex gap-2">
            <button
              onClick={openEditModal}
              class="px-3 py-1.5 border border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400 transition-colors text-sm"
            >
              settings
            </button>
            <button
              onClick={toggleLogs}
              class={`px-3 py-1.5 border transition-colors text-sm ${showLogs() ? "border-black text-black" : "border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400"}`}
            >
              {showLogs() ? "hide logs" : "logs"}
            </button>
            <button
              onClick={triggerDeploy}
              disabled={deploying()}
              class="px-3 py-1.5 bg-black text-white hover:bg-neutral-800 disabled:opacity-50 transition-colors text-sm"
            >
              {deploying() ? "deploying..." : "deploy"}
            </button>
            <button
              onClick={deleteApp}
              disabled={deleting()}
              class="px-3 py-1.5 border border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-400 disabled:opacity-50 transition-colors text-sm"
            >
              {deleting() ? "deleting..." : "delete"}
            </button>
          </div>
        </div>

        {/* info grid */}
        <div class="grid grid-cols-4 gap-px bg-neutral-200 mb-8">
          {/* status */}
          <div class="bg-white p-5">
            <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">
              status
            </h3>
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 bg-black"></span>
              <span class="text-black text-sm">running</span>
            </div>
          </div>

          {/* domain */}
          <div class="bg-white p-5">
            <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">
              domain
            </h3>
            <Show
              when={app()!.domain}
              fallback={<span class="text-neutral-400 text-sm">n/a</span>}
            >
              <a
                href={`https://${app()!.domain}`}
                target="_blank"
                class="text-black text-sm hover:underline"
              >
                {app()!.domain}
              </a>
            </Show>
          </div>

          {/* branch */}
          <div class="bg-white p-5">
            <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">
              branch
            </h3>
            <span class="text-black text-sm font-mono">{app()!.branch}</span>
          </div>

          {/* certificate */}
          <div class="bg-white p-5">
            <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">
              ssl
            </h3>
            <Show when={certificate.loading}>
              <span class="text-neutral-400 text-sm">loading...</span>
            </Show>
            <Show when={!certificate.loading && certificate()}>
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <Show when={certificate()!.status === "valid"}>
                    <span class="w-2 h-2 bg-black"></span>
                    <span class="text-black text-sm">valid</span>
                  </Show>
                  <Show when={certificate()!.status === "expiringsoon"}>
                    <span class="w-2 h-2 bg-neutral-400"></span>
                    <span class="text-neutral-600 text-sm">expiring</span>
                  </Show>
                  <Show when={certificate()!.status === "expired"}>
                    <span class="w-2 h-2 bg-neutral-300"></span>
                    <span class="text-neutral-500 text-sm">expired</span>
                  </Show>
                  <Show when={certificate()!.status === "pending"}>
                    <span class="w-2 h-2 bg-neutral-400 animate-pulse"></span>
                    <span class="text-neutral-500 text-sm">pending</span>
                  </Show>
                  <Show when={certificate()!.status === "failed"}>
                    <span class="w-2 h-2 bg-neutral-300"></span>
                    <span class="text-neutral-500 text-sm">failed</span>
                  </Show>
                  <Show when={certificate()!.status === "none"}>
                    <span class="text-neutral-400 text-sm">
                      {app()!.domain ? "awaiting issuance" : "n/a"}
                    </span>
                  </Show>
                </div>
                <Show
                  when={app()!.domain && certificate()!.status !== "pending"}
                >
                  <button
                    onClick={reissueCertificate}
                    disabled={reissuing()}
                    class="text-xs text-neutral-500 hover:text-black disabled:opacity-50"
                  >
                    {reissuing() ? "..." : "reissue"}
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        </div>

        {/* services section for multi-container apps */}
        <Show when={app()!.services && app()!.services.length > 0}>
          <div class="border border-neutral-200 mb-8">
            <div class="border-b border-neutral-200 px-5 py-3">
              <h2 class="text-sm font-serif text-black">services</h2>
            </div>
            <div class="divide-y divide-neutral-100">
              <For each={app()!.services}>
                {(service) => (
                  <div class="px-5 py-4">
                    <div class="flex justify-between items-start">
                      <div>
                        <div class="flex items-center gap-3">
                          <span class="w-2 h-2 bg-black"></span>
                          <span class="text-black text-sm font-medium">
                            {service.name}
                          </span>
                          <span class="text-xs text-neutral-400">
                            :{service.port}
                          </span>
                        </div>
                        <Show when={service.image}>
                          <p class="text-xs text-neutral-500 mt-1 ml-5 font-mono">
                            {service.image}
                          </p>
                        </Show>
                      </div>
                      <div class="flex items-center gap-4 text-xs text-neutral-500">
                        <span>
                          {service.replicas} replica
                          {service.replicas > 1 ? "s" : ""}
                        </span>
                        <Show when={service.memory_limit_mb}>
                          <span>{service.memory_limit_mb}mb</span>
                        </Show>
                        <Show when={service.depends_on.length > 0}>
                          <span>→ {service.depends_on.join(", ")}</span>
                        </Show>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* logs panel */}
        <Show when={showLogs()}>
          <div class="border border-neutral-200 mb-8">
            <div class="border-b border-neutral-200 px-5 py-3 flex justify-between items-center">
              <div class="flex items-center gap-3">
                <h2 class="text-sm font-serif text-black">container logs</h2>
                <div class="flex items-center gap-2">
                  <span
                    class={`w-1.5 h-1.5 ${logsConnected() ? "bg-black" : "bg-neutral-300"}`}
                  ></span>
                  <span class="text-xs text-neutral-500">
                    {logsConnected() ? "live" : "disconnected"}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setLogs([])}
                class="text-xs text-neutral-500 hover:text-black"
              >
                clear
              </button>
            </div>
            <div
              ref={logsRef}
              class="p-4 h-72 overflow-y-auto font-mono text-xs bg-neutral-50"
            >
              <Show when={logs().length === 0}>
                <p class="text-neutral-400">
                  {logsConnected() ? "waiting for logs..." : "connecting..."}
                </p>
              </Show>
              <For each={logs()}>
                {(line) => (
                  <div
                    class="text-neutral-700 leading-relaxed whitespace-pre-wrap break-all"
                    innerHTML={parseAnsi(line)}
                  ></div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* container monitor */}
        <div class="border border-neutral-200 mb-8">
          <div class="border-b border-neutral-200 px-5 py-3 flex items-center justify-between">
            <div>
              <h2 class="text-sm font-serif text-black">container monitor</h2>
              <p class="text-xs text-neutral-500 mt-1">
                health, metrics, logs, volumes
              </p>
            </div>
            <Show when={appContainers().length > 0}>
              <select
                value={selectedContainer()}
                onChange={(e) => setSelectedContainer(e.currentTarget.value)}
                class="px-2 py-1.5 border border-neutral-300 text-xs text-neutral-700"
              >
                <For each={appContainers()}>
                  {(container) => (
                    <option value={container.id}>{container.name}</option>
                  )}
                </For>
              </select>
            </Show>
          </div>
          <div class="p-5">
            <Show when={appContainers().length > 0}>
              <ContainerMonitor containerId={selectedContainer()} />
            </Show>
            <Show when={appContainers().length === 0}>
              <div class="border border-dashed border-neutral-200 p-8 text-center text-neutral-400 text-sm">
                no running containers for this app
              </div>
            </Show>
          </div>
        </div>

        {/* deploy via image */}
        <div class="border border-neutral-200 mb-8">
          <div class="border-b border-neutral-200 px-5 py-3">
            <h2 class="text-sm font-serif text-black">deploy via image name</h2>
            <p class="text-xs text-neutral-500 mt-1">
              deploy directly from a docker image
            </p>
          </div>
          <div class="p-5">
            <div class="flex gap-2">
              <input
                type="text"
                value={imageNameInput()}
                onInput={(e) => setImageNameInput(e.currentTarget.value)}
                placeholder="nginxdemos/hello:latest"
                class="flex-1 px-3 py-2 bg-neutral-900 border border-neutral-700 text-white focus:border-neutral-400 focus:outline-none text-sm font-mono"
              />
              <button
                onClick={deployFromImage}
                disabled={deployingImage() || !imageNameInput().trim()}
                class="px-4 py-2 bg-neutral-700 text-white hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                {deployingImage() ? "deploying..." : "deploy now"}
              </button>
            </div>
          </div>
        </div>

        {/* deployments */}
        <div class="border border-neutral-200">
          <div class="border-b border-neutral-200 px-5 py-3">
            <h2 class="text-sm font-serif text-black">deployments</h2>
          </div>

          <Show when={deployments.loading}>
            <div class="p-5 animate-pulse space-y-3">
              <div class="h-10 bg-neutral-50"></div>
              <div class="h-10 bg-neutral-50"></div>
            </div>
          </Show>

          <Show when={!deployments.loading && deployments()?.length === 0}>
            <div class="p-8 text-center text-neutral-400 text-sm">
              no deployments yet
            </div>
          </Show>

          <Show
            when={
              !deployments.loading && deployments() && deployments()!.length > 0
            }
          >
            <div class="divide-y divide-neutral-200">
              <For each={deployments()}>
                {(deployment) => (
                  <div class="px-5 py-4 flex items-center justify-between">
                    <div class="flex items-center gap-4">
                      <span
                        class={`w-2 h-2 ${statusIndicator(deployment.status)}`}
                      ></span>
                      <div>
                        <p class="text-black font-mono text-sm">
                          {deployment.commit_sha.substring(0, 8)}
                        </p>
                        <p class="text-neutral-500 text-xs mt-0.5 truncate max-w-md">
                          {deployment.commit_message || "no message"}
                        </p>
                      </div>
                    </div>
                    <div class="flex items-center gap-4 text-xs">
                      <span class="text-neutral-500">{deployment.status}</span>
                      <span class="text-neutral-400">
                        {new Date(deployment.created_at).toLocaleString()}
                      </span>
                      <button
                        onClick={() => openDeploymentLogs(deployment)}
                        class="px-2 py-1 border border-neutral-300 text-neutral-600 hover:text-black hover:border-neutral-400 transition-colors"
                      >
                        logs
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* edit modal */}
      <Show when={editing()}>
        <div class="fixed inset-0 bg-white/90 flex items-center justify-center z-50">
          <div class="bg-white border border-neutral-300 w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div class="border-b border-neutral-200 px-6 py-4 flex justify-between items-center">
              <h2 class="text-lg font-serif text-black">app settings</h2>
              <button
                onClick={() => setEditing(false)}
                class="text-neutral-400 hover:text-black"
              >
                <svg
                  class="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div class="flex-1 overflow-y-auto p-6 space-y-6">
              {/* domain section */}
              <section class="border border-neutral-200 p-4">
                <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-4">
                  http settings
                </h3>

                <Show when={editForm().domain || app()?.domain}>
                  <div class="mb-4">
                    <p class="text-xs text-neutral-500 mb-2">
                      your app is publicly available at:
                    </p>
                    <div class="flex items-center gap-2 p-2 border border-neutral-200 bg-neutral-50">
                      <Show when={certificate()?.status === "valid"}>
                        <span class="px-2 py-0.5 text-xs border border-neutral-300 text-neutral-600">
                          https
                        </span>
                      </Show>
                      <Show when={certificate()?.status !== "valid"}>
                        <button
                          onClick={reissueCertificate}
                          disabled={reissuing()}
                          class="px-2 py-0.5 text-xs border border-neutral-400 text-neutral-700 hover:border-black hover:text-black disabled:opacity-50"
                        >
                          {reissuing() ? "..." : "enable https"}
                        </button>
                      </Show>
                      <a
                        href={`https://${editForm().domain || app()?.domain}`}
                        target="_blank"
                        class="text-sm text-blue-600 hover:underline font-mono"
                      >
                        {editForm().domain || app()?.domain}
                      </a>
                    </div>
                  </div>
                </Show>

                <div class="flex gap-2">
                  <input
                    type="text"
                    value={editForm().domain}
                    onInput={(e) =>
                      setEditForm((prev) => ({
                        ...prev,
                        domain: e.currentTarget.value,
                      }))
                    }
                    placeholder="your-custom-domain.com"
                    class="flex-1 px-3 py-2 bg-neutral-900 border border-neutral-700 text-white focus:border-neutral-400 focus:outline-none text-sm font-mono"
                  />
                  <button
                    type="button"
                    class="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 text-sm"
                  >
                    connect new domain
                  </button>
                </div>
                <p class="text-xs text-neutral-400 mt-2">
                  point your domain's dns to this server, then connect it above
                </p>
              </section>

              {/* source settings */}
              <section class="border border-neutral-200 p-4">
                <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-4">
                  source
                </h3>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label class="block text-xs text-neutral-500 mb-2">
                      github url
                    </label>
                    <input
                      type="text"
                      value={editForm().github_url}
                      onInput={(e) =>
                        setEditForm((prev) => ({
                          ...prev,
                          github_url: e.currentTarget.value,
                        }))
                      }
                      class="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 text-white focus:border-neutral-400 focus:outline-none text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-neutral-500 mb-2">
                      branch
                    </label>
                    <input
                      type="text"
                      value={editForm().branch}
                      onInput={(e) =>
                        setEditForm((prev) => ({
                          ...prev,
                          branch: e.currentTarget.value,
                        }))
                      }
                      class="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 text-white focus:border-neutral-400 focus:outline-none text-sm font-mono"
                    />
                  </div>
                </div>
              </section>

              {/* environment variables */}
              <section class="border border-neutral-200 p-4">
                <div class="flex justify-between items-center mb-4">
                  <h3 class="text-xs text-neutral-500 uppercase tracking-wider">
                    environment variables
                  </h3>
                  <div class="flex items-center gap-3">
                    <label class="flex items-center gap-2 cursor-pointer text-xs text-neutral-500">
                      <span>bulk edit</span>
                      <button
                        type="button"
                        onClick={toggleBulkEdit}
                        class={`relative w-8 h-4 transition-colors ${bulkEditEnv() ? "bg-blue-600" : "bg-neutral-300"}`}
                      >
                        <span
                          class={`absolute top-0.5 w-3 h-3 bg-white transition-transform ${bulkEditEnv() ? "translate-x-4" : "translate-x-0.5"}`}
                        />
                      </button>
                    </label>
                  </div>
                </div>

                <Show when={bulkEditEnv()}>
                  <textarea
                    value={bulkEnvText()}
                    onInput={(e) => setBulkEnvText(e.currentTarget.value)}
                    placeholder="KEY=value&#10;ANOTHER_KEY=another_value"
                    class="w-full h-32 px-3 py-2 bg-neutral-900 border border-neutral-700 text-white focus:border-neutral-400 focus:outline-none text-sm font-mono resize-none"
                  />
                  <p class="text-xs text-neutral-400 mt-2">
                    one variable per line, format: KEY=value
                  </p>
                </Show>

                <Show when={!bulkEditEnv()}>
                  <div class="space-y-2">
                    <For each={editForm().env_vars}>
                      {(env, i) => (
                        <div class="flex gap-2">
                          <input
                            type="text"
                            placeholder="key"
                            value={env.key}
                            onInput={(e) => {
                              const newVars = [...editForm().env_vars];
                              newVars[i()] = {
                                ...newVars[i()],
                                key: e.currentTarget.value,
                              };
                              setEditForm((prev) => ({
                                ...prev,
                                env_vars: newVars,
                              }));
                            }}
                            class="flex-1 px-3 py-2 bg-neutral-900 border border-neutral-700 text-white text-sm focus:border-neutral-400 focus:outline-none font-mono"
                          />
                          <input
                            type={env.secret ? "password" : "text"}
                            placeholder="value"
                            value={env.value}
                            onInput={(e) => {
                              const newVars = [...editForm().env_vars];
                              newVars[i()] = {
                                ...newVars[i()],
                                value: e.currentTarget.value,
                              };
                              setEditForm((prev) => ({
                                ...prev,
                                env_vars: newVars,
                              }));
                            }}
                            class="flex-[2] px-3 py-2 bg-neutral-900 border border-neutral-700 text-white text-sm focus:border-neutral-400 focus:outline-none font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const newVars = [...editForm().env_vars];
                              newVars[i()] = {
                                ...newVars[i()],
                                secret: !newVars[i()].secret,
                              };
                              setEditForm((prev) => ({
                                ...prev,
                                env_vars: newVars,
                              }));
                            }}
                            class={`px-2 py-1 text-xs border ${env.secret ? "border-blue-500 text-blue-500" : "border-neutral-600 text-neutral-500"}`}
                            title="toggle secret"
                          >
                            🔒
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const newVars = [...editForm().env_vars];
                              newVars.splice(i(), 1);
                              setEditForm((prev) => ({
                                ...prev,
                                env_vars: newVars,
                              }));
                            }}
                            class="px-2 py-1 text-neutral-500 hover:text-black border border-neutral-600"
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setEditForm((prev) => ({
                        ...prev,
                        env_vars: [
                          ...prev.env_vars,
                          { key: "", value: "", secret: false },
                        ],
                      }))
                    }
                    class="mt-3 px-3 py-1.5 border border-neutral-300 text-neutral-700 hover:border-black hover:text-black text-xs"
                  >
                    add key/value pair
                  </button>
                </Show>
              </section>

              {/* app config */}
              <section class="border border-neutral-200 p-4">
                <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-4">
                  app config
                </h3>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label class="block text-xs text-neutral-500 mb-2">
                      container port
                    </label>
                    <input
                      type="number"
                      value={editForm().port}
                      onInput={(e) =>
                        setEditForm((prev) => ({
                          ...prev,
                          port: parseInt(e.currentTarget.value) || 8080,
                        }))
                      }
                      class="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 text-white focus:border-neutral-400 focus:outline-none text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-neutral-500 mb-2">
                      instance count
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={editForm().replicas}
                      onInput={(e) =>
                        setEditForm((prev) => ({
                          ...prev,
                          replicas: parseInt(e.currentTarget.value) || 1,
                        }))
                      }
                      class="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 text-white focus:border-neutral-400 focus:outline-none text-sm font-mono"
                    />
                  </div>
                </div>
              </section>
            </div>

            <div class="border-t border-neutral-200 px-6 py-4 flex gap-2">
              <button
                onClick={() => setEditing(false)}
                class="flex-1 px-4 py-2 border border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400 transition-colors text-sm"
              >
                cancel
              </button>
              <button
                onClick={updateApp}
                disabled={saving()}
                class="flex-1 px-4 py-2 bg-black text-white hover:bg-neutral-800 disabled:opacity-50 transition-colors text-sm"
              >
                {saving() ? "saving..." : "save changes"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* deployment logs modal */}
      <Show when={selectedDeployment()}>
        <div class="fixed inset-0 bg-white/90 flex items-center justify-center z-50">
          <div class="bg-white border border-neutral-300 w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div class="border-b border-neutral-200 px-6 py-4 flex justify-between items-center">
              <div>
                <h2 class="text-lg font-serif text-black">deployment logs</h2>
                <p class="text-xs text-neutral-500 mt-1 font-mono">
                  {selectedDeployment()!.commit_sha.substring(0, 8)} -{" "}
                  {selectedDeployment()!.status}
                </p>
              </div>
              <div class="flex items-center gap-4">
                <Show when={deploymentLogsConnected()}>
                  <div class="flex items-center gap-2">
                    <span class="w-1.5 h-1.5 bg-black"></span>
                    <span class="text-xs text-neutral-500">live</span>
                  </div>
                </Show>
                <button
                  onClick={closeDeploymentLogs}
                  class="text-neutral-400 hover:text-black"
                >
                  <svg
                    class="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <div
              ref={deploymentLogsRef}
              class="flex-1 p-4 overflow-y-auto font-mono text-xs bg-neutral-50 min-h-[300px] max-h-[60vh]"
            >
              <Show when={deploymentLogsLoading()}>
                <p class="text-neutral-400">loading logs...</p>
              </Show>
              <Show
                when={!deploymentLogsLoading() && deploymentLogs().length === 0}
              >
                <p class="text-neutral-400">no logs available</p>
              </Show>
              <For each={deploymentLogs()}>
                {(line) => (
                  <div
                    class="text-neutral-700 leading-relaxed whitespace-pre-wrap break-all"
                    innerHTML={parseAnsi(line)}
                  ></div>
                )}
              </For>
            </div>
            <div class="border-t border-neutral-200 px-6 py-3 flex justify-between items-center text-xs text-neutral-500">
              <div>
                <span>
                  started:{" "}
                  {new Date(selectedDeployment()!.created_at).toLocaleString()}
                </span>
                <Show when={selectedDeployment()!.finished_at}>
                  <span class="mx-2">|</span>
                  <span>
                    finished:{" "}
                    {new Date(
                      selectedDeployment()!.finished_at!,
                    ).toLocaleString()}
                  </span>
                </Show>
              </div>
              <button
                onClick={() => setDeploymentLogs([])}
                class="text-neutral-500 hover:text-black"
              >
                clear
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default AppDetail;
