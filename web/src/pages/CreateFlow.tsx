import { A, useSearchParams } from '@solidjs/router';
import { Show } from 'solid-js';
import { Notice, PageTitle } from '../components/Plain';

const repoTypes = [
  ['web_service', 'Web Service', 'Public HTTP service. Becomes the root of a network group.'],
  ['private_service', 'Private Service', 'Internal service with no public routing by default.'],
  ['background_worker', 'Background Worker', 'Long-running worker that defines its own boundary.'],
  ['cron_job', 'Cron Job', 'Scheduled job with no always-on container requirement.'],
] as const;

const templateTypes = [
  ['postgresql', 'PostgreSQL', 'Managed relational database.'],
  ['redis', 'Valkey / Redis', 'Managed in-memory store for caching.'],
  ['mariadb', 'MariaDB', 'Managed MySQL-compatible database.'],
  ['qdrant', 'Qdrant', 'Managed vector database for search and embeddings.'],
  ['rabbitmq', 'RabbitMQ', 'Managed queue service for background processing.'],
] as const;

const readParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

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
    <div class="flex flex-col gap-6 max-w-xl">
      <PageTitle
        title="New Service"
        subtitle="Deploy from a repository or attach a managed service."
      />

      <Show when={selectedGroupId()}>
        <Notice tone="info">
          Templates created here will join{' '}
          <strong class="font-medium">
            {selectedGroupName() || 'the selected group'}
          </strong>
          .
        </Notice>
      </Show>

      {/* Repo services */}
      <div class="flex flex-col gap-1">
        <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Repository
        </p>
        <div class="border border-border divide-y divide-border">
          {repoTypes.map(([value, label, description]) => (
            <A
              href={`/services/new/repo?type=${value}`}
              class="flex items-center justify-between px-4 py-3 bg-card hover:bg-secondary/30 transition-colors group"
            >
              <div>
                <p class="text-sm font-medium">{label}</p>
                <p class="text-xs text-muted-foreground mt-0.5">{description}</p>
              </div>
              <span class="text-muted-foreground text-sm group-hover:text-foreground transition-colors ml-4 shrink-0">
                →
              </span>
            </A>
          ))}
        </div>
      </div>

      {/* Managed templates */}
      <div class="flex flex-col gap-1">
        <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Managed Templates
        </p>
        <div class="border border-border divide-y divide-border">
          {templateTypes.map(([value, label, description]) => (
            <A
              href={templateHref(value)}
              class="flex items-center justify-between px-4 py-3 bg-card hover:bg-secondary/30 transition-colors group"
            >
              <div>
                <p class="text-sm font-medium">{label}</p>
                <p class="text-xs text-muted-foreground mt-0.5">{description}</p>
              </div>
              <span class="text-muted-foreground text-sm group-hover:text-foreground transition-colors ml-4 shrink-0">
                →
              </span>
            </A>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CreateFlow;
