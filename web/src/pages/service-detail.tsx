import { A, useNavigate, useParams } from '@solidjs/router';
import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import {
  deleteService,
  getService,
  getServiceCertificates,
  getServiceDeployment,
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
  const [deployBranch, setDeployBranch] = createSignal('');
  const [deployCommitSha, setDeployCommitSha] = createSignal('');
  const [deployCommitMessage, setDeployCommitMessage] = createSignal('');
  const [deployRolloutStrategy, setDeployRolloutStrategy] = createSignal('');
  const [certificateDomain, setCertificateDomain] = createSignal('');
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
  const [selectedDeployment, { refetch: refetchSelectedDeployment }] = createResource(
    () => ({ currentServiceId: serviceId(), deploymentId: selectedDeploymentId() }),
    ({ currentServiceId, deploymentId }) => (
      deploymentId ? getServiceDeployment(currentServiceId, deploymentId) : Promise.resolve(null)
    ),
  );
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
    setDeployBranch(currentSettings.branch);
    setDeployRolloutStrategy(currentSettings.rollout_strategy);
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
      refetchSelectedDeployment(),
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
      await triggerServiceDeployment(serviceId(), {
        branch: deployBranch().trim() || null,
        commit_sha: deployCommitSha().trim() || null,
        commit_message: deployCommitMessage().trim() || null,
        rollout_strategy: deployRolloutStrategy().trim() || null,
      });
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
      const response = await reissueServiceCertificate(serviceId(), {
        domain: certificateDomain().trim() || null,
      });
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
              <div class='stack'>
                <div class='button-row'>
                  <button type='button' onClick={() => void runAction('start')} disabled={pendingAction() === 'start'}>start</button>
                  <button type='button' onClick={() => void runAction('stop')} disabled={pendingAction() === 'stop'}>stop</button>
                  <button type='button' onClick={() => void runAction('restart')} disabled={pendingAction() === 'restart'}>restart</button>
                  <button type='button' onClick={() => void removeService()} disabled={pendingAction() === 'delete'}>delete</button>
                </div>
                <div class='two-col'>
                  <label class='field'>
                    <span>deploy branch</span>
                    <input value={deployBranch()} onInput={(event) => setDeployBranch(event.currentTarget.value)} placeholder='default branch if empty' />
                  </label>
                  <label class='field'>
                    <span>deploy rollout strategy</span>
                    <input value={deployRolloutStrategy()} onInput={(event) => setDeployRolloutStrategy(event.currentTarget.value)} placeholder='start_first or stop_first' />
                  </label>
                  <label class='field'>
                    <span>commit sha</span>
                    <input value={deployCommitSha()} onInput={(event) => setDeployCommitSha(event.currentTarget.value)} placeholder='optional' />
                  </label>
                  <label class='field'>
                    <span>commit message</span>
                    <input value={deployCommitMessage()} onInput={(event) => setDeployCommitMessage(event.currentTarget.value)} placeholder='optional' />
                  </label>
                </div>
                <div class='button-row'>
                  <button type='button' onClick={() => void deploy()} disabled={pendingAction() === 'deploy'}>deploy</button>
                </div>
              </div>
            </Panel>

            <Panel title='summary'>
              <KeyValueTable
                rows={[
                  ['status', <span class={`status-${currentService().status}`}>{currentService().status}</span>],
                  ['endpoint', <span class='mono'>{endpointFor(currentService())}</span>],
                  [
                    'group',
                    currentService().group_id ? (
                      <A href={`/services?group=${currentService().group_id}`}>
                        {currentService().project_name ?? currentService().group_id}
                      </A>
                    ) : (
                      <span>isolated</span>
                    ),
                  ],
                  ['domains', <span>{formatList(currentService().domains)}</span>],
                  ['network', <span>{currentService().network_name}</span>],
                  [
                    'containers',
                    currentService().container_ids.length > 0 ? (
                      <div class='link-list'>
                        <For each={currentService().container_ids}>
                          {(containerId) => <A href={`/containers/${containerId}`}>{containerId}</A>}
                        </For>
                      </div>
                    ) : (
                      <span>none</span>
                    ),
                  ],
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

                    <KeyValueTable
                      rows={[
                        ['deploy webhook token', <span class='mono'>{currentSettings().auto_deploy.webhook_token}</span>],
                        ['deploy webhook path', <span class='mono'>{currentSettings().auto_deploy.webhook_path}</span>],
                      ]}
                    />

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
                <div class='repo-grid'>
                  <For each={httpLogs() ?? []}>
                    {(entry) => (
                      <article class='repo-card'>
                        <div class='choice-card-head'>
                          <div>
                            <h3>{entry.method} {entry.path}</h3>
                            <p class='muted'>{formatDateTime(entry.created_at)}</p>
                          </div>
                          <span class='badge'>{entry.status}</span>
                        </div>
                        <div class='summary-grid'>
                          <div class='summary-card'>
                            <p class='muted'>domain</p>
                            <p>{entry.domain}</p>
                          </div>
                          <div class='summary-card'>
                            <p class='muted'>upstream</p>
                            <p class='mono'>{entry.upstream}</p>
                          </div>
                          <div class='summary-card'>
                            <p class='muted'>protocol</p>
                            <p>{entry.protocol}</p>
                          </div>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </Panel>

            <Panel title='deployments'>
              <div class='button-row'>
                <button type='button' onClick={() => void refetchDeployments()}>refresh deployments</button>
              </div>
              <Show when={(deployments() ?? []).length > 0} fallback={<p>No deployments recorded yet.</p>}>
                <div class='repo-grid'>
                  <For each={deployments() ?? []}>
                    {(deployment) => (
                      <article class='repo-card'>
                        <div class='choice-card-head'>
                          <div>
                            <h3>{deployment.commit_message ?? 'manual deployment'}</h3>
                            <p class='muted mono'>{deployment.id}</p>
                          </div>
                          <span class={`status-pill status-${deployment.status}`}>{deployment.status}</span>
                        </div>
                        <div class='summary-grid'>
                          <div class='summary-card'>
                            <p class='muted'>commit</p>
                            <p class='mono'>{deployment.commit_sha}</p>
                          </div>
                          <div class='summary-card'>
                            <p class='muted'>started</p>
                            <p>{formatDateTime(deployment.started_at)}</p>
                          </div>
                          <div class='summary-card'>
                            <p class='muted'>finished</p>
                            <p>{formatDateTime(deployment.finished_at)}</p>
                          </div>
                        </div>
                        <div class='button-row'>
                          <button type='button' onClick={() => setSelectedDeploymentId(deployment.id)}>show logs</button>
                          <button type='button' onClick={() => void rollback(deployment.id)} disabled={pendingAction() === `rollback-${deployment.id}`}>
                            rollback
                          </button>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={selectedDeploymentId()}>
                {(deploymentId) => (
                  <div class='stack'>
                    <p><strong>selected deployment:</strong> <span class='mono'>{deploymentId()}</span></p>
                    <Show when={selectedDeployment()}>
                      {(deployment) => (
                        <KeyValueTable
                          rows={[
                            ['status', <span>{deployment().status}</span>],
                            ['commit', <span class='mono'>{deployment().commit_sha}</span>],
                            ['message', <span>{deployment().commit_message ?? 'manual deployment'}</span>],
                            ['container id', <span class='mono'>{deployment().container_id ?? 'n/a'}</span>],
                            ['created', <span>{formatDateTime(deployment().created_at)}</span>],
                            ['started', <span>{formatDateTime(deployment().started_at)}</span>],
                            ['finished', <span>{formatDateTime(deployment().finished_at)}</span>],
                          ]}
                        />
                      )}
                    </Show>
                    <div class='button-row'>
                      <button type='button' onClick={() => void refetchSelectedDeployment()}>refresh selected deployment</button>
                      <button type='button' onClick={() => void refetchDeploymentLogs()}>refresh selected deployment logs</button>
                    </div>
                    <pre>{(deploymentLogs() ?? []).join('\n')}</pre>
                  </div>
                )}
              </Show>
            </Panel>

            <Panel title='certificates'>
              <div class='stack'>
                <label class='field'>
                  <span>reissue single domain</span>
                  <input value={certificateDomain()} onInput={(event) => setCertificateDomain(event.currentTarget.value)} placeholder='leave empty to reissue all domains' />
                </label>
                <div class='button-row'>
                <button type='button' onClick={() => void reissueCertificates()} disabled={pendingAction() === 'reissue-certificates'}>
                  reissue certificates
                </button>
                <button type='button' onClick={() => void refetchCertificates()}>refresh certificates</button>
                </div>
              </div>
              <Show when={(certificates() ?? []).length > 0} fallback={<p>No managed certificates yet.</p>}>
                <div class='repo-grid'>
                  <For each={certificates() ?? []}>
                    {(certificate) => (
                      <article class='repo-card'>
                        <div class='choice-card-head'>
                          <div>
                            <h3>{certificate.domain}</h3>
                            <p class='muted'>certificate lifecycle</p>
                          </div>
                          <span class='badge'>{certificate.status}</span>
                        </div>
                        <div class='summary-grid'>
                          <div class='summary-card'>
                            <p class='muted'>issued</p>
                            <p>{formatDateTime(certificate.issued_at)}</p>
                          </div>
                          <div class='summary-card'>
                            <p class='muted'>expires</p>
                            <p>{formatDateTime(certificate.expires_at)}</p>
                          </div>
                        </div>
                      </article>
                    )}
                  </For>
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
