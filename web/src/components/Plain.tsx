import { type JSX, Show } from 'solid-js';

export const PageTitle = (props: { title: string; subtitle?: string; actions?: JSX.Element }) => (
  <header class='page-head'>
    <div>
      <h1>{props.title}</h1>
      <Show when={props.subtitle}><p class='muted'>{props.subtitle}</p></Show>
    </div>
    <Show when={props.actions}><div class='page-actions'>{props.actions}</div></Show>
  </header>
);

export const Panel = (props: { title?: string; subtitle?: string; children: JSX.Element }) => (
  <section class='panel'>
    <Show when={props.title || props.subtitle}>
      <header class='panel-head'>
        <Show when={props.title}><h2>{props.title}</h2></Show>
        <Show when={props.subtitle}><p class='muted'>{props.subtitle}</p></Show>
      </header>
    </Show>
    <div>{props.children}</div>
  </section>
);

export const Notice = (props: {
  tone?: 'info' | 'success' | 'error';
  title?: string;
  children: JSX.Element;
}) => (
  <div class={`notice notice-${props.tone ?? 'info'}`}>
    <Show when={props.title}><strong>{props.title}</strong></Show>
    <div>{props.children}</div>
  </div>
);

export const Field = (props: {
  label: string;
  hint?: string;
  children: JSX.Element;
}) => (
  <label class='field'>
    <span>{props.label}</span>
    <Show when={props.hint}><small class='muted'>{props.hint}</small></Show>
    {props.children}
  </label>
);

export const LoadingBlock = (props: { message?: string }) => (
  <div class='panel'>
    <p>{props.message ?? 'Loading...'}</p>
  </div>
);

export const EmptyBlock = (props: { title: string; children?: JSX.Element }) => (
  <div class='panel'>
    <p><strong>{props.title}</strong></p>
    <Show when={props.children}><div class='muted'>{props.children}</div></Show>
  </div>
);

export const KeyValueTable = (props: { rows: Array<[string, JSX.Element]> }) => (
  <dl class='kv-grid'>
    {props.rows.map(([label, value]) => (
      <div class='kv-item'>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);
