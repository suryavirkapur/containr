import { useNavigate, useSearchParams } from '@solidjs/router';
import { createSignal } from 'solid-js';
import { Notice, PageTitle, Panel } from '../components/Plain';

const readParam = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

const CreateRepo = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [githubUrl, setGithubUrl] = createSignal('');
  const [branch, setBranch] = createSignal('');
  const [name, setName] = createSignal('');
  const [serviceType, setServiceType] = createSignal(readParam(searchParams.type) || 'web_service');
  const [error, setError] = createSignal<string | null>(null);

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
    </div>
  );
};

export default CreateRepo;
