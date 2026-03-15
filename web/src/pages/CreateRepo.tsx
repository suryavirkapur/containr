import { useNavigate, useSearchParams } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { listGithubAppRepos, type GithubAppRepo } from '../api/github';
import { getGithubAppStatus } from '../api/settings';
import { EmptyBlock, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { describeError } from '../utils/format';

const readParam = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

const CreateRepo = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [githubUrl, setGithubUrl] = createSignal('');
  const [branch, setBranch] = createSignal('');
  const [name, setName] = createSignal('');
  const [serviceType, setServiceType] = createSignal(readParam(searchParams.type) || 'web_service');
  const [repoQuery, setRepoQuery] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [githubAppStatus, { refetch: refetchGithubAppStatus }] = createResource(async () => getGithubAppStatus());
  const [repos, { refetch: refetchRepos }] = createResource(async () => listGithubAppRepos());

  const filteredRepos = createMemo(() => {
    const needle = repoQuery().trim().toLowerCase();
    if (!needle) return repos() ?? [];
    return (repos() ?? []).filter((repo) =>
      [repo.name, repo.full_name, repo.default_branch, repo.description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  });

  const chooseRepo = (repo: GithubAppRepo) => {
    setGithubUrl(repo.clone_url);
    if (!branch().trim()) {
      setBranch(repo.default_branch);
    }
    if (!name().trim()) {
      setName(repo.name);
    }
    setError(null);
  };

  const continueToConfigure = (event: Event) => {
    event.preventDefault();
    if (!githubUrl().trim() || !name().trim()) {
      setError('name and github url are required');
      return;
    }

    const params = new URLSearchParams({
      github_url: githubUrl().trim(),
      branch: branch().trim(),
      name: name().trim(),
      type: serviceType(),
    });
    navigate(`/services/new/configure?${params.toString()}`);
  };

  return (
    <div class='flex flex-col gap-8'>
      <PageTitle title='New Repository Service' subtitle='Step 1 of 2. Capture the repo and runtime type.' />
      {error() ? <Notice tone='error'>{error()}</Notice> : null}
      <Panel title='Repository Details'>
        <form class='flex flex-col gap-6' onSubmit={continueToConfigure}>
          <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-2'>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Service Name</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={name()} 
                onInput={(event) => setName(event.currentTarget.value)} 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>GitHub URL</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={githubUrl()} 
                onInput={(event) => setGithubUrl(event.currentTarget.value)} 
                placeholder='https://github.com/org/repo' 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Branch</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={branch()} 
                onInput={(event) => setBranch(event.currentTarget.value)} 
                placeholder='Default branch if empty' 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Service Type</span>
              <select 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={serviceType()} 
                onChange={(event) => setServiceType(event.currentTarget.value)}
              >
                <option value='web_service'>Web Service</option>
                <option value='private_service'>Private Service</option>
                <option value='background_worker'>Background Worker</option>
                <option value='cron_job'>Cron Job</option>
              </select>
            </label>
          </div>
          <div class='flex flex-wrap gap-2 pt-4 border-t border-border mt-2'>
            <button 
              type='submit'
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2"
            >
              Continue
            </button>
          </div>
        </form>
      </Panel>

      <Panel title='GitHub App Repositories' subtitle='Pick an installed repository or keep using a pasted URL.'>
        <Show when={githubAppStatus.loading || repos.loading}>
          <LoadingBlock message='Loading GitHub repositories...' />
        </Show>

        <Show when={githubAppStatus.error}>
          {(currentError) => (
            <Notice tone='info'>
              GitHub App status is unavailable for this account: {describeError(currentError())}. Manual repository URLs still work.
            </Notice>
          )}
        </Show>

        <Show when={repos.error}>
          {(currentError) => (
            <Notice tone='info'>
              GitHub repositories could not be loaded: {describeError(currentError())}. Manual repository URLs still work.
            </Notice>
          )}
        </Show>

        <Show when={githubAppStatus()}>
          {(status) => (
            <Show
              when={status().configured}
              fallback={<Notice tone='info'>No GitHub App is configured for this account. Paste the repository URL or configure the app in settings.</Notice>}
            >
              <Show
                when={status().installations.length > 0}
                fallback={<Notice tone='info'>The GitHub App exists, but it is not installed on any account or org yet. Finish the installation in settings, then refresh this list.</Notice>}
              >
                <div class='flex flex-col gap-6'>
                  <div class='flex flex-col sm:flex-row gap-4 items-end'>
                    <label class='flex flex-col gap-2 flex-1'>
                      <span class='text-sm font-medium leading-none'>Repo Search</span>
                      <input 
                        class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={repoQuery()} 
                        onInput={(event) => setRepoQuery(event.currentTarget.value)} 
                        placeholder="Search by name or description..."
                      />
                    </label>
                    <div class='flex flex-wrap gap-2'>
                      <button 
                        type='button' 
                        onClick={() => void refetchRepos()}
                        class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
                      >
                        Refresh Repos
                      </button>
                      <button 
                        type='button' 
                        onClick={() => void refetchGithubAppStatus()}
                        class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
                      >
                        Refresh status
                      </button>
                    </div>
                  </div>
                  
                  <Show when={filteredRepos().length > 0} fallback={<EmptyBlock title='No repositories found'>The installed GitHub App did not return any repositories for this account.</EmptyBlock>}>
                    <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                      <For each={filteredRepos()}>
                        {(repo) => (
                          <article class='rounded-xl border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-4'>
                            <div class='flex justify-between items-start gap-4'>
                              <div class="min-w-0">
                                <h3 class="font-semibold tracking-tight truncate text-base" title={repo.full_name}>{repo.full_name}</h3>
                                <p class='text-xs text-muted-foreground font-mono truncate mt-1' title={repo.clone_url}>{repo.clone_url}</p>
                              </div>
                              <span class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider shrink-0 break-keep ${
                                repo.private ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800' : 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800'
                              }`}>{repo.private ? 'Private' : 'Public'}</span>
                            </div>
                            <div class='grid grid-cols-1 gap-4 py-3 border-y border-border text-xs mt-auto'>
                              <div class='flex flex-col gap-1'>
                                <p class='font-semibold uppercase tracking-wider text-muted-foreground'>Default Branch</p>
                                <p class="font-medium text-sm">{repo.default_branch}</p>
                              </div>
                              <div class='flex flex-col gap-1'>
                                <p class='font-semibold uppercase tracking-wider text-muted-foreground'>Description</p>
                                <p class="text-muted-foreground line-clamp-2" title={repo.description || undefined}>{repo.description ?? 'No description provided.'}</p>
                              </div>
                            </div>
                            <div class='flex flex-wrap gap-2'>
                              <button 
                                type='button' 
                                onClick={() => chooseRepo(repo)}
                                class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3 py-1 w-full"
                              >
                                Use this repository
                              </button>
                            </div>
                          </article>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </Show>
          )}
        </Show>
      </Panel>
    </div>
  );
};

export default CreateRepo;
