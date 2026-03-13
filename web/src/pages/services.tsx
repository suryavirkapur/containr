import { A } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { listServices, runServiceAction, type Service } from '../api/services';
import { EmptyBlock, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { describeError, formatDateTime, formatList } from '../utils/format';

const endpointFor = (service: Service): string => {
  return (
    service.default_urls[0] ??
    service.proxy_connection_string ??
    service.connection_string ??
    (service.internal_host && service.port ? `${service.internal_host}:${service.port}` : 'internal only')
  );
};

const Services = () => {
  const [query, setQuery] = createSignal('');
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [services, { refetch }] = createResource(async () => listServices());

  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return services() ?? [];
    return (services() ?? []).filter((service) =>
      [service.name, service.service_type, service.resource_kind, service.network_name, endpointFor(service)]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  });

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

  return (
    <div class='stack'>
      <PageTitle
        title='services'
        subtitle='Everything is listed in one table. Open a row to edit, deploy, or inspect logs.'
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

      <Panel title='search'>
        <div class='field'>
          <span>query</span>
          <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
        </div>
      </Panel>

      <Show when={services.error}>
        {(error) => <Notice tone='error'>Failed to load services: {describeError(error())}</Notice>}
      </Show>

      <Show when={services.loading} fallback={null}>
        <LoadingBlock message='Loading services...' />
      </Show>

      <Show when={!services.loading && filtered().length === 0}>
        <EmptyBlock title='No services yet'>Create one from a repo or a managed template.</EmptyBlock>
      </Show>

      <Show when={!services.loading && filtered().length > 0}>
        <Panel title='inventory' subtitle={`${filtered().length} row(s)`}>
          <div class='table-wrap'>
            <table>
              <thead>
                <tr>
                  <th>name</th>
                  <th>kind</th>
                  <th>status</th>
                  <th>endpoint</th>
                  <th>network</th>
                  <th>containers</th>
                  <th>updated</th>
                  <th>actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={filtered()}>
                  {(service) => (
                    <tr>
                      <td>
                        <A href={`/services/${service.id}`}>{service.name}</A>
                      </td>
                      <td>
                        <div>{service.service_type}</div>
                        <div class='muted'>{service.resource_kind}</div>
                      </td>
                      <td class={`status-${service.status}`}>{service.status}</td>
                      <td class='mono'>{endpointFor(service)}</td>
                      <td>{service.network_name}</td>
                      <td>{formatList(service.container_ids)}</td>
                      <td>{formatDateTime(service.updated_at)}</td>
                      <td>
                        <div class='inline-actions'>
                          <button type='button' onClick={() => void runAction(service.id, 'restart')} disabled={pendingId() === service.id}>
                            restart
                          </button>
                          <button type='button' onClick={() => void runAction(service.id, service.running_instances > 0 ? 'stop' : 'start')} disabled={pendingId() === service.id}>
                            {service.running_instances > 0 ? 'stop' : 'start'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Panel>
      </Show>
    </div>
  );
};

export default Services;
