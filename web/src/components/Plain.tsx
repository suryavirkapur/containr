import { type JSX, Show } from 'solid-js';

export const PageTitle = (props: { title: string; subtitle?: string; actions?: JSX.Element }) => (
  <header class='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
    <div>
      <h1 class='text-[1.9rem] font-semibold tracking-tight'>{props.title}</h1>
      <Show when={props.subtitle}>
        <p class='mt-1 text-sm text-muted-foreground'>{props.subtitle}</p>
      </Show>
    </div>
    <Show when={props.actions}>
      <div class='flex flex-wrap items-center gap-3'>{props.actions}</div>
    </Show>
  </header>
);

export const Panel = (props: { title?: string; subtitle?: string; children: JSX.Element; class?: string }) => (
  <section class={`rounded-lg border border-border bg-card text-card-foreground shadow-sm ${props.class || ''}`}>
    <Show when={props.title || props.subtitle}>
      <header class='flex flex-col gap-1 border-b border-border px-6 py-4'>
        <Show when={props.title}>
          <h2 class='text-lg font-semibold leading-none tracking-tight'>{props.title}</h2>
        </Show>
        <Show when={props.subtitle}>
          <p class='text-sm text-muted-foreground'>{props.subtitle}</p>
        </Show>
      </header>
    </Show>
    <div class='px-6 py-6'>
      {props.children}
    </div>
  </section>
);

export const Notice = (props: {
  tone?: 'info' | 'success' | 'error';
  title?: string;
  children: JSX.Element;
}) => {
  const tones = {
    info: 'bg-secondary text-foreground border-border',
    success: 'bg-[#f6ffed] text-[#135200] border-[#b7eb8f] dark:bg-green-950/30 dark:text-green-100 dark:border-green-900',
    error: 'bg-[#fff2f0] text-[#a8071a] border-[#ffccc7] dark:bg-red-950/30 dark:text-red-100 dark:border-red-900',
  };
  return (
    <div class={`relative w-full rounded-md border px-4 py-3 text-sm ${tones[props.tone ?? 'info']}`}>
      <Show when={props.title}>
        <h5 class='mb-1 font-medium leading-none tracking-tight'>{props.title}</h5>
      </Show>
      <div class='text-sm [&_p]:leading-relaxed'>{props.children}</div>
    </div>
  );
};

export const Field = (props: {
  label: string;
  hint?: string;
  children: JSX.Element;
}) => (
  <label class='flex flex-col gap-2'>
    <span class='text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70'>{props.label}</span>
    <Show when={props.hint}><small class='text-[0.8rem] text-muted-foreground'>{props.hint}</small></Show>
    {props.children}
  </label>
);

export const LoadingBlock = (props: { message?: string }) => (
  <Panel>
    <div class="flex items-center justify-center py-8 text-muted-foreground">
      <p>{props.message ?? 'Loading...'}</p>
    </div>
  </Panel>
);

export const EmptyBlock = (props: { title: string; children?: JSX.Element }) => (
  <Panel>
    <div class="flex flex-col items-center justify-center py-10 text-center">
      <p class='text-lg font-semibold'>{props.title}</p>
      <Show when={props.children}>
        <div class='mt-2 max-w-sm text-sm text-muted-foreground'>{props.children}</div>
      </Show>
    </div>
  </Panel>
);

export const KeyValueTable = (props: { rows: Array<[string, JSX.Element]> }) => (
  <dl class='grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4'>
    {props.rows.map(([label, value]) => (
      <div class='flex flex-col gap-1'>
        <dt class='text-xs font-semibold text-muted-foreground uppercase tracking-wider'>{label}</dt>
        <dd class='text-sm break-all'>{value}</dd>
      </div>
    ))}
  </dl>
);
