import { type JSX, Show } from 'solid-js';

export const PageTitle = (props: {
  title: string;
  subtitle?: string;
  actions?: JSX.Element;
}) => (
  <header class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
    <div>
      <h1 class="text-xl font-semibold tracking-tight">{props.title}</h1>
      <Show when={props.subtitle}>
        <p class="text-sm text-muted-foreground mt-0.5">{props.subtitle}</p>
      </Show>
    </div>
    <Show when={props.actions}>
      <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
    </Show>
  </header>
);

export const Panel = (props: {
  title?: string;
  subtitle?: string;
  children: JSX.Element;
  class?: string;
  actions?: JSX.Element;
}) => (
  <section class={`cr-panel ${props.class ?? ''}`}>
    <Show when={props.title || props.subtitle}>
      <header class="cr-panel-header flex-row items-center justify-between" style="display:flex">
        <div>
          <Show when={props.title}>
            <h2 class="text-sm font-semibold">{props.title}</h2>
          </Show>
          <Show when={props.subtitle}>
            <p class="text-xs text-muted-foreground mt-0.5">{props.subtitle}</p>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="flex items-center gap-2">{props.actions}</div>
        </Show>
      </header>
    </Show>
    <div class="cr-panel-body">{props.children}</div>
  </section>
);

export const Notice = (props: {
  tone?: 'info' | 'success' | 'error';
  title?: string;
  children: JSX.Element;
}) => {
  const cls = () => {
    switch (props.tone) {
      case 'success': return 'cr-notice cr-notice-success';
      case 'error': return 'cr-notice cr-notice-error';
      default: return 'cr-notice cr-notice-info';
    }
  };
  return (
    <div class={cls()}>
      <Show when={props.title}>
        <p class="font-medium mb-1">{props.title}</p>
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
  <label class="cr-field">
    <span class="cr-label">{props.label}</span>
    <Show when={props.hint}>
      <small class="text-xs text-muted-foreground">{props.hint}</small>
    </Show>
    {props.children}
  </label>
);

export const LoadingBlock = (props: { message?: string }) => (
  <div class="flex items-center justify-center py-16 text-muted-foreground text-sm">
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
      <div class="mt-1 max-w-xs text-xs text-muted-foreground">
        {props.children}
      </div>
    </Show>
  </div>
);

export const KeyValueTable = (props: {
  rows: Array<[string, JSX.Element]>;
}) => (
  <dl class="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
    {props.rows.map(([label, value]) => (
      <div class="flex flex-col gap-1">
        <dt class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </dt>
        <dd class="text-sm break-all">{value}</dd>
      </div>
    ))}
  </dl>
);
