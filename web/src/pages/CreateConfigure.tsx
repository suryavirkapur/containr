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
  const [domains, setDomains] = createSignal('');
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
          domains: parseLines(domains()),
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
    <div class='flex flex-col gap-8'>
      <PageTitle title='Configure Repository Service' subtitle='Step 2 of 2. Fill in runtime details and submit.' />
      {error() ? <Notice tone='error'>{error()}</Notice> : null}
      <Panel title='Service Request'>
        <form class='flex flex-col gap-6' onSubmit={(event) => void create(event)}>
          <div class='grid grid-cols-2 lg:grid-cols-4 gap-4 rounded-lg border bg-accent/30 p-4 border-border mb-2 text-sm'>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>Name</p>
              <p class="font-medium truncate" title={name()}>{name()}</p>
            </div>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>Type</p>
              <p class="font-medium">{serviceType()}</p>
            </div>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>GitHub URL</p>
              <p class='font-mono text-xs truncate' title={githubUrl()}>{githubUrl()}</p>
            </div>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>Branch</p>
              <p class="font-medium truncate" title={branch() || 'default'}>{branch() || 'default'}</p>
            </div>
          </div>

          <Notice tone='info'>
            Repository-backed services create their own group boundary. Attach databases and queues to that group later from the services page.
          </Notice>

          <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Port</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={port()} 
                onInput={(event) => setPort(event.currentTarget.value)} 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Replicas</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={replicas()} 
                onInput={(event) => setReplicas(event.currentTarget.value)} 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Dockerfile Path</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={dockerfilePath()} 
                onInput={(event) => setDockerfilePath(event.currentTarget.value)} 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Build Context</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={buildContext()} 
                onInput={(event) => setBuildContext(event.currentTarget.value)} 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Working Directory</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={workingDir()} 
                onInput={(event) => setWorkingDir(event.currentTarget.value)} 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Command</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={command()} 
                onInput={(event) => setCommand(event.currentTarget.value)} 
                placeholder='npm start' 
              />
            </label>
            {serviceType() === 'cron_job' ? (
              <label class='flex flex-col gap-2'>
                <span class='text-sm font-medium leading-none'>Cron Schedule</span>
                <input 
                  class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={schedule()} 
                  onInput={(event) => setSchedule(event.currentTarget.value)} 
                />
              </label>
            ) : null}
          </div>

          <div class='flex flex-col gap-4 border-t border-border pt-6'>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Domains (one per line)</span>
              <textarea 
                class="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
                value={domains()} 
                onInput={(event) => setDomains(event.currentTarget.value)} 
              />
            </label>

            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Environment Variables (KEY=VALUE per line)</span>
              <textarea 
                class="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
                value={envVars()} 
                onInput={(event) => setEnvVars(event.currentTarget.value)} 
              />
            </label>
          </div>

          <div class='flex flex-wrap gap-2 pt-4 border-t border-border mt-2'>
            <button 
              type='submit' 
              disabled={saving()}
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
            >
              {saving() ? 'Creating...' : 'Create Service'}
            </button>
          </div>
        </form>
      </Panel>
    </div>
  );
};

export default CreateConfigure;
