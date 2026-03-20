import { A, useSearchParams } from '@solidjs/router';
import { For, Show } from 'solid-js';
import { CreateServiceCard } from '../components/CreateServiceCard';
import { Notice, PageTitle, Panel } from '../components/Plain';

const repoTypes = [
  ['web_service', 'web service', 'Public HTTP service that becomes the root of a group.'],
  ['private_service', 'private service', 'Internal service with no public routing by default.'],
  ['background_worker', 'background worker', 'Long-running worker that still defines its own boundary.'],
  ['cron_job', 'cron job', 'Scheduled job with no always-on container requirement.'],
] as const;

const templateTypes = [
  ['postgresql', 'postgresql', 'Managed relational database that can join an existing group.'],
  ['redis', 'valkey', 'Managed in-memory store for caching and ephemeral state.'],
  ['mariadb', 'mariadb', 'Managed MySQL-compatible database service.'],
  ['qdrant', 'qdrant', 'Managed vector database for search and embeddings.'],
  ['rabbitmq', 'rabbitmq', 'Managed queue service for background processing.'],
] as const;

const readParam = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

const CreateFlow = () => {
  const [searchParams] = useSearchParams();
  const selectedGroupId = () => readParam(searchParams.group_id);
  const selectedGroupName = () => readParam(searchParams.group_name);

  const templateHref = (type: string) => {
    const params = new URLSearchParams({ type });
    if (selectedGroupId()) params.set('group_id', selectedGroupId());
    if (selectedGroupName()) params.set('group_name', selectedGroupName());
    return `/services/new/template?${params.toString()}`;
  };

  return (
    <div class='flex flex-col gap-6'>
      <PageTitle
        title='New Service'
        subtitle='CapRover-style service creation flow adapted to containr services and network groups.'
      />

      <Show when={selectedGroupId()}>
        <Notice tone='info'>
          Managed templates created here can join <strong class='font-semibold'>{selectedGroupName() || 'the selected group'}</strong>.
          Repository-backed services still create their own network boundary.
        </Notice>
      </Show>

      <CreateServiceCard groupId={selectedGroupId()} groupName={selectedGroupName()} />

      <Panel title='Repository-Backed Services' subtitle='Each repository-backed service creates its own group root.'>
        <div class='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
          <For each={repoTypes}>
            {([value, label, description]) => (
              <A 
                class='group flex h-full flex-col justify-between rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md' 
                href={`/services/new/repo?type=${value}`}
              >
                <div>
                  <div class='mb-3 flex items-center justify-between'>
                    <h3 class='text-lg font-semibold capitalize tracking-tight transition-colors group-hover:text-primary'>{label}</h3>
                    <span class='cr-chip border-primary/20 bg-accent text-accent-foreground'>New Boundary</span>
                  </div>
                  <p class='text-sm leading-relaxed text-muted-foreground'>{description}</p>
                </div>
                <div class='mt-6 flex items-center justify-between border-t border-border pt-4'>
                  <span class='text-xs font-medium text-muted-foreground'>Continue to repo setup</span>
                  <span class='text-sm font-semibold text-primary group-hover:underline'>Open &rarr;</span>
                </div>
              </A>
            )}
          </For>
        </div>
      </Panel>

      <Panel title='Managed Templates' subtitle='Managed services can stay isolated or join an existing group.'>
        <div class='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
          <For each={templateTypes}>
            {([value, label, description]) => (
              <A 
                class='group flex h-full flex-col justify-between rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md' 
                href={templateHref(value)}
              >
                <div>
                  <div class='mb-3 flex items-center justify-between'>
                    <h3 class='text-lg font-semibold capitalize tracking-tight transition-colors group-hover:text-primary'>{label}</h3>
                    <span class={`cr-chip ${
                      selectedGroupId() ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300' : 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                    }`}>
                      {selectedGroupId() ? 'Attachable' : 'Managed'}
                    </span>
                  </div>
                  <p class='text-sm leading-relaxed text-muted-foreground'>{description}</p>
                </div>
                <div class='mt-6 flex items-center justify-between border-t border-border pt-4'>
                  <span class='text-xs font-medium text-muted-foreground'>
                    {selectedGroupId() ? `Join ${selectedGroupName() || 'selected group'}` : 'Pick placement next'}
                  </span>
                  <span class='text-sm font-semibold text-primary group-hover:underline'>Open &rarr;</span>
                </div>
              </A>
            )}
          </For>
        </div>
      </Panel>
    </div>
  );
};

export default CreateFlow;
