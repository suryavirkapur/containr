import { useNavigate, useSearchParams } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { createService, listServices } from '../api/services';
import { Notice, PageTitle, Panel } from '../components/Plain';
import { describeError } from '../utils/format';
import { listAttachableGroups } from '../utils/service-groups';

const readParam = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

const CreateTemplate = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [name, setName] = createSignal('');
  const [version, setVersion] = createSignal('');
  const [memory, setMemory] = createSignal('512');
  const [cpu, setCpu] = createSignal('1');
  const [groupId, setGroupId] = createSignal(readParam(searchParams.group_id));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [services] = createResource(async () => listServices());

  const templateType = () => readParam(searchParams.type) || 'redis';
  const groupName = () => readParam(searchParams.group_name);
  const availableGroups = createMemo(() => listAttachableGroups(services() ?? []));
  const selectedGroup = createMemo(() => availableGroups().find((group) => group.id === groupId()) ?? null);

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
        group_id: groupId().trim() || null,
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
      <PageTitle
        title='New Managed Template'
        subtitle='Create a database, queue, or vector service and choose whether it shares a group.'
      />
      {error() ? <Notice tone='error'>{error()}</Notice> : null}
      <Show when={services.error}>
        {(currentError) => (
          <Notice tone='info'>
            Existing groups could not be loaded: {describeError(currentError())}. You can still create an isolated service.
          </Notice>
        )}
      </Show>
      <Panel title='Template Request'>
        <form class='flex flex-col gap-6' onSubmit={(event) => void create(event)}>
          <div class='grid grid-cols-2 gap-4 rounded-lg border bg-accent/30 p-4 border-border mb-2'>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>Template</p>
              <p class="font-medium capitalize">{templateType()}</p>
            </div>
            <div class='flex flex-col gap-1'>
              <p class='font-semibold uppercase tracking-wider text-xs text-muted-foreground'>Placement</p>
              <p class="font-medium">{selectedGroup()?.label ?? (groupName() || 'Isolated Network')}</p>
            </div>
          </div>

          <Notice tone='info'>
            Groups only control the internal network boundary. Choose a repository-backed service group to share networking, or leave this managed service isolated.
          </Notice>

          <label class='flex flex-col gap-2'>
            <span class='text-sm font-medium leading-none'>Service Name</span>
            <input 
              class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={name()} 
              onInput={(event) => setName(event.currentTarget.value)} 
            />
          </label>

          <label class='flex flex-col gap-2'>
            <span class='text-sm font-medium leading-none'>Group</span>
            <select 
              class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={groupId()} 
              onChange={(event) => setGroupId(event.currentTarget.value)}
            >
              <option value=''>Isolated Network</option>
              <For each={availableGroups()}>
                {(group) => (
                  <option value={group.id}>
                    {group.label} ({group.networkName})
                  </option>
                )}
              </For>
            </select>
          </label>

          <div class='grid gap-4 sm:grid-cols-3'>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Version</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={version()} 
                onInput={(event) => setVersion(event.currentTarget.value)} 
                placeholder='Default if empty' 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Memory Limit (MB)</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={memory()} 
                onInput={(event) => setMemory(event.currentTarget.value)} 
              />
            </label>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>CPU Limit</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={cpu()} 
                onInput={(event) => setCpu(event.currentTarget.value)} 
              />
            </label>
          </div>

          <Show when={groupId() && !selectedGroup()}>
            <Notice tone='info'>
              The preselected group is no longer available in the current inventory. Creating this service will fall back to an isolated network unless you choose another group.
            </Notice>
          </Show>

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

export default CreateTemplate;
