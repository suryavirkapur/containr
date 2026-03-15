import { useSearchParams } from '@solidjs/router';
import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import { createUser, listUsers } from '../api/auth';
import {
  deleteGithubApp,
  getGithubAppManifest,
  getGithubAppStatus,
  getHealth,
  getSettings,
  getSystemStats,
  issueDashboardCertificate,
  updateSettings,
} from '../api/settings';
import { KeyValueTable, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { useAuth } from '../context/AuthContext';
import { describeError, formatBytes, formatDateTime } from '../utils/format';

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
  const [health, { refetch: refetchHealth }] = createResource(getHealth);
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
    <div class='flex flex-col gap-8'>
      <PageTitle title='Settings' subtitle='Server configuration and bootstrap-admin user management.' />
      {feedback() ? <Notice tone={feedback()!.tone}>{feedback()!.text}</Notice> : null}

      <Panel title='Current User'>
        <KeyValueTable rows={[
          ['Email', <span>{auth.user()?.email}</span>],
          ['Role', <span class="capitalize">{isAdmin() ? 'Bootstrap Admin' : 'Standard User'}</span>],
        ]} />
      </Panel>

      <Show when={health()}>
        {(currentHealth) => (
          <Panel title='Health'>
            <KeyValueTable rows={[
              ['Status', <span class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${
                currentHealth().status === 'ok' ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800' : 'bg-muted text-muted-foreground border-border'
              }`}>{currentHealth().status}</span>],
              ['Version', <span class='font-mono text-muted-foreground'>{currentHealth().version}</span>],
            ]} />
            <div class='flex flex-wrap gap-2 pt-4 border-t border-border'>
              <button 
                type='button' 
                onClick={() => void refetchHealth()}
                class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
              >
                Refresh Health
              </button>
            </div>
          </Panel>
        )}
      </Show>

      <Show when={isAdmin()} fallback={<Panel title='Access'><p class="text-muted-foreground">Only the first user can manage server settings or add users.</p></Panel>}>
        <Show when={settings.loading}><LoadingBlock message='Loading settings...' /></Show>
        <Show when={stats.loading}><LoadingBlock message='Loading system stats...' /></Show>
        <Show when={users.loading}><LoadingBlock message='Loading user list...' /></Show>
        <Show when={settings.error}>{(error) => <Notice tone='error'>Settings failed: {describeError(error())}</Notice>}</Show>
        <Show when={stats.error}>{(error) => <Notice tone='error'>Stats failed: {describeError(error())}</Notice>}</Show>
        <Show when={users.error}>{(error) => <Notice tone='error'>User list failed: {describeError(error())}</Notice>}</Show>

        <Show when={stats()}>
          {(currentStats) => (
            <Panel title='System Stats'>
              <KeyValueTable rows={[
                ['CPU %', <span>{currentStats().cpu_percent.toFixed(1)}</span>],
                ['Memory', <span>{formatBytes(currentStats().memory_used_bytes)} / {formatBytes(currentStats().memory_total_bytes)}</span>],
                ['Network RX', <span>{formatBytes(currentStats().network_rx_bytes)}</span>],
                ['Network TX', <span>{formatBytes(currentStats().network_tx_bytes)}</span>],
                ['Load Avg', <span>{currentStats().load_avg.join(', ')}</span>],
                ['Uptime Seconds', <span>{currentStats().uptime_seconds}</span>],
              ]} />
              <div class='flex flex-wrap gap-2 pt-4 border-t border-border'>
                <button 
                  type='button' 
                  onClick={() => void refetchStats()}
                  class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
                >
                  Refresh Stats
                </button>
              </div>
            </Panel>
          )}
        </Show>

        <Show when={settings()}>
          {(currentSettings) => (
            <Panel title='Server Settings'>
              <form class='flex flex-col gap-6' onSubmit={(event) => void saveSettingsForm(event)}>
                <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>Base Domain</span><input class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={baseDomain()} onInput={(event) => setBaseDomain(event.currentTarget.value)} /></label>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>Public IP</span><input class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={publicIp()} onInput={(event) => setPublicIp(event.currentTarget.value)} /></label>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>Public S3 Hostname</span><input class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={storagePublicHostname()} onInput={(event) => setStoragePublicHostname(event.currentTarget.value)} /></label>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>Rustfs Management Endpoint</span><input class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={storageManagementEndpoint()} onInput={(event) => setStorageManagementEndpoint(event.currentTarget.value)} /></label>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>Rustfs Internal Host</span><input class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={storageInternalHost()} onInput={(event) => setStorageInternalHost(event.currentTarget.value)} /></label>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>Rustfs Port</span><input class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={storagePort()} onInput={(event) => setStoragePort(event.currentTarget.value)} /></label>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>ACME Email</span><input class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={acmeEmail()} onInput={(event) => setAcmeEmail(event.currentTarget.value)} /></label>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>ACME Staging</span><select class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={acmeStaging()} onChange={(event) => setAcmeStaging(event.currentTarget.value)}><option value='yes'>Yes</option><option value='no'>No</option></select></label>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>Log Retention Days</span><input class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={logRetentionDays()} onInput={(event) => setLogRetentionDays(event.currentTarget.value)} /></label>
                </div>
                <div class='flex flex-wrap gap-2 pt-4'>
                  <button 
                    type='submit' 
                    disabled={pending() === 'save-settings'}
                    class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
                  >
                    Save Settings
                  </button>
                  <button 
                    type='button' 
                    onClick={() => void queueCertificate()} 
                    disabled={pending() === 'issue-certificate'}
                    class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
                  >
                    Issue Dashboard Certificate
                  </button>
                </div>
                <Notice tone={currentSettings().wildcard_dns.ready ? 'success' : 'info'} title='Default Service Domains'>
                  Set <strong>{currentSettings().wildcard_dns.wildcard_domain ?? 'the wildcard DNS record'}</strong> so public services can open on <strong>{currentSettings().default_service_domain_pattern ?? 'service-{random 5 lowercase letters}.domain.com'}</strong>.
                  {' '}
                  {currentSettings().wildcard_dns.detail}
                </Notice>
                <div class='border-t border-border pt-6'>
                  <KeyValueTable rows={[
                    ['Dashboard URL', <span class="font-mono text-xs">{currentSettings().dashboard_url ?? 'n/a'}</span>],
                    ['Public IP', <span class="font-mono text-xs">{currentSettings().public_ip ?? 'n/a'}</span>],
                    ['Wildcard Domain', <span class="font-mono text-xs">{currentSettings().service_wildcard_domain ?? 'n/a'}</span>],
                    ['Default Service Domain', <span class="font-mono text-xs">{currentSettings().default_service_domain_pattern ?? 'n/a'}</span>],
                    ['Wildcard DNS Sample', <span class="font-mono text-xs">{currentSettings().wildcard_dns.sample_domain ?? 'n/a'}</span>],
                    ['Wildcard DNS Ready', <span class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider ${currentSettings().wildcard_dns.ready ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800' : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800'}`}>{currentSettings().wildcard_dns.ready ? 'Yes' : 'No'}</span>],
                    ['Wildcard DNS Detail', <span>{currentSettings().wildcard_dns.detail}</span>],
                    ['API Port', <span>{currentSettings().api_port}</span>],
                    ['HTTP/HTTPS', <span>{currentSettings().http_port} / {currentSettings().https_port}</span>],
                    ['Log Directory', <span class='font-mono text-xs text-muted-foreground'>{currentSettings().log_dir}</span>],
                  ]} />
                </div>
              </form>
            </Panel>
          )}
        </Show>

        <Show when={users()}>
          {(currentUsers) => (
            <Panel title='Users' subtitle='Only the bootstrap admin can create accounts.'>
              <form class='flex flex-col gap-6 mb-8 border-b border-border pb-8' onSubmit={(event) => void addUser(event)}>
                <div class='grid gap-4 sm:grid-cols-2'>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>New User Email</span><input type='email' class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={newUserEmail()} onInput={(event) => setNewUserEmail(event.currentTarget.value)} /></label>
                  <label class='flex flex-col gap-2'><span class='text-sm font-medium leading-none'>Temporary Password</span><input type='password' class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={newUserPassword()} onInput={(event) => setNewUserPassword(event.currentTarget.value)} /></label>
                </div>
                <div class='flex flex-wrap gap-2'>
                  <button 
                    type='submit' 
                    disabled={pending() === 'create-user'}
                    class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
                  >
                    Add User
                  </button>
                </div>
              </form>
              <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                <For each={currentUsers()}>
                  {(user) => (
                    <article class='rounded-xl border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-4'>
                      <div class='flex justify-between items-start gap-4'>
                        <div class="min-w-0">
                          <h3 class="font-semibold tracking-tight truncate text-base">{user.email}</h3>
                          <p class='text-xs text-muted-foreground truncate mt-1'>{user.github_username ?? 'local password account'}</p>
                        </div>
                        <span class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider shrink-0 break-keep ${
                          user.is_admin ? 'bg-primary text-primary-foreground border-transparent' : 'bg-secondary text-secondary-foreground border-border'
                        }`}>{user.is_admin ? 'Admin' : 'User'}</span>
                      </div>
                    </article>
                  )}
                </For>
              </div>
            </Panel>
          )}
        </Show>

        <Show when={githubApp()}>
          {(currentGithubApp) => (
            <Panel title='GitHub App' subtitle='Repository deploys only appear after you create and install the GitHub App.'>
              <Show
                when={currentGithubApp().configured}
                fallback={
                  <div class='flex flex-col gap-6 mb-6'>
                    <p class="text-sm text-muted-foreground">No GitHub App is configured yet.</p>
                    <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
                      {[
                        'Click complete github app creation form.',
                        'GitHub opens the app creation page in a new tab. Submit that form.',
                        'After GitHub redirects back here, use the install link that appears below.',
                        'Refresh this section. Installations should appear once the app is connected.',
                      ].map((step, index) => (
                        <article class='rounded-xl border bg-accent/50 text-accent-foreground shadow-sm p-4 text-sm'>
                          <p class='font-semibold tracking-wide uppercase text-xs mb-2 text-muted-foreground'>Step {index + 1}</p>
                          <p class="leading-relaxed">{step}</p>
                        </article>
                      ))}
                    </div>
                  </div>
                }
              >
                <KeyValueTable rows={[
                  ['App ID', <span class='font-mono text-xs'>{currentGithubApp().app?.app_id ?? 'n/a'}</span>],
                  ['App Name', <span class="font-medium">{currentGithubApp().app?.app_name ?? 'n/a'}</span>],
                  ['HTML URL', <span class='font-mono text-xs break-all'>{currentGithubApp().app?.html_url ?? 'n/a'}</span>],
                  ['Installations', <span class="font-bold">{String(currentGithubApp().installations.length)}</span>],
                ]} />
                <div class="my-6">
                <KeyValueTable rows={[
                  [
                    'Install App',
                    <Show
                      when={appendGithubPath(currentGithubApp().app?.html_url, '/installations/new')}
                      fallback={<span class="text-muted-foreground">available after the app is created</span>}
                    >
                      {(installUrl) => <a href={installUrl()} target='_blank' rel='noreferrer' class="text-primary hover:underline font-medium">Open GitHub installation page</a>}
                    </Show>,
                  ],
                  [
                    'Manage App',
                    <Show when={currentGithubApp().app?.html_url} fallback={<span class="text-muted-foreground">available after the app is created</span>}>
                      {(appUrl) => <a href={appUrl()} target='_blank' rel='noreferrer' class="text-primary hover:underline font-medium">Open GitHub app page</a>}
                    </Show>,
                  ],
                ]} />
                </div>
                <Show when={currentGithubApp().installations.length === 0}>
                  <Notice tone='info' title='Install still missing'>
                    <span class="text-sm">Create the app first, then click <strong>open GitHub installation page</strong>. Until an installation exists, repository deploys will not appear.</span>
                  </Notice>
                </Show>
                <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6'>
                  <For each={currentGithubApp().installations}>
                    {(installation) => (
                      <article class='rounded-xl border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-4'>
                        <div class='flex justify-between items-start gap-4'>
                          <div class="min-w-0">
                            <h3 class="font-semibold tracking-tight truncate text-base">{installation.account_login}</h3>
                            <p class='text-xs text-muted-foreground font-mono truncate mt-1'>{installation.id}</p>
                          </div>
                          <span class='inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-secondary text-secondary-foreground border-border'>{installation.account_type}</span>
                        </div>
                        <div class='grid grid-cols-1 gap-4 py-3 border-t border-border text-xs mt-auto'>
                          <div class='flex flex-col gap-1'>
                            <p class='font-semibold uppercase text-muted-foreground tracking-wider'>Repositories</p>
                            <p class="font-medium text-sm">{installation.repository_count ?? 'n/a'}</p>
                          </div>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
              <div class='flex flex-wrap gap-2 pt-4 border-t border-border mt-4'>
                <button 
                  type='button' 
                  onClick={() => void startGithubAppSetup()} 
                  disabled={pending() === 'create-github-app'}
                  class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
                >
                  Open GitHub App Creation Form
                </button>
                <button 
                  type='button' 
                  onClick={() => void removeGithubApp()} 
                  disabled={pending() === 'delete-github-app'}
                  class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-destructive hover:text-destructive-foreground hover:border-destructive shadow-sm h-9 px-4 py-2 disabled:opacity-50"
                >
                  Delete GitHub App
                </button>
                <button 
                  type='button' 
                  onClick={() => void refetchGithubApp()}
                  class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
                >
                  Refresh Status
                </button>
              </div>
            </Panel>
          )}
        </Show>
      </Show>
    </div>
  );
};

export default Settings;
