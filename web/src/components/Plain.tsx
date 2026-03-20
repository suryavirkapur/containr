import { type JSX, Show } from 'solid-js';

export const PageTitle = (props: {
  title: string;
  subtitle?: string;
  actions?: JSX.Element;
}) => (
  <header class="flex flex-col sm:flex-row justify-between items-start gap-3 mb-6">
    <div>
      <h1 class="text-xl font-semibold tracking-tight">{props.title}</h1>
      <Show when={props.subtitle}>
        <p class="text-sm text-muted-foreground mt-0.5">{props.subtitle}</p>
      </Show>
    </div>
    <Show when={props.actions}>
      <div class="flex items-center gap-2">{props.actions}</div>
    </Show>
  </header>
);

export const Panel = (props: {
  title?: string;
  subtitle?: string;
  children: JSX.Element;
  class?: string;
}) => (
  <section
    class={`border border-border bg-card text-card-foreground mb-4 ${props.class ?? ''}`}
  >
    <Show when={props.title || props.subtitle}>
      <header class="flex flex-col space-y-0.5 px-5 py-4 border-b border-border">
        <Show when={props.title}>
          <h2 class="text-sm font-medium leading-none">{props.title}</h2>
        </Show>
        <Show when={props.subtitle}>
          <p class="text-xs text-muted-foreground">{props.subtitle}</p>
        </Show>
      </header>
    </Show>
    <div class={`p-5 ${props.title || props.subtitle ? '' : ''}`}>
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
    success:
      'bg-green-950/40 text-green-300 border-green-900',
    error:
      'bg-red-950/40 text-red-300 border-red-900',
  };
  return (
    <div
      class={`w-full border px-4 py-3 mb-4 text-sm ${tones[props.tone ?? 'info']}`}
    >
      <Show when={props.title}>
        <p class="font-medium mb-0.5">{props.title}</p>
      </Show>
      <div>{props.children}</div>
    </div>
  );
};

export const Field = (props: {
  label: string;
  hint?: string;
  children: JSX.Element;
}) => (
  <label class="flex flex-col gap-1.5">
    <span class="text-sm font-medium leading-none">{props.label}</span>
    <Show when={props.hint}>
      <small class="text-xs text-muted-foreground">{props.hint}</small>
    </Show>
    {props.children}
  </label>
);

export const LoadingBlock = (props: { message?: string }) => (
  <div class="flex items-center justify-center py-12 text-sm text-muted-foreground">
    <p>{props.message ?? 'Loading...'}</p>
  </div>
);

export const EmptyBlock = (props: {
  title: string;
  children?: JSX.Element;
}) => (
  <div class="flex flex-col items-center justify-center py-16 text-center">
    <p class="text-sm font-medium text-muted-foreground">{props.title}</p>
    <Show when={props.children}>
      <div class="text-sm text-muted-foreground mt-1 max-w-sm">
        {props.children}
      </div>
    </Show>
  </div>
);

export const KeyValueTable = (props: {
  rows: Array<[string, JSX.Element]>;
}) => (
  <dl class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
    {props.rows.map(([label, value]) => (
      <div class="flex flex-col gap-0.5">
        <dt class="text-xs text-muted-foreground uppercase tracking-wider">
          {label}
        </dt>
        <dd class="text-sm break-all">{value}</dd>
      </div>
    ))}
  </dl>
);
