import { useSearchParams } from '@solidjs/router';
import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import { createUser, listUsers } from '../api/auth';
import {
  deleteGithubApp,
  getGithubAppManifest,
  getGithubAppStatus,
  getSettings,
  getSystemStats,
  issueDashboardCertificate,
  updateSettings,
} from '../api/settings';
import { KeyValueTable, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { useAuth } from '../context/AuthContext';
import { describeError, formatDateTime } from '../utils/format';

const appendGithubPath = (baseUrl: string | null | undefined, suffix: string) => {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}${suffix}`;
};

const Settings = () => {
  const auth = useAuth();
  const [searchParams] = useSearchParams();
  const [feedback, setFeedback] = createSignal<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [baseDomain, setBaseDomain] = createSignal('');
  const [publicIp, setPublicIp] = createSignal('');
  const [storagePublicHostname, setStoragePublicHostname] = createSignal('');
  const [storageManagementEndpoint, setStorageManagementEndpoint] = createSignal('');
  const [storageInternalHost, setStorageInternalHost] = createSignal('');
  const [storagePort, setStoragePort] = createSignal('9000');
  const [acmeEmail, setAcmeEmail] = createSignal('');
  const [acmeStaging, setAcmeStaging] = createSignal('yes');
  const [logRetentionDays, setLogRetentionDays] = createSignal('14');
  const [newUserEmail, setNewUserEmail] = createSignal('');
  const [newUserPassword, setNewUserPassword] = createSignal('');
  const [pending, setPending] = createSignal<string | null>(null);

  const isAdmin = () => auth.user()?.is_admin ?? false;

  const [settings, { refetch: refetchSettings }] = createResource(isAdmin, async (enabled) => enabled ? getSettings() : null);
  const [stats, { refetch: refetchStats }] = createResource(isAdmin, async (enabled) => enabled ? getSystemStats() : null);
  const [githubApp, { refetch: refetchGithubApp }] = createResource(isAdmin, async (enabled) => enabled ? getGithubAppStatus() : null);
  const [users, { refetch: refetchUsers }] = createResource(isAdmin, async (enabled) => enabled ? listUsers() : []);

  createEffect(() => {
    const githubState = searchParams.github;
    if (githubState === 'created') {
      setFeedback({
        tone: 'success',
        text: 'GitHub App saved. Next step: use the install link below to install it on your account or org.',
      });
    } else if (githubState === 'installed') {
      setFeedback({
        tone: 'success',
        text: 'GitHub installation callback received. Refresh the status below if the installation list is still empty.',
      });
    }
  });

  createEffect(() => {
    const current = settings();
    if (!current || loaded()) return;
    setLoaded(true);
    setBaseDomain(current.base_domain);
    setPublicIp(current.public_ip ?? '');
    setStoragePublicHostname(current.storage_public_hostname ?? '');
    setStorageManagementEndpoint(current.storage_management_endpoint);
    setStorageInternalHost(current.storage_internal_host);
    setStoragePort(String(current.storage_port));
    setAcmeEmail(current.acme_email);
    setAcmeStaging(current.acme_staging ? 'yes' : 'no');
    setLogRetentionDays(String(current.log_retention_days));
  });

  const saveSettingsForm = async (event: Event) => {
    event.preventDefault();
    setPending('save-settings');
    setFeedback(null);
    try {
      await updateSettings({
        base_domain: baseDomain().trim() || null,
        public_ip: publicIp().trim() || null,
        storage_public_hostname: storagePublicHostname().trim() || null,
        storage_management_endpoint: storageManagementEndpoint().trim() || null,
        storage_internal_host: storageInternalHost().trim() || null,
        storage_port: Number.parseInt(storagePort(), 10) || null,
        acme_email: acmeEmail().trim() || null,
        acme_staging: acmeStaging() === 'yes',
        log_retention_days: Number.parseInt(logRetentionDays(), 10) || null,
      });
      await refetchSettings();
      setFeedback({ tone: 'success', text: 'settings updated' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPending(null);
    }
  };

  const addUser = async (event: Event) => {
    event.preventDefault();
    setPending('create-user');
    setFeedback(null);
    try {
      await createUser({ email: newUserEmail().trim(), password: newUserPassword() });
      setNewUserEmail('');
      setNewUserPassword('');
      await refetchUsers();
      setFeedback({ tone: 'success', text: 'user created' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPending(null);
    }
  };

  const queueCertificate = async () => {
    setPending('issue-certificate');
    setFeedback(null);
    try {
      const response = await issueDashboardCertificate();
      setFeedback({ tone: 'success', text: response.message });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPending(null);
    }
  };

  const startGithubAppSetup = async () => {
    setPending('create-github-app');
    setFeedback(null);
    try {
      const manifest = await getGithubAppManifest();
      const form = document.createElement('form');
      const input = document.createElement('input');
      form.method = 'POST';
      form.action = 'https://github.com/settings/apps/new';
      form.target = '_blank';
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = manifest;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
      document.body.removeChild(form);
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPending(null);
    }
  };

  const removeGithubApp = async () => {
    if (!confirm('delete stored github app configuration?')) return;
    setPending('delete-github-app');
    setFeedback(null);
    try {
      await deleteGithubApp();
      await refetchGithubApp();
      setFeedback({ tone: 'success', text: 'github app configuration removed' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPending(null);
    }
  };

  return (
    <div class='stack'>
      <PageTitle title='settings' subtitle='Server configuration and bootstrap-admin user management.' />
      {feedback() ? <Notice tone={feedback()!.tone}>{feedback()!.text}</Notice> : null}

      <Panel title='current user'>
        <KeyValueTable rows={[
          ['email', <span>{auth.user()?.email}</span>],
          ['role', <span>{isAdmin() ? 'bootstrap admin' : 'standard user'}</span>],
        ]} />
      </Panel>

      <Show when={isAdmin()} fallback={<Panel title='access'><p>Only the first user can manage server settings or add users.</p></Panel>}>
        <Show when={settings.loading}><LoadingBlock message='Loading settings...' /></Show>
        <Show when={stats.loading}><LoadingBlock message='Loading system stats...' /></Show>
        <Show when={users.loading}><LoadingBlock message='Loading user list...' /></Show>
        <Show when={settings.error}>{(error) => <Notice tone='error'>Settings failed: {describeError(error())}</Notice>}</Show>
        <Show when={stats.error}>{(error) => <Notice tone='error'>Stats failed: {describeError(error())}</Notice>}</Show>
        <Show when={users.error}>{(error) => <Notice tone='error'>User list failed: {describeError(error())}</Notice>}</Show>

        <Show when={stats()}>
          {(currentStats) => (
            <Panel title='system stats'>
              <KeyValueTable rows={[
                ['cpu %', <span>{currentStats().cpu_percent.toFixed(1)}</span>],
                ['memory', <span>{currentStats().memory_used_bytes} / {currentStats().memory_total_bytes}</span>],
                ['network rx', <span>{currentStats().network_rx_bytes}</span>],
                ['network tx', <span>{currentStats().network_tx_bytes}</span>],
                ['load avg', <span>{currentStats().load_avg.join(', ')}</span>],
                ['uptime seconds', <span>{currentStats().uptime_seconds}</span>],
              ]} />
              <div class='button-row'>
                <button type='button' onClick={() => void refetchStats()}>refresh stats</button>
              </div>
            </Panel>
          )}
        </Show>

        <Show when={settings()}>
          {(currentSettings) => (
            <Panel title='server settings'>
              <form class='form-stack' onSubmit={(event) => void saveSettingsForm(event)}>
                <div class='two-col'>
                  <label class='field'><span>base domain</span><input value={baseDomain()} onInput={(event) => setBaseDomain(event.currentTarget.value)} /></label>
                  <label class='field'><span>public ip</span><input value={publicIp()} onInput={(event) => setPublicIp(event.currentTarget.value)} /></label>
                  <label class='field'><span>public s3 hostname</span><input value={storagePublicHostname()} onInput={(event) => setStoragePublicHostname(event.currentTarget.value)} /></label>
                  <label class='field'><span>rustfs management endpoint</span><input value={storageManagementEndpoint()} onInput={(event) => setStorageManagementEndpoint(event.currentTarget.value)} /></label>
                  <label class='field'><span>rustfs internal host</span><input value={storageInternalHost()} onInput={(event) => setStorageInternalHost(event.currentTarget.value)} /></label>
                  <label class='field'><span>rustfs port</span><input value={storagePort()} onInput={(event) => setStoragePort(event.currentTarget.value)} /></label>
                  <label class='field'><span>acme email</span><input value={acmeEmail()} onInput={(event) => setAcmeEmail(event.currentTarget.value)} /></label>
                  <label class='field'><span>acme staging</span><select value={acmeStaging()} onChange={(event) => setAcmeStaging(event.currentTarget.value)}><option value='yes'>yes</option><option value='no'>no</option></select></label>
                  <label class='field'><span>log retention days</span><input value={logRetentionDays()} onInput={(event) => setLogRetentionDays(event.currentTarget.value)} /></label>
                </div>
                <div class='button-row'>
                  <button type='submit' disabled={pending() === 'save-settings'}>save settings</button>
                  <button type='button' onClick={() => void queueCertificate()} disabled={pending() === 'issue-certificate'}>issue dashboard certificate</button>
                </div>
                <Notice tone={currentSettings().wildcard_dns.ready ? 'success' : 'info'} title='default service domains'>
                  Set <strong>{currentSettings().wildcard_dns.wildcard_domain ?? 'the wildcard DNS record'}</strong> so public services can open on <strong>{currentSettings().default_service_domain_pattern ?? 'service-{random 5 lowercase letters}.domain.com'}</strong>.
                  {' '}
                  {currentSettings().wildcard_dns.detail}
                </Notice>
                <div class='table-wrap'>
                  <table>
                    <tbody>
                      <tr><th>dashboard url</th><td>{currentSettings().dashboard_url ?? 'n/a'}</td></tr>
                      <tr><th>public ip</th><td>{currentSettings().public_ip ?? 'n/a'}</td></tr>
                      <tr><th>wildcard domain</th><td>{currentSettings().service_wildcard_domain ?? 'n/a'}</td></tr>
                      <tr><th>default service domain</th><td>{currentSettings().default_service_domain_pattern ?? 'n/a'}</td></tr>
                      <tr><th>wildcard dns sample</th><td>{currentSettings().wildcard_dns.sample_domain ?? 'n/a'}</td></tr>
                      <tr><th>wildcard dns ready</th><td>{currentSettings().wildcard_dns.ready ? 'yes' : 'no'}</td></tr>
                      <tr><th>wildcard dns detail</th><td>{currentSettings().wildcard_dns.detail}</td></tr>
                      <tr><th>api port</th><td>{currentSettings().api_port}</td></tr>
                      <tr><th>http/https</th><td>{currentSettings().http_port} / {currentSettings().https_port}</td></tr>
                      <tr><th>log directory</th><td class='mono'>{currentSettings().log_dir}</td></tr>
                    </tbody>
                  </table>
                </div>
              </form>
            </Panel>
          )}
        </Show>

        <Show when={users()}>
          {(currentUsers) => (
            <Panel title='users' subtitle='Only the bootstrap admin can create accounts.'>
              <form class='form-stack' onSubmit={(event) => void addUser(event)}>
                <div class='two-col'>
                  <label class='field'><span>new user email</span><input type='email' value={newUserEmail()} onInput={(event) => setNewUserEmail(event.currentTarget.value)} /></label>
                  <label class='field'><span>temporary password</span><input type='password' value={newUserPassword()} onInput={(event) => setNewUserPassword(event.currentTarget.value)} /></label>
                </div>
                <div class='button-row'>
                  <button type='submit' disabled={pending() === 'create-user'}>add user</button>
                </div>
              </form>
              <div class='table-wrap'>
                <table>
                  <thead>
                    <tr>
                      <th>email</th>
                      <th>role</th>
                      <th>github</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={currentUsers()}>
                      {(user) => (
                        <tr>
                          <td>{user.email}</td>
                          <td>{user.is_admin ? 'bootstrap admin' : 'standard user'}</td>
                          <td>{user.github_username ?? 'local password account'}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </Show>

        <Show when={githubApp()}>
          {(currentGithubApp) => (
            <Panel title='github app' subtitle='Repository deploys only appear after you create and install the GitHub App.'>
              <Show
                when={currentGithubApp().configured}
                fallback={
                  <div class='stack'>
                    <p>No GitHub App is configured yet.</p>
                    <div class='table-wrap'>
                      <table>
                        <tbody>
                          <tr><th>step 1</th><td>Click <strong>open github app creation form</strong>.</td></tr>
                          <tr><th>step 2</th><td>GitHub opens the app creation page in a new tab. Submit that form.</td></tr>
                          <tr><th>step 3</th><td>After GitHub redirects back here, use the install link that appears below.</td></tr>
                          <tr><th>step 4</th><td>Refresh this section. Installations should be listed once the app is connected.</td></tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                }
              >
                <KeyValueTable rows={[
                  ['app id', <span class='mono'>{currentGithubApp().app?.app_id ?? 'n/a'}</span>],
                  ['app name', <span>{currentGithubApp().app?.app_name ?? 'n/a'}</span>],
                  ['html url', <span class='mono'>{currentGithubApp().app?.html_url ?? 'n/a'}</span>],
                  ['installations', <span>{String(currentGithubApp().installations.length)}</span>],
                ]} />
                <div class='table-wrap'>
                  <table>
                    <tbody>
                      <tr>
                        <th>install app</th>
                        <td>
                          <Show
                            when={appendGithubPath(currentGithubApp().app?.html_url, '/installations/new')}
                            fallback={<span>available after the app is created</span>}
                          >
                            {(installUrl) => <a href={installUrl()} target='_blank' rel='noreferrer'>open GitHub installation page</a>}
                          </Show>
                        </td>
                      </tr>
                      <tr>
                        <th>manage app</th>
                        <td>
                          <Show when={currentGithubApp().app?.html_url} fallback={<span>available after the app is created</span>}>
                            {(appUrl) => <a href={appUrl()} target='_blank' rel='noreferrer'>open GitHub app page</a>}
                          </Show>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <Show when={currentGithubApp().installations.length === 0}>
                  <Notice tone='info' title='Install still missing'>
                    Create the app first, then click <strong>open GitHub installation page</strong>. Until an installation exists, repository deploys will not appear.
                  </Notice>
                </Show>
                <div class='table-wrap'>
                  <table>
                    <thead>
                      <tr><th>installation id</th><th>account</th><th>type</th><th>repo count</th></tr>
                    </thead>
                    <tbody>
                      <For each={currentGithubApp().installations}>
                        {(installation) => (
                          <tr>
                            <td class='mono'>{installation.id}</td>
                            <td>{installation.account_login}</td>
                            <td>{installation.account_type}</td>
                            <td>{installation.repository_count ?? 'n/a'}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
              <div class='button-row'>
                <button type='button' onClick={() => void startGithubAppSetup()} disabled={pending() === 'create-github-app'}>open github app creation form</button>
                <button type='button' onClick={() => void removeGithubApp()} disabled={pending() === 'delete-github-app'}>delete github app</button>
                <button type='button' onClick={() => void refetchGithubApp()}>refresh github app status</button>
              </div>
            </Panel>
          )}
        </Show>
      </Show>
    </div>
  );
};

export default Settings;
