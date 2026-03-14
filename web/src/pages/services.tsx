import { A, useSearchParams } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { listServices, runServiceAction, type Service } from '../api/services';
import { EmptyBlock, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { describeError, formatDateTime, formatList } from '../utils/format';
import { groupServices, humanize, listAttachableGroups } from '../utils/service-groups';

const endpointFor = (service: Service): string => {
  return (
    service.default_urls[0] ??
    service.proxy_connection_string ??
    service.connection_string ??
    (service.internal_host && service.port ? `${service.internal_host}:${service.port}` : 'internal only')
  );
};

const Services = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = createSignal('');
  const [statusFilter, setStatusFilter] = createSignal('all');
  const [kindFilter, setKindFilter] = createSignal('all');
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [services, { refetch }] = createResource(async () => listServices());

  const allServices = createMemo(() => services() ?? []);
  const allGroups = createMemo(() => groupServices(allServices()));
  const attachableGroups = createMemo(() => listAttachableGroups(allServices()));

  const stats = createMemo(() => ({
    total: allServices().length,
    groups: attachableGroups().length,
    managed: allServices().filter((service) => service.resource_kind !== 'app_service').length,
    running: allServices().reduce((count, service) => count + service.running_instances, 0),
  }));

  const statusOptions = createMemo(() =>
    [...new Set(allServices().map((service) => service.status))].sort((left, right) => left.localeCompare(right)),
  );
  const kindOptions = createMemo(() =>
    [...new Set(allServices().map((service) => service.resource_kind))].sort((left, right) => left.localeCompare(right)),
  );

  const filteredServices = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const activeGroup = searchParams.group ?? 'all';

    return allServices().filter((service) => {
      if (
        needle &&
        ![
          service.name,
          service.service_type,
          service.resource_kind,
          service.network_name,
          service.project_name ?? '',
          endpointFor(service),
        ]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      ) {
        return false;
      }

      if (statusFilter() !== 'all' && service.status !== statusFilter()) {
        return false;
      }

      if (kindFilter() !== 'all' && service.resource_kind !== kindFilter()) {
        return false;
      }

      if (activeGroup !== 'all') {
        const currentKey = service.group_id ?? `isolated:${service.network_name}`;
        if (currentKey !== activeGroup) return false;
      }

      return true;
    });
  });

  const groupedServices = createMemo(() => groupServices(filteredServices()));

  const runAction = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setActionError(null);
    setPendingId(id);
    try {
      await runServiceAction(id, action);
      await refetch();
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setPendingId(null);
    }
  };

  const setGroupFilter = (value: string) => {
    setSearchParams({ group: value === 'all' ? undefined : value });
  };

  return (
    <div class='stack'>
      <PageTitle
        title='services'
        subtitle='Groups are the network boundary. App services define them, and managed services can join them.'
        actions={
          <>
            <A href='/services/new'>new service</A>
            <button type='button' onClick={() => void refetch()}>
              refresh
            </button>
          </>
        }
      />

      <Show when={actionError()}>{(message) => <Notice tone='error'>{message()}</Notice>}</Show>

      <Show when={!services.loading && allServices().length > 0}>
        <div class='stats-grid'>
          <div class='stat-card'>
            <p class='muted'>services</p>
            <div class='stat-value'>{stats().total}</div>
            <p class='muted'>Everything active in this account.</p>
          </div>
          <div class='stat-card'>
            <p class='muted'>network groups</p>
            <div class='stat-value'>{stats().groups}</div>
            <p class='muted'>Repository-backed roots available for shared networking.</p>
          </div>
          <div class='stat-card'>
            <p class='muted'>managed services</p>
            <div class='stat-value'>{stats().managed}</div>
            <p class='muted'>Databases and queues you can place into a group.</p>
          </div>
          <div class='stat-card'>
            <p class='muted'>running instances</p>
            <div class='stat-value'>{stats().running}</div>
            <p class='muted'>Total live containers across the platform.</p>
          </div>
        </div>
      </Show>

      <Panel title='filter services' subtitle='Search by service, endpoint, network, or group.'>
        <div class='filter-grid'>
          <label class='field'>
            <span>query</span>
            <input
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder='search by name, endpoint, or network'
            />
          </label>
          <label class='field'>
            <span>status</span>
            <select value={statusFilter()} onChange={(event) => setStatusFilter(event.currentTarget.value)}>
              <option value='all'>all statuses</option>
              <For each={statusOptions()}>
                {(status) => <option value={status}>{humanize(status)}</option>}
              </For>
            </select>
          </label>
          <label class='field'>
            <span>kind</span>
            <select value={kindFilter()} onChange={(event) => setKindFilter(event.currentTarget.value)}>
              <option value='all'>all kinds</option>
              <For each={kindOptions()}>
                {(kind) => <option value={kind}>{humanize(kind)}</option>}
              </For>
            </select>
          </label>
        </div>

        <div class='field'>
          <span>group</span>
          <div class='segmented'>
            <button
              type='button'
              class={searchParams.group ? 'chip' : 'chip is-active'}
              onClick={() => setGroupFilter('all')}
            >
              all groups
            </button>
            <For each={allGroups()}>
              {(group) => (
                <button
                  type='button'
                  class={searchParams.group === group.key ? 'chip is-active' : 'chip'}
                  onClick={() => setGroupFilter(group.key)}
                >
                  {group.filterLabel}
                </button>
              )}
            </For>
          </div>
        </div>
      </Panel>

      <Show when={services.error}>
        {(error) => <Notice tone='error'>Failed to load services: {describeError(error())}</Notice>}
      </Show>

      <Show when={services.loading} fallback={null}>
        <LoadingBlock message='Loading services...' />
      </Show>

      <Show when={!services.loading && filteredServices().length === 0}>
        <EmptyBlock title='No services match the current filters'>
          Clear the filters or create a new service from a repo or a managed template.
        </EmptyBlock>
      </Show>

      <Show when={!services.loading && filteredServices().length > 0}>
        <div class='group-stack'>
          <For each={groupedServices()}>
            {(group) => (
              <Panel
                title={group.label}
                subtitle={
                  group.id
                    ? `${group.services.length} service${group.services.length === 1 ? '' : 's'} on ${group.networkName}`
                    : `Isolated boundary on ${group.networkName}`
                }
              >
                <div class='stack'>
                  <div class='group-head'>
                    <div class='badge-row'>
                      <span class='badge'>{group.runningCount} running</span>
                      <span class='badge'>{group.managedCount} managed</span>
                      <span class='badge mono'>{group.networkName}</span>
                    </div>
                    <div class='group-actions'>
                      <Show when={group.id} fallback={<A href='/services/new'>create service</A>}>
                        <A href={`/services/new?group_id=${group.id!}&group_name=${encodeURIComponent(group.label)}`}>
                          add database or queue
                        </A>
                      </Show>
                    </div>
                  </div>

                  <div class='service-grid'>
                    <For each={group.services}>
                      {(service) => (
                        <article class='service-card'>
                          <div class='service-card-head'>
                            <div>
                              <A class='service-title' href={`/services/${service.id}`}>
                                {service.name}
                              </A>
                              <p class='muted'>
                                {humanize(service.service_type)} / {humanize(service.resource_kind)}
                              </p>
                            </div>
                            <span class={`status-pill status-${service.status}`}>{humanize(service.status)}</span>
                          </div>

                          <div class='service-card-meta'>
                            <span class='badge mono'>{endpointFor(service)}</span>
                            <Show when={service.domains.length > 0}>
                              <span class='badge'>
                                {service.domains.length} domain{service.domains.length === 1 ? '' : 's'}
                              </span>
                            </Show>
                            <Show when={service.container_ids.length > 0}>
                              <span class='badge'>
                                {service.container_ids.length} container{service.container_ids.length === 1 ? '' : 's'}
                              </span>
                            </Show>
                          </div>

                            <div class='summary-grid'>
                              <div class='summary-card'>
                                <p class='muted'>network</p>
                                <p class='mono'>{service.network_name}</p>
                              </div>
                            <div class='summary-card'>
                              <p class='muted'>updated</p>
                              <p>{formatDateTime(service.updated_at)}</p>
                            </div>
                              <div class='summary-card'>
                                <p class='muted'>containers</p>
                                <Show
                                  when={service.container_ids.length > 0}
                                  fallback={<p>none</p>}
                                >
                                  <div class='link-list'>
                                    <For each={service.container_ids}>
                                      {(containerId) => <A href={`/containers/${containerId}`}>{containerId}</A>}
                                    </For>
                                  </div>
                                </Show>
                              </div>
                            </div>

                          <div class='service-card-actions'>
                            <A href={`/services/${service.id}`}>open</A>
                            <button
                              type='button'
                              onClick={() => void runAction(service.id, 'restart')}
                              disabled={pendingId() === service.id}
                            >
                              restart
                            </button>
                            <button
                              type='button'
                              onClick={() => void runAction(service.id, service.running_instances > 0 ? 'stop' : 'start')}
                              disabled={pendingId() === service.id}
                            >
                              {service.running_instances > 0 ? 'stop' : 'start'}
                            </button>
                          </div>
                        </article>
                      )}
                    </For>
                  </div>
                </div>
              </Panel>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default Services;
