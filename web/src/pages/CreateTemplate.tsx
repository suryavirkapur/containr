import { useNavigate, useSearchParams } from '@solidjs/router';
import { createSignal } from 'solid-js';
import { createService } from '../api/services';
import { Notice, PageTitle, Panel } from '../components/Plain';
import { describeError } from '../utils/format';

const readParam = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

const CreateTemplate = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [name, setName] = createSignal('');
  const [version, setVersion] = createSignal('');
  const [memory, setMemory] = createSignal('512');
  const [cpu, setCpu] = createSignal('1');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const templateType = () => readParam(searchParams.type) || 'redis';

  const create = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const created = await createService({
        source: 'template',
        template: templateType(),
        name: name().trim(),
        version: version().trim() || null,
        memory_limit_mb: Number.parseInt(memory(), 10) || 512,
        cpu_limit: Number.parseFloat(cpu()) || 1,
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
      <PageTitle title='new managed template' subtitle='Create a database, queue, or vector service with minimal input.' />
      {error() ? <Notice tone='error'>{error()}</Notice> : null}
      <Panel title='template request'>
        <form class='form-stack' onSubmit={(event) => void create(event)}>
          <div class='table-wrap'>
            <table>
              <tbody>
                <tr><th>template</th><td>{templateType()}</td></tr>
              </tbody>
            </table>
          </div>
          <label class='field'>
            <span>service name</span>
            <input value={name()} onInput={(event) => setName(event.currentTarget.value)} />
          </label>
          <div class='two-col'>
            <label class='field'>
              <span>version</span>
              <input value={version()} onInput={(event) => setVersion(event.currentTarget.value)} placeholder='default if empty' />
            </label>
            <label class='field'>
              <span>memory limit (mb)</span>
              <input value={memory()} onInput={(event) => setMemory(event.currentTarget.value)} />
            </label>
            <label class='field'>
              <span>cpu limit</span>
              <input value={cpu()} onInput={(event) => setCpu(event.currentTarget.value)} />
            </label>
          </div>
          <div class='button-row'>
            <button type='submit' disabled={saving()}>{saving() ? 'creating...' : 'create service'}</button>
          </div>
        </form>
      </Panel>
    </div>
  );
};

export default CreateTemplate;
