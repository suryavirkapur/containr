import { useNavigate, useSearchParams } from '@solidjs/router';
import { createSignal } from 'solid-js';
import { createService } from '../api/services';
import { Notice, PageTitle, Panel } from '../components/Plain';
import { describeError } from '../utils/format';

const parseCommand = (value: string): string[] | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/).filter(Boolean);
};

const parseLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const parseEnvVars = (value: string) =>
  parseLines(value).map((line) => {
    const [key, ...rest] = line.split('=');
    return { key: key.trim(), value: rest.join('=').trim(), secret: false };
  });

const readParam = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const DEFAULT_DOCKERFILE_PATH = 'Dockerfile';

const CreateConfigure = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [port, setPort] = createSignal('3000');
  const [dockerfilePath, setDockerfilePath] = createSignal(DEFAULT_DOCKERFILE_PATH);
  const [buildContext, setBuildContext] = createSignal('.');
  const [envVars, setEnvVars] = createSignal('');
  const [command, setCommand] = createSignal('');
  const [workingDir, setWorkingDir] = createSignal('');
  const [schedule, setSchedule] = createSignal('*/5 * * * *');
  const [replicas, setReplicas] = createSignal('1');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const serviceType = () => readParam(searchParams.type) || 'web_service';
  const githubUrl = () => readParam(searchParams.github_url);
  const branch = () => readParam(searchParams.branch);
  const name = () => readParam(searchParams.name);

  const create = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const normalizedDockerfilePath = dockerfilePath().trim();
      const dockerfilePathValue =
        !normalizedDockerfilePath || normalizedDockerfilePath === DEFAULT_DOCKERFILE_PATH
          ? null
          : normalizedDockerfilePath;

      const created = await createService({
        source: 'git_repository',
        github_url: githubUrl(),
        branch: branch() || null,
        name: name(),
        service: {
          name: name(),
          service_type: serviceType(),
          port: Number.parseInt(port(), 10) || 3000,
          expose_http: serviceType() === 'web_service',
          dockerfile_path: dockerfilePathValue,
          build_context: buildContext().trim() || null,
          command: parseCommand(command()),
          working_dir: workingDir().trim() || null,
          env_vars: parseEnvVars(envVars()),
          schedule: serviceType() === 'cron_job' ? schedule().trim() || null : null,
          replicas: Number.parseInt(replicas(), 10) || 1,
        },
      });
      navigate(`/services/${created.id}`);
    } catch (requestError) {
      setError(describeError(requestError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class='flex flex-col gap-6'>
      <PageTitle title='Configure Repository Service' subtitle='Step 2 of 2. Fill in runtime details and submit.' />
      {error() ? <Notice tone='error'>{error()}</Notice> : null}
      <Panel title='Service Request'>
        <form class='flex flex-col gap-6' onSubmit={(event) => void create(event)}>
          <div class='grid grid-cols-2 gap-4 rounded-md border border-border bg-secondary p-4 text-sm lg:grid-cols-4'>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>Name</p>
              <p class='truncate font-medium' title={name()}>{name()}</p>
            </div>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>Type</p>
              <p class='font-medium'>{serviceType()}</p>
            </div>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>GitHub URL</p>
              <p class='font-mono text-xs truncate' title={githubUrl()}>{githubUrl()}</p>
            </div>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>Branch</p>
              <p class='truncate font-medium' title={branch() || 'default'}>{branch() || 'default'}</p>
            </div>
          </div>

          <Notice tone='info'>
            Repository-backed services create their own group boundary. Domains are intentionally left empty on creation so the user can attach them later.
          </Notice>

          <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
            <label class='cr-field'>
              <span class='cr-label'>Port</span>
              <input class='cr-input' value={port()} onInput={(event) => setPort(event.currentTarget.value)} />
            </label>
            <label class='cr-field'>
              <span class='cr-label'>Replicas</span>
              <input class='cr-input' value={replicas()} onInput={(event) => setReplicas(event.currentTarget.value)} />
            </label>
            <label class='cr-field'>
              <span class='cr-label'>Dockerfile Path</span>
              <input class='cr-input' value={dockerfilePath()} onInput={(event) => setDockerfilePath(event.currentTarget.value)} />
            </label>
            <label class='cr-field'>
              <span class='cr-label'>Build Context</span>
              <input class='cr-input' value={buildContext()} onInput={(event) => setBuildContext(event.currentTarget.value)} />
            </label>
            <label class='cr-field'>
              <span class='cr-label'>Working Directory</span>
              <input class='cr-input' value={workingDir()} onInput={(event) => setWorkingDir(event.currentTarget.value)} />
            </label>
            <label class='cr-field'>
              <span class='cr-label'>Command</span>
              <input class='cr-input' value={command()} onInput={(event) => setCommand(event.currentTarget.value)} placeholder='npm start' />
            </label>
            {serviceType() === 'cron_job' ? (
              <label class='cr-field'>
                <span class='cr-label'>Cron Schedule</span>
                <input class='cr-input' value={schedule()} onInput={(event) => setSchedule(event.currentTarget.value)} />
              </label>
            ) : null}
          </div>

          <div class='flex flex-col gap-4 border-t border-border pt-6'>
            <label class='cr-field'>
              <span class='cr-label'>Environment Variables (KEY=VALUE per line)</span>
              <textarea class='cr-textarea font-code' value={envVars()} onInput={(event) => setEnvVars(event.currentTarget.value)} />
            </label>
          </div>

          <div class='mt-2 flex flex-wrap gap-2 border-t border-border pt-4'>
            <button type='submit' disabled={saving()} class='cr-btn cr-btn-primary disabled:opacity-50'>
              {saving() ? 'Creating...' : 'Create Service'}
            </button>
          </div>
        </form>
      </Panel>
    </div>
  );
};

export default CreateConfigure;
