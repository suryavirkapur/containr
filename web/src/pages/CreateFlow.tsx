import { A, useSearchParams } from '@solidjs/router';
import { For, Show } from 'solid-js';
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
    <div class='flex flex-col gap-8'>
      <PageTitle
        title='New Service'
        subtitle='Create a repository-backed root service or attach a managed service to a group.'
      />

      <Show when={selectedGroupId()}>
        <Notice tone='info'>
          Managed templates created here will default to <strong class="font-semibold">{selectedGroupName() || 'the selected group'}</strong>.
          Repository-backed services always create their own network boundary.
        </Notice>
      </Show>

      <Panel title='Repository-Backed Services' subtitle='Each repository service defines a group root.'>
        <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4'>
          <For each={repoTypes}>
            {([value, label, description]) => (
              <A 
                class='group relative flex flex-col justify-between rounded-xl border bg-card text-card-foreground shadow-sm hover:border-primary hover:shadow-md transition-all p-5 h-full' 
                href={`/services/new/repo?type=${value}`}
              >
                <div>
                  <div class='flex items-center justify-between mb-3'>
                    <h3 class='font-semibold tracking-tight text-lg capitalize group-hover:text-primary transition-colors'>{label}</h3>
                    <span class='inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-primary text-primary-foreground'>New Boundary</span>
                  </div>
                  <p class='text-sm text-muted-foreground leading-relaxed'>{description}</p>
                </div>
                <div class='flex items-center justify-between mt-6 pt-4 border-t border-border'>
                  <span class='text-xs text-muted-foreground font-medium'>Continue to repo setup</span>
                  <span class='text-sm font-semibold text-primary group-hover:underline'>Open &rarr;</span>
                </div>
              </A>
            )}
          </For>
        </div>
      </Panel>

      <Panel title='Managed Templates' subtitle='Managed services can stay isolated or join an existing group.'>
        <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3'>
          <For each={templateTypes}>
            {([value, label, description]) => (
              <A 
                class='group relative flex flex-col justify-between rounded-xl border bg-card text-card-foreground shadow-sm hover:border-primary hover:shadow-md transition-all p-5 h-full' 
                href={templateHref(value)}
              >
                <div>
                  <div class='flex items-center justify-between mb-3'>
                    <h3 class='font-semibold tracking-tight text-lg capitalize group-hover:text-primary transition-colors'>{label}</h3>
                    <span class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider ${
                      selectedGroupId() ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800' : 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800'
                    }`}>
                      {selectedGroupId() ? 'Attachable' : 'Managed'}
                    </span>
                  </div>
                  <p class='text-sm text-muted-foreground leading-relaxed'>{description}</p>
                </div>
                <div class='flex items-center justify-between mt-6 pt-4 border-t border-border'>
                  <span class='text-xs text-muted-foreground font-medium'>
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
