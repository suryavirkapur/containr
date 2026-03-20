import { useNavigate, useSearchParams } from '@solidjs/router';
import { createSignal, Show } from 'solid-js';
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

const readParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

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

  const inputClass =
    'flex h-8 w-full border border-border bg-card px-3 py-1 text-sm ' +
    'placeholder:text-muted-foreground focus-visible:outline-none ' +
    'focus-visible:ring-1 focus-visible:ring-ring';

  const textareaClass =
    'flex w-full border border-border bg-card px-3 py-2 text-sm font-mono ' +
    'placeholder:text-muted-foreground focus-visible:outline-none ' +
    'focus-visible:ring-1 focus-visible:ring-ring';

  return (
    <div class="flex flex-col gap-6 max-w-2xl">
      <PageTitle title="Configure Service" subtitle="Step 2 of 2 — fill in runtime details." />

      {error() ? <Notice tone="error">{error()}</Notice> : null}

      {/* Summary bar */}
      <div class="border border-border bg-card px-4 py-3 flex flex-wrap gap-4 text-xs">
        <div>
          <span class="text-muted-foreground">Name</span>{' '}
          <span class="font-medium ml-1">{name()}</span>
        </div>
        <div>
          <span class="text-muted-foreground">Type</span>{' '}
          <span class="font-medium ml-1">{serviceType()}</span>
        </div>
        <div>
          <span class="text-muted-foreground">Branch</span>{' '}
          <span class="font-medium ml-1">{branch() || 'default'}</span>
        </div>
      </div>

      <Panel title="Service Request">
        <form class="flex flex-col gap-5" onSubmit={(event) => void create(event)}>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-medium">Port</span>
              <input class={inputClass} value={port()} onInput={(e) => setPort(e.currentTarget.value)} />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-medium">Replicas</span>
              <input class={inputClass} value={replicas()} onInput={(e) => setReplicas(e.currentTarget.value)} />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-medium">Dockerfile Path</span>
              <input class={inputClass} value={dockerfilePath()} onInput={(e) => setDockerfilePath(e.currentTarget.value)} />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-medium">Build Context</span>
              <input class={inputClass} value={buildContext()} onInput={(e) => setBuildContext(e.currentTarget.value)} />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-medium">Working Directory</span>
              <input class={inputClass} value={workingDir()} onInput={(e) => setWorkingDir(e.currentTarget.value)} />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-medium">Command</span>
              <input
                class={inputClass}
                value={command()}
                onInput={(e) => setCommand(e.currentTarget.value)}
                placeholder="npm start"
              />
            </label>
            <Show when={serviceType() === 'cron_job'}>
              <label class="flex flex-col gap-1.5">
                <span class="text-sm font-medium">Cron Schedule</span>
                <input class={inputClass} value={schedule()} onInput={(e) => setSchedule(e.currentTarget.value)} />
              </label>
            </Show>
          </div>

          <div class="border-t border-border pt-5 flex flex-col gap-4">
            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-medium">Domains</span>
              <small class="text-xs text-muted-foreground">One domain per line.</small>
              <textarea
                class={`${textareaClass} min-h-[72px]`}
                value={domains()}
                onInput={(e) => setDomains(e.currentTarget.value)}
              />
            </label>

            <label class="flex flex-col gap-1.5">
              <span class="text-sm font-medium">Environment Variables</span>
              <small class="text-xs text-muted-foreground">KEY=VALUE per line.</small>
              <textarea
                class={`${textareaClass} min-h-[100px]`}
                value={envVars()}
                onInput={(e) => setEnvVars(e.currentTarget.value)}
              />
            </label>
          </div>

          <div class="flex gap-2 pt-2 border-t border-border">
            <button
              type="submit"
              disabled={saving()}
              class="px-4 py-1.5 text-sm font-medium bg-foreground text-background hover:opacity-80 transition-opacity disabled:opacity-40"
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
