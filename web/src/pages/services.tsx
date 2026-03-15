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
    <div class='flex flex-col gap-6'>
      <PageTitle
        title='Services'
        subtitle='Groups are the network boundary. App services define them, and managed services can join them.'
        actions={
          <>
            <A 
              href='/services/new'
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2"
            >
              New Service
            </A>
            <button 
              type='button' 
              onClick={() => void refetch()}
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
            >
              Refresh
            </button>
          </>
        }
      />

      <Show when={actionError()}>{(message) => <Notice tone='error'>{message()}</Notice>}</Show>

      <Show when={!services.loading && allServices().length > 0}>
        <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
          <div class='rounded-xl border bg-card text-card-foreground shadow-sm p-6 flex flex-col gap-2'>
            <p class='text-sm text-muted-foreground font-medium'>Services</p>
            <div class='text-3xl font-bold tracking-tight'>{stats().total}</div>
            <p class='text-xs text-muted-foreground'>Everything active in this account.</p>
          </div>
          <div class='rounded-xl border bg-card text-card-foreground shadow-sm p-6 flex flex-col gap-2'>
            <p class='text-sm text-muted-foreground font-medium'>Network Groups</p>
            <div class='text-3xl font-bold tracking-tight'>{stats().groups}</div>
            <p class='text-xs text-muted-foreground'>Repository-backed roots available for shared networking.</p>
          </div>
          <div class='rounded-xl border bg-card text-card-foreground shadow-sm p-6 flex flex-col gap-2'>
            <p class='text-sm text-muted-foreground font-medium'>Managed Services</p>
            <div class='text-3xl font-bold tracking-tight'>{stats().managed}</div>
            <p class='text-xs text-muted-foreground'>Databases and queues you can place into a group.</p>
          </div>
          <div class='rounded-xl border bg-card text-card-foreground shadow-sm p-6 flex flex-col gap-2'>
            <p class='text-sm text-muted-foreground font-medium'>Running Instances</p>
            <div class='text-3xl font-bold tracking-tight'>{stats().running}</div>
            <p class='text-xs text-muted-foreground'>Total live containers across the platform.</p>
          </div>
        </div>
      </Show>

      <Panel title='Filter Services' subtitle='Search by service, endpoint, network, or group.'>
        <div class='grid gap-4 md:grid-cols-3 mb-6'>
          <label class='flex flex-col gap-2'>
            <span class='text-sm font-medium leading-none'>Query</span>
            <input
              class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder='Search by name, endpoint, or network...'
            />
          </label>
          <label class='flex flex-col gap-2'>
            <span class='text-sm font-medium leading-none'>Status</span>
            <select 
              class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={statusFilter()} 
              onChange={(event) => setStatusFilter(event.currentTarget.value)}
            >
              <option value='all'>All Statuses</option>
              <For each={statusOptions()}>
                {(status) => <option value={status}>{humanize(status)}</option>}
              </For>
            </select>
          </label>
          <label class='flex flex-col gap-2'>
            <span class='text-sm font-medium leading-none'>Kind</span>
            <select 
              class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={kindFilter()} 
              onChange={(event) => setKindFilter(event.currentTarget.value)}
            >
              <option value='all'>All Kinds</option>
              <For each={kindOptions()}>
                {(kind) => <option value={kind}>{humanize(kind)}</option>}
              </For>
            </select>
          </label>
        </div>

        <div class='flex flex-col gap-2'>
          <span class='text-sm font-medium leading-none'>Group</span>
          <div class='flex flex-wrap gap-2'>
            <button
              type='button'
              class={`inline-flex items-center justify-center rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
                !searchParams.group ? 'border-primary/20 bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-secondary/80'
              }`}
              onClick={() => setGroupFilter('all')}
            >
              All Groups
            </button>
            <For each={allGroups()}>
              {(group) => (
                <button
                  type='button'
                  class={`inline-flex items-center justify-center rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
                    searchParams.group === group.key ? 'border-primary/20 bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-secondary/80'
                  }`}
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
        <div class='flex flex-col gap-8'>
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
                <div class='flex flex-col gap-4'>
                  <div class='flex flex-wrap items-center justify-between gap-4 mb-2'>
                    <div class='flex flex-wrap gap-2'>
                      <span class='inline-flex items-center rounded-full border border-border bg-secondary text-secondary-foreground px-2.5 py-0.5 text-xs font-semibold'>{group.runningCount} running</span>
                      <span class='inline-flex items-center rounded-full border border-border bg-secondary text-secondary-foreground px-2.5 py-0.5 text-xs font-semibold'>{group.managedCount} managed</span>
                      <span class='inline-flex items-center rounded-full border border-border bg-secondary text-secondary-foreground px-2.5 py-0.5 text-xs font-semibold font-mono'>{group.networkName}</span>
                    </div>
                    <div class='flex items-center gap-2'>
                      <Show when={group.id} fallback={
                        <A href='/services/new' class="text-sm text-primary hover:underline font-medium">Create Service</A>
                      }>
                        <A 
                          href={`/services/new?group_id=${group.id!}&group_name=${encodeURIComponent(group.label)}`}
                          class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3"
                        >
                          Add Database or Queue
                        </A>
                      </Show>
                    </div>
                  </div>

                  <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                    <For each={group.services}>
                      {(service) => (
                        <article class='rounded-xl border bg-card text-card-foreground shadow-sm p-5 flex flex-col gap-4 hover:border-primary/20 transition-colors'>
                          <div class='flex justify-between items-start gap-4'>
                            <div>
                              <A class='font-semibold tracking-tight hover:underline text-lg' href={`/services/${service.id}`}>
                                {service.name}
                              </A>
                              <p class='text-xs text-muted-foreground mt-0.5 uppercase tracking-wider font-semibold'>
                                {humanize(service.service_type)} / {humanize(service.resource_kind)}
                              </p>
                            </div>
                            <span class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider ${
                              service.status === 'running' || service.status === 'success' ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800' :
                              service.status === 'failed' || service.status === 'error' ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800' :
                              service.status === 'pending' || service.status === 'starting' ? 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-400 dark:border-yellow-800' :
                              'bg-muted text-muted-foreground border-border'
                            }`}>
                              {humanize(service.status)}
                            </span>
                          </div>

                          <div class='flex flex-wrap gap-2 text-xs'>
                            <span class='inline-flex items-center rounded border border-border bg-secondary/50 px-2 py-0.5 font-mono truncate max-w-full'>{endpointFor(service)}</span>
                            <Show when={service.domains.length > 0}>
                              <span class='inline-flex items-center rounded border border-border bg-secondary/50 px-2 py-0.5'>
                                {service.domains.length} domain{service.domains.length === 1 ? '' : 's'}
                              </span>
                            </Show>
                            <Show when={service.container_ids.length > 0}>
                              <span class='inline-flex items-center rounded border border-border bg-secondary/50 px-2 py-0.5'>
                                {service.container_ids.length} container{service.container_ids.length === 1 ? '' : 's'}
                              </span>
                            </Show>
                          </div>

                          <div class='grid grid-cols-2 gap-4 pt-4 border-t border-border mt-auto'>
                            <div class='flex flex-col gap-1'>
                              <p class='text-[0.7rem] font-semibold uppercase text-muted-foreground tracking-wider'>Network</p>
                              <p class='text-xs font-mono truncate'>{service.network_name}</p>
                            </div>
                            <div class='flex flex-col gap-1'>
                              <p class='text-[0.7rem] font-semibold uppercase text-muted-foreground tracking-wider'>Updated</p>
                              <p class='text-xs truncate'>{formatDateTime(service.updated_at)}</p>
                            </div>
                            <div class='flex flex-col gap-1 col-span-2'>
                              <p class='text-[0.7rem] font-semibold uppercase text-muted-foreground tracking-wider'>Containers</p>
                              <Show
                                when={service.container_ids.length > 0}
                                fallback={<p class="text-xs text-muted-foreground">None</p>}
                              >
                                <div class='flex flex-col gap-1'>
                                  <For each={service.container_ids}>
                                    {(containerId) => <A class="text-xs text-primary hover:underline font-mono truncate" href={`/containers/${containerId}`}>{containerId}</A>}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          </div>

                          <div class='flex justify-end gap-2 pt-4 border-t border-border'>
                            <A 
                              href={`/services/${service.id}`}
                              class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3"
                            >
                              Open
                            </A>
                            <button
                              type='button'
                              class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3 disabled:opacity-50"
                              onClick={() => void runAction(service.id, 'restart')}
                              disabled={pendingId() === service.id}
                            >
                              Restart
                            </button>
                            <button
                              type='button'
                              class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3 disabled:opacity-50"
                              onClick={() => void runAction(service.id, service.running_instances > 0 ? 'stop' : 'start')}
                              disabled={pendingId() === service.id}
                            >
                              {service.running_instances > 0 ? 'Stop' : 'Start'}
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
