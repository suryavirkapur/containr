import { A, useNavigate, useParams } from '@solidjs/router';
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from 'solid-js';
import {
  getService,
  getServiceDeployment,
  getServiceLogs,
  getServiceSettings,
  listServiceDeployments,
  rollbackServiceDeployment,
} from '../api/services';
import { LogViewer } from '../components/LogViewer';
import {
  EmptyBlock,
  KeyValueTable,
  LoadingBlock,
  Notice,
  Panel,
} from '../components/Plain';
import { StatusBadge } from '../components/StatusBadge';
import { type TabDef, Tabs } from '../components/Tabs';
import { useAppStore } from '../context/AppStore';
import { copyText, describeError, formatDateTime } from '../utils/format';
import { groupServices } from '../utils/service-groups';

const ESC_CODE = 27;
const ESC = String.fromCharCode(ESC_CODE);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '');

const useDeploymentLogStream = (
  serviceId: () => string,
  deploymentId: () => string | null,
) => {
  const [logs, setLogs] = createSignal<string[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(false);
  let ws: WebSocket | null = null;
  let lastDeploymentId: string | null = null;

  const connect = () => {
    const depId = deploymentId();
    const svcId = serviceId();
    if (!depId || !svcId) return;
    disconnect();
    lastDeploymentId = depId;
    setLogs([]);
    setIsStreaming(true);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const token = localStorage.getItem('containr_token');
    const url = `${protocol}//${host}/api/services/${svcId}/deployments/${depId}/logs/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    try {
      ws = new WebSocket(url);
      ws.onopen = () => setIsStreaming(true);
      ws.onmessage = (event: MessageEvent<string>) => {
        const line = stripAnsi(event.data);
        if (!line) return;
        setLogs((prev) => [...prev, line]);
      };
      ws.onerror = () => setIsStreaming(false);
      ws.onclose = () => {
        setIsStreaming(false);
        ws = null;
      };
    } catch {
      setIsStreaming(false);
    }
  };

  const disconnect = () => {
    if (ws) {
      ws.close();
      ws = null;
    }
    setIsStreaming(false);
  };

  createEffect(() => {
    const depId = deploymentId();
    if (depId && depId !== lastDeploymentId) connect();
  });

  onCleanup(() => disconnect());

  return { logs, isStreaming, connect, disconnect };
};

const endpointFor = (
  service: Awaited<ReturnType<typeof getService>>,
): string =>
  service.default_urls[0] ??
  service.proxy_connection_string ??
  service.connection_string ??
  (service.internal_host && service.port
    ? `${service.internal_host}:${service.port}`
    : 'internal only');

const MaskedValue = (props: { value: string }) => {
  const [shown, setShown] = createSignal(false);
  return (
    <span class="inline-flex items-center gap-2 font-mono text-sm">
      <span class={shown() ? '' : 'blur-sm select-none pointer-events-none'}>
        {props.value}
      </span>
      <button
        type="button"
        class="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
        onClick={() => setShown((v) => !v)}
      >
        {shown() ? 'hide' : 'reveal'}
      </button>
    </span>
  );
};

const ServiceDetail = () => {
  const params = useParams();
  const navigate = useNavigate();
  const store = useAppStore();
  const serviceId = () => params.id ?? '';

  const [activeTab, setActiveTab] = createSignal('networking');
  const [feedback, setFeedback] = createSignal<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);
  const [selectedDeploymentId, setSelectedDeploymentId] = createSignal<
    string | null
  >(null);

  const [deployBranch, setDeployBranch] = createSignal('');
  const [deployCommitSha, setDeployCommitSha] = createSignal('');
  const [deployCommitMessage, setDeployCommitMessage] = createSignal('');
  const [deployRolloutStrategy, setDeployRolloutStrategy] = createSignal('');

  const [envVars, setEnvVars] = createSignal<
    Array<{
      key: string;
      value: string;
      secret: boolean;
      isNew?: boolean;
      isEdited?: boolean;
    }>
  >([]);
  const [bulkEditMode, setBulkEditMode] = createSignal(false);
  const [bulkEditText, setBulkEditText] = createSignal('');
  const [newEnvKey, setNewEnvKey] = createSignal('');
  const [newEnvValue, setNewEnvValue] = createSignal('');
  const [newEnvSecret, setNewEnvSecret] = createSignal(false);
  const [showAddEnv, setShowAddEnv] = createSignal(false);

  const [autoDeployEnabled, setAutoDeployEnabled] = createSignal(false);
  const [watchPathsText, setWatchPathsText] = createSignal('');

  const [httpEnabled, setHttpEnabled] = createSignal(true);
  const [customDomains, setCustomDomains] = createSignal<string[]>([]);
  const [httpOnlyDomains, setHttpOnlyDomains] = createSignal<string[]>([]);
  const [newDomain, setNewDomain] = createSignal('');

  const [targetGroupId, setTargetGroupId] = createSignal<string | null>(null);

  const [serviceJson, setServiceJson] = createSignal('{}');
  const [replicas, setReplicas] = createSignal('1');

  const isAppService = () => {
    const s = service();
    if (!s) return true;
    const t = s.service_type.toLowerCase();
    return ![
      'postgres',
      'redis',
      'mariadb',
      'qdrant',
      'rabbitmq',
      'postgresql',
      'qdrantmq',
    ].includes(t);
  };

  const [service, { refetch: refetchService }] = createResource(
    serviceId,
    getService,
  );
  const [settings, { refetch: refetchSettings }] = createResource(
    () => (serviceId() && isAppService() ? serviceId() : null),
    (id) => (id ? getServiceSettings(id) : Promise.resolve(null)),
  );
  const [logs, { refetch: refetchLogs }] = createResource(serviceId, (id) =>
    getServiceLogs(id, 300),
  );
  const [deployments, { refetch: refetchDeployments }] = createResource(
    () => (serviceId() && isAppService() ? serviceId() : null),
    (id) => (id ? listServiceDeployments(id) : Promise.resolve([])),
  );
  const [selectedDeployment, { refetch: refetchSelectedDeployment }] =
    createResource(
      () => ({
        currentServiceId: serviceId(),
        deploymentId: selectedDeploymentId(),
      }),
      ({ currentServiceId, deploymentId }) =>
        deploymentId
          ? getServiceDeployment(currentServiceId, deploymentId)
          : Promise.resolve(null),
    );
  const deploymentLogStream = useDeploymentLogStream(
    serviceId,
    selectedDeploymentId,
  );

  // Groups for "move to project" picker
  const availableGroups = () => {
    const all = groupServices(store.state.services);
    return all.filter((g) => g.id !== null && g.id !== service()?.group_id);
  };

  const tabs = (): TabDef[] => [
    { id: 'networking', label: 'Networking' },
    ...(isAppService()
      ? [
          { id: 'appconfigs', label: 'App Configs' },
          { id: 'deployment', label: 'Deployment' },
        ]
      : []),
    { id: 'logs', label: 'Logs' },
  ];

  createEffect(() => {
    const s = settings();
    if (!s) return;
    setDeployBranch(s.branch);
    setDeployRolloutStrategy(s.rollout_strategy);
    setAutoDeployEnabled(s.auto_deploy.enabled);
    setWatchPathsText(s.auto_deploy.watch_paths.join('\n'));
    setServiceJson(JSON.stringify(s.service, null, 2));
    setReplicas(String(s.service.replicas ?? 1));
    setEnvVars(s.env_vars.map((e) => ({ ...e, isNew: false, isEdited: false })));
    setBulkEditText(s.env_vars.map((e) => `${e.key}=${e.value}`).join('\n'));
    setHttpEnabled(s.service.expose_http);
    setCustomDomains(s.service.domains ?? []);
    setHttpOnlyDomains(
      (s.service as { http_only_domains?: string[] }).http_only_domains ?? [],
    );
  });

  createEffect(() => {
    const rows = deployments();
    if (!rows || rows.length === 0) return;
    if (!selectedDeploymentId()) setSelectedDeploymentId(rows[0].id);
  });

  createEffect(() => {
    if (activeTab() !== 'deployment') return;
    const interval = setInterval(() => {
      void refetchDeployments();
      void refetchSelectedDeployment();
    }, 5000);
    onCleanup(() => clearInterval(interval));
  });

  const refreshAll = async () => {
    await Promise.all([
      refetchService(),
      refetchSettings(),
      refetchLogs(),
      refetchDeployments(),
      refetchSelectedDeployment(),
      store.loadServices(),
    ]);
  };

  const runAction = async (action: 'start' | 'stop' | 'restart') => {
    setPendingAction(action);
    setFeedback(null);
    try {
      await store.runAction(serviceId(), action);
      setFeedback({ tone: 'success', text: `${action} accepted` });
      setPendingAction(null);
      void refreshAll();
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
      setPendingAction(null);
    }
  };

  const deploy = async () => {
    setPendingAction('deploy');
    setFeedback(null);
    try {
      await store.triggerDeploy(serviceId(), {
        branch: deployBranch().trim() || null,
        commit_sha: deployCommitSha().trim() || null,
        commit_message: deployCommitMessage().trim() || null,
        rollout_strategy: deployRolloutStrategy().trim() || null,
      });
      setFeedback({ tone: 'success', text: 'deployment queued' });
      setPendingAction(null);
      void refreshAll();
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
      setPendingAction(null);
    }
  };

  const rollback = async (deploymentId: string) => {
    setPendingAction(`rollback-${deploymentId}`);
    setFeedback(null);
    try {
      await rollbackServiceDeployment(serviceId(), deploymentId, {});
      setFeedback({ tone: 'success', text: 'rollback queued' });
      setPendingAction(null);
      void refreshAll();
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
      setPendingAction(null);
    }
  };

  const saveAppConfigs = async () => {
    setPendingAction('save-appconfigs');
    setFeedback(null);
    try {
      let finalEnvVars: Array<{ key: string; value: string; secret: boolean }> =
        [];
      if (bulkEditMode()) {
        finalEnvVars = bulkEditText()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [key, ...rest] = l.split('=');
            return { key: key.trim(), value: rest.join('=').trim(), secret: false };
          });
      } else {
        finalEnvVars = envVars()
          .filter((e) => !e.isNew || e.key.trim())
          .map(({ key, value, secret }) => ({ key: key.trim(), value, secret }));
      }

      const parsedService = JSON.parse(serviceJson());
      parsedService.replicas = Math.max(
        1,
        Number.parseInt(replicas().trim(), 10) || 1,
      );

      await store.updateService(serviceId(), {
        env_vars: finalEnvVars,
        auto_deploy: {
          enabled: autoDeployEnabled(),
          watch_paths: watchPathsText()
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        },
        service: parsedService,
      });
      setFeedback({ tone: 'success', text: 'saved' });
      setPendingAction(null);
      void refreshAll();
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
      setPendingAction(null);
    }
  };

  const saveNetworkingSettings = async () => {
    setPendingAction('save-networking');
    setFeedback(null);
    try {
      const parsedService = JSON.parse(serviceJson());
      parsedService.expose_http = httpEnabled();
      parsedService.domains = customDomains().filter(Boolean);
      parsedService.http_only_domains = httpOnlyDomains().filter((d) =>
        customDomains().includes(d),
      );

      const body: Parameters<typeof store.updateService>[1] = {
        service: parsedService,
      };

      // Move to different project if selected
      const gid = targetGroupId();
      if (gid !== null) {
        (body as Record<string, unknown>).group_id = gid;
      }

      await store.updateService(serviceId(), body);
      setFeedback({ tone: 'success', text: 'networking settings saved' });
      setTargetGroupId(null);
      setPendingAction(null);
      void refreshAll();
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
      setPendingAction(null);
    }
  };

  const addEnvVar = () => {
    if (!newEnvKey().trim()) return;
    setEnvVars((prev) => [
      ...prev,
      {
        key: newEnvKey().trim(),
        value: newEnvValue(),
        secret: newEnvSecret(),
        isNew: true,
        isEdited: true,
      },
    ]);
    setNewEnvKey('');
    setNewEnvValue('');
    setNewEnvSecret(false);
    setShowAddEnv(false);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  };

  const updateEnvVar = (
    index: number,
    field: 'key' | 'value' | 'secret',
    value: string | boolean,
  ) => {
    setEnvVars((prev) =>
      prev.map((e, i) =>
        i === index ? { ...e, [field]: value, isEdited: true } : e,
      ),
    );
  };

  const removeService = async () => {
    if (!confirm('delete this service?')) return;
    setPendingAction('delete');
    setFeedback(null);
    try {
      await store.removeService(serviceId());
      navigate('/services');
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
      setPendingAction(null);
    }
  };

  const addCustomDomain = () => {
    const domain = newDomain().trim();
    if (!domain || customDomains().includes(domain)) return;
    setCustomDomains((prev) => [...prev, domain]);
    setNewDomain('');
  };

  const removeCustomDomain = (domain: string) => {
    setCustomDomains((prev) => prev.filter((d) => d !== domain));
    setHttpOnlyDomains((prev) => prev.filter((d) => d !== domain));
  };

  const domainHttpsEnabled = (domain: string) =>
    !httpOnlyDomains().includes(domain);

  const setDomainHttpsEnabled = (domain: string, enabled: boolean) => {
    if (enabled) {
      setHttpOnlyDomains((prev) => prev.filter((d) => d !== domain));
      return;
    }
    setHttpOnlyDomains((prev) =>
      prev.includes(domain) ? prev : [...prev, domain],
    );
  };

  return (
    <div class="flex flex-col gap-6">
      {/* Back link */}
      <A
        href="/services"
        class="text-xs text-muted-foreground hover:text-foreground w-fit"
      >
        ← Services
      </A>

      <Show when={service.loading}>
        <LoadingBlock message="Loading service..." />
      </Show>
      <Show when={service.error}>
        {(error) => (
          <Notice tone="error">
            Failed to load: {describeError(error())}
          </Notice>
        )}
      </Show>

      <Show when={service()}>
        {(currentService) => (
          <>
            {/* Header */}
            <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div class="flex flex-col gap-1">
                <div class="flex items-center gap-2">
                  <h1 class="text-2xl font-semibold tracking-tight">
                    {currentService().name}
                  </h1>
                  <StatusBadge status={currentService().status} />
                </div>
                <p class="text-sm text-muted-foreground">
                  {currentService().service_type.replace(/_/g, ' ')}
                  {currentService().project_name
                    ? ` · ${currentService().project_name}`
                    : ''}
                </p>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => void runAction('start')}
                  disabled={
                    pendingAction() === 'start' ||
                    currentService().status === 'running'
                  }
                  class="cr-btn cr-btn-secondary"
                >
                  Start
                </button>
                <button
                  type="button"
                  onClick={() => void runAction('stop')}
                  disabled={
                    pendingAction() === 'stop' ||
                    currentService().status === 'stopped'
                  }
                  class="cr-btn cr-btn-secondary"
                >
                  Stop
                </button>
                <button
                  type="button"
                  onClick={() => void runAction('restart')}
                  disabled={pendingAction() === 'restart'}
                  class="cr-btn cr-btn-secondary"
                >
                  Restart
                </button>
                <button
                  type="button"
                  onClick={() => void refreshAll()}
                  class="cr-btn cr-btn-secondary"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void removeService()}
                  disabled={pendingAction() === 'delete'}
                  class="cr-btn cr-btn-danger"
                >
                  Delete
                </button>
              </div>
            </div>

            <Show when={feedback()}>
              <Notice tone={feedback()!.tone}>{feedback()!.text}</Notice>
            </Show>

            {/* Tabs */}
            <Tabs
              tabs={tabs()}
              activeTab={activeTab()}
              onTabChange={setActiveTab}
            >
              <Switch>
                {/* ——— NETWORKING TAB ——— */}
                <Match when={activeTab() === 'networking'}>
                  <div class="flex flex-col gap-4">
                    {/* Project assignment */}
                    <Panel title="Project">
                      <div class="flex flex-col gap-4">
                        <div class="flex items-center gap-3">
                          <span class="text-sm text-muted-foreground">
                            Current project:
                          </span>
                          <span class="text-sm font-medium">
                            {currentService().project_name ?? 'None (isolated)'}
                          </span>
                        </div>
                        <div class="flex flex-col gap-2">
                          <label class="cr-label">Move to project</label>
                          <div class="flex gap-2">
                            <select
                              class="cr-select max-w-xs"
                              value={targetGroupId() ?? ''}
                              onChange={(e) =>
                                setTargetGroupId(
                                  e.currentTarget.value || null,
                                )
                              }
                            >
                              <option value="">— keep current —</option>
                              <option value="__none__">
                                Remove from project (isolate)
                              </option>
                              <For each={availableGroups()}>
                                {(g) => (
                                  <option value={g.id!}>{g.label}</option>
                                )}
                              </For>
                            </select>
                          </div>
                          <p class="text-xs text-muted-foreground">
                            Services in the same project share an internal
                            Docker network.
                          </p>
                        </div>
                      </div>
                    </Panel>

                    <Show when={settings()}>
                      {(currentSettings) => (
                        <Panel
                          title="HTTP & Domains"
                          subtitle="Configure web access and domain routing"
                        >
                          <form
                            class="flex flex-col gap-6"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void saveNetworkingSettings();
                            }}
                          >
                            <label class="flex items-center gap-3 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={httpEnabled()}
                                onChange={(e) =>
                                  setHttpEnabled(e.currentTarget.checked)
                                }
                                class="h-4 w-4"
                              />
                              <span class="text-sm font-medium">
                                Enable HTTP
                              </span>
                            </label>

                            <Show when={currentService().default_urls[0]}>
                              <div class="flex flex-col gap-1">
                                <span class="cr-label">Default URL</span>
                                <a
                                  href={currentService().default_urls[0]}
                                  target="_blank"
                                  rel="noreferrer"
                                  class="text-sm font-mono hover:underline"
                                >
                                  {currentService().default_urls[0]}
                                </a>
                              </div>
                            </Show>

                            <div class="flex flex-col gap-3">
                              <span class="cr-label">Custom Domains</span>
                              <div class="flex gap-2">
                                <input
                                  class="cr-input max-w-xs"
                                  value={newDomain()}
                                  onInput={(e) =>
                                    setNewDomain(e.currentTarget.value)
                                  }
                                  placeholder="myapp.example.com"
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      addCustomDomain();
                                    }
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={addCustomDomain}
                                  class="cr-btn cr-btn-secondary"
                                >
                                  Add
                                </button>
                              </div>

                              <Show when={customDomains().length > 0}>
                                <table class="cr-table">
                                  <thead>
                                    <tr>
                                      <th>Domain</th>
                                      <th>HTTPS</th>
                                      <th></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <For each={customDomains()}>
                                      {(domain) => (
                                        <tr>
                                          <td class="font-mono text-xs">
                                            {domain}
                                          </td>
                                          <td>
                                            <label class="flex items-center gap-2 cursor-pointer">
                                              <input
                                                type="checkbox"
                                                checked={domainHttpsEnabled(
                                                  domain,
                                                )}
                                                onChange={(e) =>
                                                  setDomainHttpsEnabled(
                                                    domain,
                                                    e.currentTarget.checked,
                                                  )
                                                }
                                                class="h-4 w-4"
                                              />
                                              <span class="text-xs text-muted-foreground">
                                                {domainHttpsEnabled(domain)
                                                  ? 'Enabled'
                                                  : 'Disabled'}
                                              </span>
                                            </label>
                                          </td>
                                          <td class="text-right">
                                            <button
                                              type="button"
                                              onClick={() =>
                                                removeCustomDomain(domain)
                                              }
                                              class="text-xs text-muted-foreground hover:text-foreground"
                                            >
                                              Remove
                                            </button>
                                          </td>
                                        </tr>
                                      )}
                                    </For>
                                  </tbody>
                                </table>
                              </Show>
                              <p class="text-xs text-muted-foreground">
                                Point DNS A record to this server's IP or CNAME
                                the default URL.
                              </p>
                            </div>

                            <div class="flex gap-2 pt-2 border-t border-border">
                              <button
                                type="submit"
                                class="cr-btn cr-btn-primary"
                                disabled={pendingAction() === 'save-networking'}
                              >
                                Save Networking Settings
                              </button>
                            </div>
                          </form>
                        </Panel>
                      )}
                    </Show>

                    {/* Endpoint info for non-app services */}
                    <Show when={!isAppService() && currentService()}>
                      <Panel title="Connection">
                        <KeyValueTable
                          rows={[
                            [
                              'Endpoint',
                              <MaskedValue
                                value={endpointFor(currentService())}
                              />,
                            ],
                            [
                              'Internal host',
                              currentService().internal_host ?? '—',
                            ],
                            ['Port', String(currentService().port ?? '—')],
                          ]}
                        />
                      </Panel>
                    </Show>
                  </div>
                </Match>

                {/* ——— APP CONFIGS TAB ——— */}
                <Match when={activeTab() === 'appconfigs'}>
                  <Show
                    when={settings()}
                    fallback={<LoadingBlock message="Loading configs..." />}
                  >
                    {(currentSettings) => (
                      <div class="flex flex-col gap-4">
                        <Panel title="Scaling">
                          <div class="flex flex-col gap-3 max-w-xs">
                            <label class="cr-field">
                              <span class="cr-label">Instance Count</span>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                class="cr-input"
                                value={replicas()}
                                onInput={(e) =>
                                  setReplicas(e.currentTarget.value)
                                }
                              />
                            </label>
                            <p class="text-xs text-muted-foreground">
                              Running:{' '}
                              {currentService().running_instances} /{' '}
                              {replicas()} desired
                            </p>
                          </div>
                        </Panel>

                        <Panel
                          title="Environment Variables"
                          actions={
                            <Show when={!bulkEditMode()}>
                              <button
                                type="button"
                                onClick={() => setShowAddEnv(true)}
                                class="cr-btn cr-btn-secondary"
                              >
                                + Add
                              </button>
                            </Show>
                          }
                        >
                          <div class="flex flex-col gap-4">
                            <label class="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={bulkEditMode()}
                                onChange={(e) =>
                                  setBulkEditMode(e.currentTarget.checked)
                                }
                                class="h-3.5 w-3.5"
                              />
                              Bulk edit (KEY=VALUE)
                            </label>

                            <Show
                              when={bulkEditMode()}
                              fallback={
                                <div class="flex flex-col gap-3">
                                  <Show when={showAddEnv()}>
                                    <div class="flex items-end gap-2 p-3 border border-dashed border-border bg-secondary">
                                      <div class="cr-field flex-1">
                                        <span class="cr-label">Key</span>
                                        <input
                                          class="cr-input font-mono"
                                          value={newEnvKey()}
                                          onInput={(e) =>
                                            setNewEnvKey(e.currentTarget.value)
                                          }
                                          placeholder="MY_VAR"
                                        />
                                      </div>
                                      <div class="cr-field flex-1">
                                        <span class="cr-label">Value</span>
                                        <input
                                          class="cr-input font-mono"
                                          value={newEnvValue()}
                                          onInput={(e) =>
                                            setNewEnvValue(e.currentTarget.value)
                                          }
                                          placeholder="value"
                                        />
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => addEnvVar()}
                                        class="cr-btn cr-btn-primary"
                                      >
                                        Add
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setShowAddEnv(false)}
                                        class="cr-btn cr-btn-secondary"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </Show>

                                  <Show
                                    when={envVars().length > 0}
                                    fallback={
                                      <p class="text-xs text-muted-foreground text-center py-6 border border-dashed border-border">
                                        No environment variables
                                      </p>
                                    }
                                  >
                                    <table class="cr-table">
                                      <thead>
                                        <tr>
                                          <th class="w-8">Secret</th>
                                          <th>Key</th>
                                          <th>Value</th>
                                          <th class="w-16"></th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        <For each={envVars()}>
                                          {(env, index) => (
                                            <tr>
                                              <td>
                                                <input
                                                  type="checkbox"
                                                  checked={env.secret}
                                                  onChange={(e) =>
                                                    updateEnvVar(
                                                      index(),
                                                      'secret',
                                                      e.currentTarget.checked,
                                                    )
                                                  }
                                                  class="h-4 w-4"
                                                />
                                              </td>
                                              <td>
                                                <input
                                                  class="cr-input font-mono"
                                                  value={env.key}
                                                  onInput={(e) =>
                                                    updateEnvVar(
                                                      index(),
                                                      'key',
                                                      e.currentTarget.value,
                                                    )
                                                  }
                                                />
                                              </td>
                                              <td>
                                                <Show
                                                  when={env.secret}
                                                  fallback={
                                                    <input
                                                      class="cr-input font-mono"
                                                      value={env.value}
                                                      onInput={(e) =>
                                                        updateEnvVar(
                                                          index(),
                                                          'value',
                                                          e.currentTarget.value,
                                                        )
                                                      }
                                                    />
                                                  }
                                                >
                                                  <input
                                                    type="password"
                                                    class="cr-input font-mono"
                                                    value={env.value}
                                                    onInput={(e) =>
                                                      updateEnvVar(
                                                        index(),
                                                        'value',
                                                        e.currentTarget.value,
                                                      )
                                                    }
                                                  />
                                                </Show>
                                              </td>
                                              <td class="text-right">
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    removeEnvVar(index())
                                                  }
                                                  class="text-xs text-muted-foreground hover:text-foreground"
                                                >
                                                  Remove
                                                </button>
                                              </td>
                                            </tr>
                                          )}
                                        </For>
                                      </tbody>
                                    </table>
                                  </Show>
                                </div>
                              }
                            >
                              <div class="flex flex-col gap-2">
                                <textarea
                                  class="cr-textarea font-mono text-xs"
                                  value={bulkEditText()}
                                  onInput={(e) =>
                                    setBulkEditText(e.currentTarget.value)
                                  }
                                  placeholder={'MY_VAR=hello\nDEBUG=true'}
                                  style="min-height: 12rem"
                                />
                              </div>
                            </Show>

                            <div class="border-t border-border pt-4 flex gap-2">
                              <button
                                type="button"
                                onClick={() => void saveAppConfigs()}
                                disabled={
                                  pendingAction() === 'save-appconfigs'
                                }
                                class="cr-btn cr-btn-primary"
                              >
                                Save App Configs
                              </button>
                            </div>
                          </div>
                        </Panel>

                        <Panel title="Auto-Deploy & Webhooks">
                          <div class="flex flex-col gap-5">
                            <label class="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={autoDeployEnabled()}
                                onChange={(e) =>
                                  setAutoDeployEnabled(e.currentTarget.checked)
                                }
                                class="h-4 w-4"
                              />
                              <span class="text-sm font-medium">
                                Enable Auto-Deploy from Git
                              </span>
                            </label>

                            <div class="cr-field">
                              <span class="cr-label">Watch Paths</span>
                              <small class="text-xs text-muted-foreground">
                                One per line. Changes trigger deploy.
                              </small>
                              <textarea
                                class="cr-textarea font-mono"
                                value={watchPathsText()}
                                onInput={(e) =>
                                  setWatchPathsText(e.currentTarget.value)
                                }
                                placeholder={'src/\npackage.json'}
                              />
                            </div>

                            <KeyValueTable
                              rows={[
                                [
                                  'Webhook Path',
                                  <span class="font-mono break-all text-xs">
                                    {currentSettings().auto_deploy.webhook_path}
                                  </span>,
                                ],
                                [
                                  'Webhook Token',
                                  <span class="font-mono text-xs">
                                    {currentSettings().auto_deploy.webhook_token.slice(
                                      0,
                                      12,
                                    )}
                                    ...
                                  </span>,
                                ],
                              ]}
                            />
                            <div>
                              <button
                                type="button"
                                onClick={() =>
                                  void copyText(
                                    currentSettings().auto_deploy.webhook_token,
                                  )
                                }
                                class="cr-btn cr-btn-secondary"
                              >
                                Copy Token
                              </button>
                            </div>
                          </div>
                        </Panel>
                      </div>
                    )}
                  </Show>
                </Match>

                {/* ——— DEPLOYMENT TAB ——— */}
                <Match when={activeTab() === 'deployment'}>
                  <Show
                    when={settings()}
                    fallback={<LoadingBlock message="Loading deployment..." />}
                  >
                    {(currentSettings) => (
                      <div class="flex flex-col gap-4">
                        <Panel title="Deploy">
                          <div class="flex flex-col gap-4">
                            <div class="grid gap-4 sm:grid-cols-2">
                              <label class="cr-field">
                                <span class="cr-label">Branch</span>
                                <input
                                  class="cr-input"
                                  value={deployBranch()}
                                  onInput={(e) =>
                                    setDeployBranch(e.currentTarget.value)
                                  }
                                  placeholder="main"
                                />
                              </label>
                              <label class="cr-field">
                                <span class="cr-label">Rollout Strategy</span>
                                <select
                                  class="cr-select"
                                  value={deployRolloutStrategy()}
                                  onChange={(e) =>
                                    setDeployRolloutStrategy(
                                      e.currentTarget.value,
                                    )
                                  }
                                >
                                  <option value="stop_first">
                                    Stop First (default)
                                  </option>
                                  <option value="start_first">
                                    Start First
                                  </option>
                                </select>
                              </label>
                              <label class="cr-field">
                                <span class="cr-label">
                                  Commit SHA (optional)
                                </span>
                                <input
                                  class="cr-input font-mono"
                                  value={deployCommitSha()}
                                  onInput={(e) =>
                                    setDeployCommitSha(e.currentTarget.value)
                                  }
                                  placeholder="abc1234"
                                />
                              </label>
                              <label class="cr-field">
                                <span class="cr-label">Note (optional)</span>
                                <input
                                  class="cr-input"
                                  value={deployCommitMessage()}
                                  onInput={(e) =>
                                    setDeployCommitMessage(
                                      e.currentTarget.value,
                                    )
                                  }
                                  placeholder="Deployment note"
                                />
                              </label>
                            </div>
                            <div>
                              <button
                                type="button"
                                onClick={() => void deploy()}
                                disabled={pendingAction() === 'deploy'}
                                class="cr-btn cr-btn-primary"
                              >
                                Deploy Now
                              </button>
                            </div>
                          </div>
                        </Panel>

                        <Panel title="Port Info">
                          <KeyValueTable
                            rows={[
                              [
                                'Container Port',
                                String(currentSettings().service.port ?? '—'),
                              ],
                              [
                                'HTTP Exposed',
                                currentSettings().service.expose_http
                                  ? 'Yes'
                                  : 'No',
                              ],
                              [
                                'Additional Ports',
                                currentSettings().service.additional_ports.join(
                                  ', ',
                                ) || 'None',
                              ],
                              [
                                'Public Port',
                                String(
                                  currentService().external_port ?? 'None',
                                ),
                              ],
                            ]}
                          />
                        </Panel>

                        <Panel title="Version History">
                          <div class="flex items-center justify-between mb-4">
                            <span class="text-xs text-muted-foreground">
                              Auto-refreshes every 5s
                            </span>
                            <button
                              type="button"
                              onClick={() => void refetchDeployments()}
                              class="cr-btn cr-btn-secondary"
                            >
                              Refresh
                            </button>
                          </div>

                          <Show
                            when={(deployments() ?? []).length > 0}
                            fallback={
                              <EmptyBlock title="No deployments yet" />
                            }
                          >
                            <div class="border border-border">
                              <For each={deployments() ?? []}>
                                {(deployment) => {
                                  const isOpen = () =>
                                    selectedDeploymentId() === deployment.id;
                                  const toggle = () =>
                                    setSelectedDeploymentId(
                                      isOpen() ? null : deployment.id,
                                    );
                                  return (
                                    <div class="border-b border-border last:border-0">
                                      <div
                                        class={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-secondary transition-colors ${isOpen() ? 'bg-secondary' : ''}`}
                                        onClick={toggle}
                                      >
                                        <span class="text-muted-foreground text-xs shrink-0">
                                          {isOpen() ? '▾' : '▸'}
                                        </span>
                                        <div class="flex-1 min-w-0">
                                          <p class="text-sm font-medium truncate">
                                            {deployment.commit_message ??
                                              'Manual deployment'}
                                          </p>
                                          <p class="text-xs text-muted-foreground font-mono mt-0.5">
                                            {deployment.commit_sha
                                              ? deployment.commit_sha.slice(
                                                  0,
                                                  7,
                                                )
                                              : '—'}
                                          </p>
                                        </div>
                                        <StatusBadge
                                          status={deployment.status}
                                        />
                                        <span class="text-xs text-muted-foreground shrink-0 hidden lg:block">
                                          {formatDateTime(deployment.started_at)}
                                        </span>
                                      </div>

                                      <Show when={isOpen()}>
                                        <div class="px-4 py-4 border-t border-border bg-card flex flex-col gap-4">
                                          <div class="grid gap-3 sm:grid-cols-3 text-xs">
                                            <div class="flex flex-col gap-0.5">
                                              <dt class="text-muted-foreground uppercase tracking-wider">
                                                Status
                                              </dt>
                                              <dd>
                                                <StatusBadge
                                                  status={deployment.status}
                                                />
                                              </dd>
                                            </div>
                                            <div class="flex flex-col gap-0.5">
                                              <dt class="text-muted-foreground uppercase tracking-wider">
                                                Started
                                              </dt>
                                              <dd>
                                                {formatDateTime(
                                                  deployment.started_at,
                                                )}
                                              </dd>
                                            </div>
                                            <div class="flex flex-col gap-0.5">
                                              <dt class="text-muted-foreground uppercase tracking-wider">
                                                Finished
                                              </dt>
                                              <dd>
                                                {formatDateTime(
                                                  deployment.finished_at,
                                                )}
                                              </dd>
                                            </div>
                                            <div class="flex flex-col gap-0.5 col-span-full">
                                              <dt class="text-muted-foreground uppercase tracking-wider">
                                                Commit
                                              </dt>
                                              <dd class="font-mono">
                                                {deployment.commit_sha ?? '—'}
                                              </dd>
                                            </div>
                                          </div>

                                          <div class="flex gap-2">
                                            <button
                                              type="button"
                                              class="cr-btn cr-btn-secondary"
                                              onClick={() =>
                                                void rollback(deployment.id)
                                              }
                                              disabled={
                                                pendingAction() ===
                                                `rollback-${deployment.id}`
                                              }
                                            >
                                              Rollback
                                            </button>
                                            <button
                                              type="button"
                                              class="cr-btn cr-btn-secondary"
                                              onClick={() =>
                                                deploymentLogStream.connect()
                                              }
                                            >
                                              Reconnect Logs
                                            </button>
                                          </div>

                                          <pre class="bg-[#0d0d0d] text-[#d4d4d4] border border-border p-4 overflow-x-auto text-xs font-mono min-h-[8rem] max-h-[24rem] overflow-y-auto">
                                            <Show
                                              when={deploymentLogStream.isStreaming()}
                                            >
                                              <div class="flex items-center gap-2 mb-2 text-green-400">
                                                <span class="flex h-1.5 w-1.5 bg-green-400 animate-ping" />
                                                streaming live
                                              </div>
                                            </Show>
                                            {deploymentLogStream
                                              .logs()
                                              .join('\n') ||
                                              'No logs. Click Reconnect Logs.'}
                                          </pre>
                                        </div>
                                      </Show>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          </Show>
                        </Panel>
                      </div>
                    )}
                  </Show>
                </Match>

                {/* ——— LOGS TAB ——— */}
                <Match when={activeTab() === 'logs'}>
                  <Panel title="Application Logs">
                    <LogViewer serviceId={serviceId()} />
                  </Panel>
                </Match>
              </Switch>
            </Tabs>
          </>
        )}
      </Show>
    </div>
  );
};

export default ServiceDetail;
