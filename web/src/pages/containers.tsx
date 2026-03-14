import { A } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { listContainers } from '../api/containers';
import { EmptyBlock, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { describeError } from '../utils/format';

const Containers = () => {
  const [query, setQuery] = createSignal('');
  const [containers, { refetch }] = createResource(listContainers);

  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return containers() ?? [];
    return (containers() ?? []).filter((container) =>
      [container.id, container.name, container.resource_type, container.resource_id]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  });

  return (
    <div class='stack'>
      <PageTitle
        title='containers'
        subtitle='Inspect runtime containers, mounts, logs, files, and shell access.'
        actions={<button type='button' onClick={() => void refetch()}>refresh</button>}
      />

      <Panel title='filter containers'>
        <label class='field'>
          <span>query</span>
          <input
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder='search by id, name, or resource'
          />
        </label>
      </Panel>

      <Show when={containers.loading}>
        <LoadingBlock message='Loading containers...' />
      </Show>

      <Show when={containers.error}>
        {(error) => <Notice tone='error'>Failed to load containers: {describeError(error())}</Notice>}
      </Show>

      <Show when={!containers.loading && filtered().length === 0}>
        <EmptyBlock title='No containers available'>
          Start a service or deployment and its active containers will appear here.
        </EmptyBlock>
      </Show>

      <Show when={!containers.loading && filtered().length > 0}>
        <div class='repo-grid'>
          <For each={filtered()}>
            {(container) => (
              <article class='repo-card'>
                <div class='choice-card-head'>
                  <div>
                    <A class='service-title' href={`/containers/${container.id}`}>
                      {container.name}
                    </A>
                    <p class='muted mono'>{container.id}</p>
                  </div>
                  <span class='badge'>{container.resource_type}</span>
                </div>
                <div class='summary-grid'>
                  <div class='summary-card'>
                    <p class='muted'>resource id</p>
                    <p class='mono'>{container.resource_id}</p>
                  </div>
                </div>
                <div class='button-row'>
                  <A href={`/containers/${container.id}`}>open container</A>
                </div>
              </article>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default Containers;
