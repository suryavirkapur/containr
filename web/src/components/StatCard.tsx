import { type JSX, Show } from 'solid-js';

type Props = {
  title: string;
  value: JSX.Element | string | number;
  description?: string;
  icon?: JSX.Element;
  iconBg?: string;
  trend?: { value: number; label: string };
  class?: string;
};

export const StatCard = (props: Props) => {
  return (
    <div class={`rounded-lg border border-border bg-card text-card-foreground shadow-sm p-5 flex flex-col gap-3 ${props.class ?? ''}`}>
      <div class="flex items-center justify-between">
        <p class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{props.title}</p>
        <Show when={props.icon}>
          <div class={`rounded-md p-2 ${props.iconBg ?? 'bg-secondary'}`}>
            {props.icon}
          </div>
        </Show>
      </div>
      <div class="text-[1.8rem] font-semibold tracking-tight">{props.value}</div>
      <Show when={props.description}>
        <p class="text-xs text-muted-foreground">{props.description}</p>
      </Show>
      <Show when={props.trend}>
        {(trend) => (
          <div class="flex items-center gap-1.5 text-xs">
            <span class={trend().value >= 0 ? 'text-green-600' : 'text-red-600'}>
              {trend().value >= 0 ? '+' : ''}{trend().value}%
            </span>
            <span class="text-muted-foreground">{trend().label}</span>
          </div>
        )}
      </Show>
    </div>
  );
};
