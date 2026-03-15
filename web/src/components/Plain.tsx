import { type JSX, Show } from 'solid-js';

export const PageTitle = (props: { title: string; subtitle?: string; actions?: JSX.Element }) => (
  <header class='flex flex-col sm:flex-row justify-between items-start gap-4 mb-8'>
    <div>
      <h1 class='text-3xl font-bold tracking-tight'>{props.title}</h1>
      <Show when={props.subtitle}><p class='text-muted-foreground mt-1'>{props.subtitle}</p></Show>
    </div>
    <Show when={props.actions}><div class='flex items-center gap-3'>{props.actions}</div></Show>
  </header>
);

export const Panel = (props: { title?: string; subtitle?: string; children: JSX.Element; class?: string }) => (
  <section class={`rounded-xl border border-border bg-card text-card-foreground shadow-sm mb-6 ${props.class || ''}`}>
    <Show when={props.title || props.subtitle}>
      <header class='flex flex-col space-y-1.5 p-6 pb-4'>
        <Show when={props.title}><h2 class='font-semibold leading-none tracking-tight'>{props.title}</h2></Show>
        <Show when={props.subtitle}><p class='text-sm text-muted-foreground'>{props.subtitle}</p></Show>
      </header>
    </Show>
    <div class={`p-6 ${props.title || props.subtitle ? 'pt-0' : ''}`}>
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
    info: 'bg-muted text-foreground border-border',
    success: 'bg-green-50 text-green-900 border-green-200 dark:bg-green-900/20 dark:text-green-200 dark:border-green-900',
    error: 'bg-destructive/15 text-destructive border-destructive/20',
  };
  return (
    <div class={`relative w-full rounded-lg border p-4 mb-6 [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg+div]:translate-y-[-3px] [&:has(svg)]:pl-11 ${tones[props.tone ?? 'info']}`}>
      <Show when={props.title}><h5 class='mb-1 font-medium leading-none tracking-tight'>{props.title}</h5></Show>
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
    <div class="flex items-center justify-center py-6 text-muted-foreground">
      <p>{props.message ?? 'Loading...'}</p>
    </div>
  </Panel>
);

export const EmptyBlock = (props: { title: string; children?: JSX.Element }) => (
  <Panel>
    <div class="flex flex-col items-center justify-center py-10 text-center">
      <p class='text-lg font-semibold'>{props.title}</p>
      <Show when={props.children}><div class='text-sm text-muted-foreground mt-2 max-w-sm'>{props.children}</div></Show>
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
