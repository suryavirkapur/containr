import { A, useNavigate, useParams } from '@solidjs/router';
import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import {
  deleteService,
  getService,
  getServiceCertificates,
  getServiceDeploymentLogs,
  getServiceHttpLogs,
  getServiceLogs,
  getServiceSettings,
  listServiceDeployments,
  reissueServiceCertificate,
  rollbackServiceDeployment,
  runServiceAction,
  triggerServiceDeployment,
  updateService,
} from '../api/services';
import { EmptyBlock, KeyValueTable, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { copyText, describeError, formatDateTime, formatList } from '../utils/format';

const endpointFor = (service: Awaited<ReturnType<typeof getService>>): string => {
  return (
    service.default_urls[0] ??
    service.proxy_connection_string ??
    service.connection_string ??
    (service.internal_host && service.port ? `${service.internal_host}:${service.port}` : 'internal only')
  );
};

const envText = (values: Array<{ key: string; value: string }>) =>
  values.map((entry) => `${entry.key}=${entry.value}`).join('\n');

const parseEnvText = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split('=');
      return { key: key.trim(), value: rest.join('=').trim(), secret: false };
    });

const parseLines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const ServiceDetail = () => {
  const params = useParams();
  const navigate = useNavigate();
  const serviceId = () => params.id ?? '';
  const [feedback, setFeedback] = createSignal<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);
  const [selectedDeploymentId, setSelectedDeploymentId] = createSignal<string | null>(null);
  const [settingsLoadedFor, setSettingsLoadedFor] = createSignal<string | null>(null);
  const [githubUrl, setGithubUrl] = createSignal('');
  const [branch, setBranch] = createSignal('');
  const [rolloutStrategy, setRolloutStrategy] = createSignal('');
  const [envVarsText, setEnvVarsText] = createSignal('');
  const [watchPathsText, setWatchPathsText] = createSignal('');
  const [serviceJson, setServiceJson] = createSignal('{}');
  const [autoDeployEnabled, setAutoDeployEnabled] = createSignal(false);
  const [cleanupStale, setCleanupStale] = createSignal(false);

  const [service, { refetch: refetchService }] = createResource(serviceId, getService);
  const [settings, { refetch: refetchSettings }] = createResource(serviceId, getServiceSettings);
  const [logs, { refetch: refetchLogs }] = createResource(serviceId, (id) => getServiceLogs(id, 300));
  const [httpLogs, { refetch: refetchHttpLogs }] = createResource(serviceId, (id) => getServiceHttpLogs(id, 200, 0));
  const [deployments, { refetch: refetchDeployments }] = createResource(serviceId, listServiceDeployments);
  const [certificates, { refetch: refetchCertificates }] = createResource(serviceId, getServiceCertificates);
  const [deploymentLogs, { refetch: refetchDeploymentLogs }] = createResource(
    () => ({ currentServiceId: serviceId(), deploymentId: selectedDeploymentId() }),
    ({ currentServiceId, deploymentId }) => (
      deploymentId ? getServiceDeploymentLogs(currentServiceId, deploymentId, 400, 0) : Promise.resolve([])
    ),
  );

  createEffect(() => {
    const currentSettings = settings();
    if (!currentSettings || settingsLoadedFor() === currentSettings.service_id) return;
    setSettingsLoadedFor(currentSettings.service_id);
    setGithubUrl(currentSettings.github_url);
    setBranch(currentSettings.branch);
    setRolloutStrategy(currentSettings.rollout_strategy);
    setEnvVarsText(envText(currentSettings.env_vars));
    setWatchPathsText(currentSettings.auto_deploy.watch_paths.join('\n'));
    setServiceJson(JSON.stringify(currentSettings.service, null, 2));
    setAutoDeployEnabled(currentSettings.auto_deploy.enabled);
    setCleanupStale(currentSettings.auto_deploy.cleanup_stale_deployments);
  });

  createEffect(() => {
    const rows = deployments();
    if (!rows || rows.length === 0) return;
    if (!selectedDeploymentId()) {
      setSelectedDeploymentId(rows[0].id);
    }
  });

  const refreshAll = async () => {
    await Promise.all([
      refetchService(),
      refetchSettings(),
      refetchLogs(),
      refetchHttpLogs(),
      refetchDeployments(),
      refetchCertificates(),
      refetchDeploymentLogs(),
    ]);
  };

  const runAction = async (action: 'start' | 'stop' | 'restart') => {
    setPendingAction(action);
    setFeedback(null);
    try {
      await runServiceAction(serviceId(), action);
      await refreshAll();
      setFeedback({ tone: 'success', text: `${action} request accepted` });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPendingAction(null);
    }
  };

  const deploy = async () => {
    setPendingAction('deploy');
    setFeedback(null);
    try {
      await triggerServiceDeployment(serviceId(), {});
      await refreshAll();
      setFeedback({ tone: 'success', text: 'deployment queued' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPendingAction(null);
    }
  };

  const saveSettings = async (rotateWebhookToken = false) => {
    setPendingAction(rotateWebhookToken ? 'rotate-webhook' : 'save');
    setFeedback(null);
    try {
      const parsedService = JSON.parse(serviceJson());
      await updateService(serviceId(), {
        github_url: githubUrl().trim() || null,
        branch: branch().trim() || null,
        rollout_strategy: rolloutStrategy().trim() || null,
        env_vars: parseEnvText(envVarsText()),
        auto_deploy: {
          enabled: autoDeployEnabled(),
          cleanup_stale_deployments: cleanupStale(),
          watch_paths: parseLines(watchPathsText()),
          regenerate_webhook_token: rotateWebhookToken,
        },
        service: parsedService,
      });
      await refreshAll();
      setFeedback({ tone: 'success', text: rotateWebhookToken ? 'webhook token rotated' : 'settings saved' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPendingAction(null);
    }
  };

  const rollback = async (deploymentId: string) => {
    setPendingAction(`rollback-${deploymentId}`);
    setFeedback(null);
    try {
      await rollbackServiceDeployment(serviceId(), deploymentId, {});
      await refreshAll();
      setFeedback({ tone: 'success', text: 'rollback queued' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPendingAction(null);
    }
  };

  const reissueCertificates = async () => {
    setPendingAction('reissue-certificates');
    setFeedback(null);
    try {
      const response = await reissueServiceCertificate(serviceId(), {});
      await refetchCertificates();
      setFeedback({ tone: 'success', text: response.message });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPendingAction(null);
    }
  };

  const removeService = async () => {
    if (!confirm('delete this service?')) return;
    setPendingAction('delete');
    setFeedback(null);
    try {
      await deleteService(serviceId());
      navigate('/services');
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
      setPendingAction(null);
    }
  };

  return (
    <div class='stack'>
      <Show when={service.loading}><LoadingBlock message='Loading service...' /></Show>
      <Show when={service.error}>{(error) => <Notice tone='error'>Failed to load service: {describeError(error())}</Notice>}</Show>
      <Show when={service()}>
        {(currentService) => (
          <>
            <PageTitle
              title={currentService().name}
              subtitle={`${currentService().service_type} / ${currentService().resource_kind}`}
              actions={
                <>
                  <A href='/services'>back to services</A>
                  <button type='button' onClick={() => void refreshAll()}>refresh</button>
                </>
              }
            />

            {feedback() ? <Notice tone={feedback()!.tone}>{feedback()!.text}</Notice> : null}

            <Panel title='actions'>
              <div class='button-row'>
                <button type='button' onClick={() => void runAction('start')} disabled={pendingAction() === 'start'}>start</button>
                <button type='button' onClick={() => void runAction('stop')} disabled={pendingAction() === 'stop'}>stop</button>
                <button type='button' onClick={() => void runAction('restart')} disabled={pendingAction() === 'restart'}>restart</button>
                <button type='button' onClick={() => void deploy()} disabled={pendingAction() === 'deploy'}>deploy</button>
                <button type='button' onClick={() => void removeService()} disabled={pendingAction() === 'delete'}>delete</button>
              </div>
            </Panel>

            <Panel title='summary'>
              <KeyValueTable
                rows={[
                  ['status', <span class={`status-${currentService().status}`}>{currentService().status}</span>],
                  ['endpoint', <span class='mono'>{endpointFor(currentService())}</span>],
                  ['domains', <span>{formatList(currentService().domains)}</span>],
                  ['network', <span>{currentService().network_name}</span>],
                  ['containers', <span class='mono'>{formatList(currentService().container_ids)}</span>],
                  ['deployment id', <span class='mono'>{currentService().deployment_id ?? 'n/a'}</span>],
                  ['created', <span>{formatDateTime(currentService().created_at)}</span>],
                  ['updated', <span>{formatDateTime(currentService().updated_at)}</span>],
                ]}
              />
            </Panel>

            <Show when={settings.error}>{(error) => <Notice tone='error'>Settings unavailable: {describeError(error())}</Notice>}</Show>
            <Show when={settings()}>
              {(currentSettings) => (
                <Panel title='configuration' subtitle='Raw text and JSON only. Save to update the next deployment.'>
                  <form class='form-stack' onSubmit={(event) => { event.preventDefault(); void saveSettings(false); }}>
                    <div class='two-col'>
                      <label class='field'>
                        <span>github url</span>
                        <input value={githubUrl()} onInput={(event) => setGithubUrl(event.currentTarget.value)} />
                      </label>
                      <label class='field'>
                        <span>branch</span>
                        <input value={branch()} onInput={(event) => setBranch(event.currentTarget.value)} />
                      </label>
                      <label class='field'>
                        <span>rollout strategy</span>
                        <input value={rolloutStrategy()} onInput={(event) => setRolloutStrategy(event.currentTarget.value)} />
                      </label>
                      <label class='field'>
                        <span>auto deploy enabled</span>
                        <select value={autoDeployEnabled() ? 'yes' : 'no'} onChange={(event) => setAutoDeployEnabled(event.currentTarget.value === 'yes')}>
                          <option value='yes'>yes</option>
                          <option value='no'>no</option>
                        </select>
                      </label>
                      <label class='field'>
                        <span>cleanup stale deployments</span>
                        <select value={cleanupStale() ? 'yes' : 'no'} onChange={(event) => setCleanupStale(event.currentTarget.value === 'yes')}>
                          <option value='yes'>yes</option>
                          <option value='no'>no</option>
                        </select>
                      </label>
                    </div>

                    <label class='field'>
                      <span>environment variables</span>
                      <small class='muted'>One KEY=VALUE entry per line.</small>
                      <textarea value={envVarsText()} onInput={(event) => setEnvVarsText(event.currentTarget.value)} />
                    </label>

                    <label class='field'>
                      <span>watch paths</span>
                      <small class='muted'>One relative path per line.</small>
                      <textarea value={watchPathsText()} onInput={(event) => setWatchPathsText(event.currentTarget.value)} />
                    </label>

                    <label class='field'>
                      <span>service JSON</span>
                      <small class='muted'>Edit the canonical service request payload directly.</small>
                      <textarea value={serviceJson()} onInput={(event) => setServiceJson(event.currentTarget.value)} />
                    </label>

                    <div class='table-wrap'>
                      <table>
                        <tbody>
                          <tr>
                            <th>deploy webhook token</th>
                            <td class='mono'>{currentSettings().auto_deploy.webhook_token}</td>
                          </tr>
                          <tr>
                            <th>deploy webhook path</th>
                            <td class='mono'>{currentSettings().auto_deploy.webhook_path}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <div class='button-row'>
                      <button type='submit' disabled={pendingAction() === 'save'}>save settings</button>
                      <button type='button' onClick={() => void saveSettings(true)} disabled={pendingAction() === 'rotate-webhook'}>
                        rotate webhook token
                      </button>
                      <button type='button' onClick={() => void copyText(currentSettings().auto_deploy.webhook_token)}>
                        copy token
                      </button>
                    </div>
                  </form>
                </Panel>
              )}
            </Show>

            <Panel title='service logs'>
              <div class='button-row'>
                <button type='button' onClick={() => void refetchLogs()}>refresh logs</button>
              </div>
              <pre>{logs() ?? ''}</pre>
            </Panel>

            <Panel title='http request logs'>
              <div class='button-row'>
                <button type='button' onClick={() => void refetchHttpLogs()}>refresh http logs</button>
              </div>
              <Show when={(httpLogs() ?? []).length > 0} fallback={<p>No request logs yet.</p>}>
                <div class='table-wrap'>
                  <table>
                    <thead>
                      <tr>
                        <th>time</th>
                        <th>method</th>
                        <th>path</th>
                        <th>status</th>
                        <th>domain</th>
                        <th>upstream</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={httpLogs() ?? []}>
                        {(entry) => (
                          <tr>
                            <td>{formatDateTime(entry.created_at)}</td>
                            <td>{entry.method}</td>
                            <td class='mono'>{entry.path}</td>
                            <td>{entry.status}</td>
                            <td>{entry.domain}</td>
                            <td class='mono'>{entry.upstream}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </Panel>

            <Panel title='deployments'>
              <div class='button-row'>
                <button type='button' onClick={() => void refetchDeployments()}>refresh deployments</button>
              </div>
              <Show when={(deployments() ?? []).length > 0} fallback={<p>No deployments recorded yet.</p>}>
                <div class='table-wrap'>
                  <table>
                    <thead>
                      <tr>
                        <th>id</th>
                        <th>status</th>
                        <th>commit</th>
                        <th>message</th>
                        <th>started</th>
                        <th>finished</th>
                        <th>actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={deployments() ?? []}>
                        {(deployment) => (
                          <tr>
                            <td class='mono'>{deployment.id}</td>
                            <td class={`status-${deployment.status}`}>{deployment.status}</td>
                            <td class='mono'>{deployment.commit_sha}</td>
                            <td>{deployment.commit_message ?? 'manual deployment'}</td>
                            <td>{formatDateTime(deployment.started_at)}</td>
                            <td>{formatDateTime(deployment.finished_at)}</td>
                            <td>
                              <div class='inline-actions'>
                                <button type='button' onClick={() => setSelectedDeploymentId(deployment.id)}>show logs</button>
                                <button type='button' onClick={() => void rollback(deployment.id)} disabled={pendingAction() === `rollback-${deployment.id}`}>
                                  rollback
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>

              <Show when={selectedDeploymentId()}>
                {(deploymentId) => (
                  <div class='stack'>
                    <p><strong>selected deployment:</strong> <span class='mono'>{deploymentId()}</span></p>
                    <div class='button-row'>
                      <button type='button' onClick={() => void refetchDeploymentLogs()}>refresh selected deployment logs</button>
                    </div>
                    <pre>{(deploymentLogs() ?? []).join('\n')}</pre>
                  </div>
                )}
              </Show>
            </Panel>

            <Panel title='certificates'>
              <div class='button-row'>
                <button type='button' onClick={() => void reissueCertificates()} disabled={pendingAction() === 'reissue-certificates'}>
                  reissue certificates
                </button>
                <button type='button' onClick={() => void refetchCertificates()}>refresh certificates</button>
              </div>
              <Show when={(certificates() ?? []).length > 0} fallback={<p>No managed certificates yet.</p>}>
                <div class='table-wrap'>
                  <table>
                    <thead>
                      <tr>
                        <th>domain</th>
                        <th>status</th>
                        <th>issued</th>
                        <th>expires</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={certificates() ?? []}>
                        {(certificate) => (
                          <tr>
                            <td>{certificate.domain}</td>
                            <td>{certificate.status}</td>
                            <td>{formatDateTime(certificate.issued_at)}</td>
                            <td>{formatDateTime(certificate.expires_at)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </Panel>
          </>
        )}
      </Show>
    </div>
  );
};

export default ServiceDetail;
