import { A, useNavigate, useSearchParams } from '@solidjs/router';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from 'solid-js';
import type { Service } from '../api/services';
import { EmptyBlock, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { StatusBadge } from '../components/StatusBadge';
import { useAppStore } from '../context/AppStore';
import { describeError, formatDateTime } from '../utils/format';
import {
  groupServices,
  humanize,
  type ServiceGroup,
} from '../utils/service-groups';

const endpointFor = (service: Service): string =>
  service.default_urls[0] ??
  service.proxy_connection_string ??
  service.connection_string ??
  (service.internal_host && service.port
    ? `${service.internal_host}:${service.port}`
    : 'internal only');

const ProjectCard = (props: {
  group: ServiceGroup;
  isActive: boolean;
  onClick: () => void;
}) => (
  <div
    class={`cr-project-card ${props.isActive ? 'bg-secondary' : ''}`}
    onClick={props.onClick}
  >
    <div class="flex items-start justify-between mb-2">
      <span class="text-sm font-medium">{props.group.label}</span>
      <span class="text-xs text-muted-foreground">
        {props.group.services.length} service{props.group.services.length !== 1 ? 's' : ''}
      </span>
    </div>
    <div class="flex flex-wrap gap-1">
      <For each={props.group.services.slice(0, 3)}>
        {(svc) => (
          <span class="cr-chip">{svc.name}</span>
        )}
      </For>
      <Show when={props.group.services.length > 3}>
        <span class="cr-chip text-muted-foreground">
          +{props.group.services.length - 3} more
        </span>
      </Show>
      <Show when={props.group.services.length === 0}>
        <span class="text-xs text-muted-foreground">No services</span>
      </Show>
    </div>
  </div>
);

const Services = () => {
  const store = useAppStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = createSignal('');
  const [actionError, setActionError] = createSignal<string | null>(null);

  createEffect(() => {
    void store.loadServices();
  });

  const pollInterval = setInterval(() => void store.loadServices(), 30000);
  onCleanup(() => clearInterval(pollInterval));

  const allServices = createMemo(() => store.state.services);
  const groups = createMemo(() => {
    // Only named groups (project_name set) = real "projects"
    const all = groupServices(allServices());
    return all.filter((g) => g.id !== null);
  });

  const filteredServices = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const activeGroup = searchParams.group ?? null;

    return allServices().filter((svc) => {
      if (
        needle &&
        ![
          svc.name,
          svc.service_type,
          svc.resource_kind,
          svc.network_name,
          svc.project_name ?? '',
          endpointFor(svc),
        ]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      ) {
        return false;
      }

      if (activeGroup) {
        const key = svc.group_id ?? null;
        if (key !== activeGroup) return false;
      }

      return true;
    });
  });

  const setGroupFilter = (groupId: string | null) => {
    setSearchParams({ group: groupId ?? undefined });
  };

  const activeGroupMeta = createMemo(() => {
    const g = searchParams.group;
    if (!g) return null;
    return groups().find((gr) => gr.id === g) ?? null;
  });

  return (
    <div class="flex flex-col gap-6">
      <PageTitle
        title="Services"
        actions={
          <A href="/services/new" class="cr-btn cr-btn-primary">
            + New Service
          </A>
        }
      />

      <Show when={actionError()}>
        {(msg) => <Notice tone="error">{msg()}</Notice>}
      </Show>

      {/* Projects section */}
      <Show when={groups().length > 0 || true}>
        <div>
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Projects
            </h2>
            <Show when={searchParams.group}>
              <button
                type="button"
                onClick={() => setGroupFilter(null)}
                class="text-xs text-muted-foreground hover:text-foreground"
              >
                Show all
              </button>
            </Show>
          </div>
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <For each={groups()}>
              {(group) => (
                <ProjectCard
                  group={group}
                  isActive={searchParams.group === group.id}
                  onClick={() =>
                    setGroupFilter(
                      searchParams.group === group.id ? null : group.id,
                    )
                  }
                />
              )}
            </For>
            <button
              type="button"
              class="cr-project-card-new"
              onClick={() => navigate('/services/new')}
            >
              <span>+</span>
              <span>New project</span>
            </button>
          </div>
        </div>
      </Show>

      {/* Services table */}
      <div>
        <div class="flex items-center justify-between mb-3 gap-4">
          <h2 class="text-xs font-medium uppercase tracking-widest text-muted-foreground shrink-0">
            {activeGroupMeta()
              ? `${activeGroupMeta()!.label} — Services`
              : 'All Services'}
          </h2>
          <input
            class="cr-input max-w-xs"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search..."
          />
        </div>

        <Show when={store.state.servicesError}>
          <Notice tone="error">
            Failed to load:{' '}{store.state.servicesError}
          </Notice>
        </Show>

        <Show when={store.state.servicesLoading}>
          <LoadingBlock message="Loading services..." />
        </Show>

        <Show
          when={!store.state.servicesLoading && filteredServices().length === 0}
        >
          <EmptyBlock title="No services found" />
        </Show>

        <Show
          when={!store.state.servicesLoading && filteredServices().length > 0}
        >
          <div class="cr-panel overflow-x-auto">
            <table class="cr-table min-w-[680px]">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Project</th>
                  <th>Endpoint</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                <For each={filteredServices()}>
                  {(svc) => (
                    <tr
                      class="cursor-pointer"
                      onClick={() => navigate(`/services/${svc.id}`)}
                    >
                      <td>
                        <div class="flex flex-col gap-0.5">
                          <A
                            class="text-sm font-medium hover:underline"
                            href={`/services/${svc.id}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {svc.name}
                          </A>
                          <div class="flex flex-wrap gap-1">
                            <span class="cr-chip">
                              {humanize(svc.service_type)}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={svc.status} />
                      </td>
                      <td class="text-muted-foreground text-xs">
                        {svc.project_name ?? '—'}
                      </td>
                      <td>
                        <span class="font-mono text-xs text-muted-foreground">
                          {endpointFor(svc).slice(0, 32)}
                          {endpointFor(svc).length > 32 ? '…' : ''}
                        </span>
                      </td>
                      <td class="text-xs text-muted-foreground">
                        {formatDateTime(svc.updated_at)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Services;
