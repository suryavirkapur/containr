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
    <div class='stack'>
      <PageTitle title='new repository service' subtitle='Step 1 of 2. Capture the repo and runtime type.' />
      {error() ? <Notice tone='error'>{error()}</Notice> : null}
      <Panel title='repository details'>
        <form class='form-stack' onSubmit={continueToConfigure}>
          <label class='field'>
            <span>service name</span>
            <input value={name()} onInput={(event) => setName(event.currentTarget.value)} />
          </label>
          <label class='field'>
            <span>github url</span>
            <input value={githubUrl()} onInput={(event) => setGithubUrl(event.currentTarget.value)} placeholder='https://github.com/org/repo' />
          </label>
          <label class='field'>
            <span>branch</span>
            <input value={branch()} onInput={(event) => setBranch(event.currentTarget.value)} placeholder='default branch if empty' />
          </label>
          <label class='field'>
            <span>service type</span>
            <select value={serviceType()} onChange={(event) => setServiceType(event.currentTarget.value)}>
              <option value='web_service'>web service</option>
              <option value='private_service'>private service</option>
              <option value='background_worker'>background worker</option>
              <option value='cron_job'>cron job</option>
            </select>
          </label>
          <div class='button-row'>
            <button type='submit'>continue</button>
          </div>
        </form>
      </Panel>

      <Panel title='github app repositories' subtitle='Pick an installed repository or keep using a pasted URL.'>
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
                fallback={<Notice tone='info'>The GitHub App exists, but it is not installed on any account or org yet. Finish the installation in settings, then refresh this table.</Notice>}
              >
                <div class='form-stack'>
                  <label class='field'>
                    <span>repo search</span>
                    <input value={repoQuery()} onInput={(event) => setRepoQuery(event.currentTarget.value)} />
                  </label>
                  <div class='button-row'>
                    <button type='button' onClick={() => void refetchRepos()}>refresh repos</button>
                    <button type='button' onClick={() => void refetchGithubAppStatus()}>refresh github status</button>
                  </div>
                  <Show when={filteredRepos().length > 0} fallback={<EmptyBlock title='No repositories found'>The installed GitHub App did not return any repositories for this account.</EmptyBlock>}>
                    <div class='table-wrap'>
                      <table>
                        <thead>
                          <tr>
                            <th>repository</th>
                            <th>default branch</th>
                            <th>visibility</th>
                            <th>use</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={filteredRepos()}>
                            {(repo) => (
                              <tr>
                                <td>
                                  <div>{repo.full_name}</div>
                                  <div class='muted mono'>{repo.clone_url}</div>
                                </td>
                                <td>{repo.default_branch}</td>
                                <td>{repo.private ? 'private' : 'public'}</td>
                                <td>
                                  <button type='button' onClick={() => chooseRepo(repo)}>pick</button>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
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
