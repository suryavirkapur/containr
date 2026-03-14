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
    <div class='stack'>
      <PageTitle
        title='new service'
        subtitle='Create a repository-backed root service or attach a managed service to a group.'
      />

      <Show when={selectedGroupId()}>
        <Notice tone='info'>
          Managed templates created here will default to <strong>{selectedGroupName() || 'the selected group'}</strong>.
          Repository-backed services always create their own network boundary.
        </Notice>
      </Show>

      <Panel title='repository-backed services' subtitle='Each repository service defines a group root.'>
        <div class='choice-grid'>
          <For each={repoTypes}>
            {([value, label, description]) => (
              <A class='choice-card' href={`/services/new/repo?type=${value}`}>
                <div class='choice-card-head'>
                  <div>
                    <h3>{label}</h3>
                    <p class='muted'>{description}</p>
                  </div>
                  <span class='badge'>new boundary</span>
                </div>
                <div class='choice-meta'>
                  <span class='muted'>continue to repo setup</span>
                  <strong>open</strong>
                </div>
              </A>
            )}
          </For>
        </div>
      </Panel>

      <Panel title='managed templates' subtitle='Managed services can stay isolated or join an existing group.'>
        <div class='choice-grid'>
          <For each={templateTypes}>
            {([value, label, description]) => (
              <A class='choice-card' href={templateHref(value)}>
                <div class='choice-card-head'>
                  <div>
                    <h3>{label}</h3>
                    <p class='muted'>{description}</p>
                  </div>
                  <span class='badge'>{selectedGroupId() ? 'attachable' : 'managed'}</span>
                </div>
                <div class='choice-meta'>
                  <span class='muted'>
                    {selectedGroupId() ? `join ${selectedGroupName() || 'selected group'}` : 'pick placement next'}
                  </span>
                  <strong>open</strong>
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
