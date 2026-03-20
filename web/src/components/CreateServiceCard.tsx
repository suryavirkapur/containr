import { useNavigate } from '@solidjs/router';
import { createMemo, createSignal, Show } from 'solid-js';

type Props = {
  groupId?: string;
  groupName?: string;
  compact?: boolean;
};

const repoTypes = [
  ['web_service', 'Web service'],
  ['private_service', 'Private service'],
  ['background_worker', 'Background worker'],
  ['cron_job', 'Cron job'],
] as const;

export const CreateServiceCard = (props: Props) => {
  const navigate = useNavigate();
  const [name, setName] = createSignal('');
  const [serviceType, setServiceType] = createSignal('web_service');

  const selectedTypeLabel = createMemo(
    () => repoTypes.find(([value]) => value === serviceType())?.[1] ?? 'Web service',
  );

  const continueToRepositoryFlow = () => {
    const params = new URLSearchParams({
      type: serviceType(),
    });

    if (name().trim()) {
      params.set('name', name().trim());
    }

    navigate(`/services/new/repo?${params.toString()}`);
  };

  const openManagedCatalog = () => {
    const params = new URLSearchParams();
    if (props.groupId) params.set('group_id', props.groupId);
    if (props.groupName) params.set('group_name', props.groupName);
    navigate(`/services/new${params.toString() ? `?${params.toString()}` : ''}`);
  };

  return (
    <section class='rounded-lg border border-border bg-card text-card-foreground shadow-sm'>
      <header class='flex items-center gap-3 border-b border-border px-6 py-4'>
        <span class='text-lg font-semibold text-primary'>+</span>
        <div>
          <h2 class='text-lg font-semibold'>Create A New Service</h2>
          <p class='text-sm text-muted-foreground'>
            Services are the primary entity. No public domain is assigned until you add one.
          </p>
        </div>
      </header>

      <div class={`cr-card-grid px-6 py-6 ${props.compact ? '' : ''}`}>
        <div>
          <div class='pb-5 text-center text-sm font-medium text-muted-foreground'>
            Create from scratch
            <hr class='mt-3 opacity-35' />
          </div>

          <div class='flex flex-col gap-4'>
            <Show when={props.groupId}>
              <div class='rounded-md border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground'>
                New managed services created from this screen can join{' '}
                <strong class='text-foreground'>
                  {props.groupName ?? 'the selected network group'}
                </strong>
                .
              </div>
            </Show>

            <label class='cr-field'>
              <span class='cr-label'>Service name</span>
              <input
                class='cr-input'
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
                placeholder='my-amazing-service'
              />
            </label>

            <label class='cr-field'>
              <span class='cr-label'>Service type</span>
              <select
                class='cr-select'
                value={serviceType()}
                onChange={(event) => setServiceType(event.currentTarget.value)}
              >
                {repoTypes.map(([value, label]) => (
                  <option value={value}>{label}</option>
                ))}
              </select>
            </label>

            <div class='rounded-md border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground'>
              <strong class='text-foreground'>{selectedTypeLabel()}</strong> continues into the
              repository setup flow. Configure domains later from the service detail page.
            </div>

            <div>
              <button type='button' class='cr-btn cr-btn-primary' onClick={continueToRepositoryFlow}>
                Continue To Repository Setup
              </button>
            </div>
          </div>
        </div>

        <div>
          <div class='pb-5 text-center text-sm font-medium text-muted-foreground'>
            Or select from
            <hr class='mt-3 opacity-35' />
          </div>

          <div class='flex flex-col gap-3'>
            <button type='button' class='cr-btn cr-btn-secondary justify-start' onClick={openManagedCatalog}>
              Managed databases and queues
            </button>
            <button
              type='button'
              class='cr-btn cr-btn-secondary justify-start'
              onClick={() => navigate('/services/new/repo?type=web_service')}
            >
              Git repository service
            </button>
            <button
              type='button'
              class='cr-btn cr-btn-secondary justify-start'
              onClick={() => navigate('/services/new/template?type=postgresql')}
            >
              PostgreSQL template
            </button>
            <button
              type='button'
              class='cr-btn cr-btn-secondary justify-start'
              onClick={() => navigate('/services/new/template?type=redis')}
            >
              Valkey template
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
