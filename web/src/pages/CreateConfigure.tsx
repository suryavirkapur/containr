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

const CreateConfigure = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [port, setPort] = createSignal('3000');
  const [dockerfilePath, setDockerfilePath] = createSignal('Dockerfile');
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
          dockerfile_path: dockerfilePath().trim() || null,
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
    <div class='stack'>
      <PageTitle title='configure repository service' subtitle='Step 2 of 2. Fill in runtime details and submit.' />
      {error() ? <Notice tone='error'>{error()}</Notice> : null}
      <Panel title='service request'>
        <form class='form-stack' onSubmit={(event) => void create(event)}>
          <div class='table-wrap'>
            <table>
              <tbody>
                <tr><th>name</th><td>{name()}</td></tr>
                <tr><th>type</th><td>{serviceType()}</td></tr>
                <tr><th>github url</th><td class='mono'>{githubUrl()}</td></tr>
                <tr><th>branch</th><td>{branch() || 'default'}</td></tr>
              </tbody>
            </table>
          </div>

          <div class='two-col'>
            <label class='field'>
              <span>port</span>
              <input value={port()} onInput={(event) => setPort(event.currentTarget.value)} />
            </label>
            <label class='field'>
              <span>replicas</span>
              <input value={replicas()} onInput={(event) => setReplicas(event.currentTarget.value)} />
            </label>
            <label class='field'>
              <span>dockerfile path</span>
              <input value={dockerfilePath()} onInput={(event) => setDockerfilePath(event.currentTarget.value)} />
            </label>
            <label class='field'>
              <span>build context</span>
              <input value={buildContext()} onInput={(event) => setBuildContext(event.currentTarget.value)} />
            </label>
            <label class='field'>
              <span>working directory</span>
              <input value={workingDir()} onInput={(event) => setWorkingDir(event.currentTarget.value)} />
            </label>
            <label class='field'>
              <span>command</span>
              <input value={command()} onInput={(event) => setCommand(event.currentTarget.value)} placeholder='npm start' />
            </label>
          </div>

          <label class='field'>
            <span>domains (one per line)</span>
            <textarea value={domains()} onInput={(event) => setDomains(event.currentTarget.value)} />
          </label>

          <label class='field'>
            <span>environment variables (KEY=VALUE per line)</span>
            <textarea value={envVars()} onInput={(event) => setEnvVars(event.currentTarget.value)} />
          </label>

          {serviceType() === 'cron_job' ? (
            <label class='field'>
              <span>cron schedule</span>
              <input value={schedule()} onInput={(event) => setSchedule(event.currentTarget.value)} />
            </label>
          ) : null}

          <div class='button-row'>
            <button type='submit' disabled={saving()}>{saving() ? 'creating...' : 'create service'}</button>
          </div>
        </form>
      </Panel>
    </div>
  );
};

export default CreateConfigure;
