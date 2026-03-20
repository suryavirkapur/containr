import { type JSX, Show } from 'solid-js';

type Status = 'running' | 'success' | 'failed' | 'error' | 'pending' | 'starting' | 'stopped' | 'deploying' | 'restarting';

type Props = {
  status: Status | string;
  animate?: boolean;
  size?: 'sm' | 'md';
  showDot?: boolean;
};

const statusConfig: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  running: { bg: 'bg-green-500/10', text: 'text-green-700', border: 'border-green-500/20', dot: 'bg-green-500' },
  success: { bg: 'bg-green-500/10', text: 'text-green-700', border: 'border-green-500/20', dot: 'bg-green-500' },
  failed: { bg: 'bg-red-500/10', text: 'text-red-700', border: 'border-red-500/20', dot: 'bg-red-500' },
  error: { bg: 'bg-red-500/10', text: 'text-red-700', border: 'border-red-500/20', dot: 'bg-red-500' },
  pending: { bg: 'bg-yellow-500/10', text: 'text-yellow-700', border: 'border-yellow-500/20', dot: 'bg-yellow-500' },
  starting: { bg: 'bg-yellow-500/10', text: 'text-yellow-700', border: 'border-yellow-500/20', dot: 'bg-yellow-500' },
  deploying: { bg: 'bg-blue-500/10', text: 'text-blue-700', border: 'border-blue-500/20', dot: 'bg-blue-500' },
  restarting: { bg: 'bg-blue-500/10', text: 'text-blue-700', border: 'border-blue-500/20', dot: 'bg-blue-500' },
  stopped: { bg: 'bg-muted', text: 'text-muted-foreground', border: 'border-border', dot: 'bg-muted-foreground' },
};

const humanize = (s: string) => s.replace(/_/g, ' ');

export const StatusBadge = (props: Props) => {
  const config = () => statusConfig[props.status] ?? statusConfig.stopped;
  const size = () => props.size ?? 'sm';
  const shouldAnimate = () => props.animate ?? ['deploying', 'restarting', 'starting', 'pending'].includes(props.status);

  return (
    <span class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${config().bg} ${config().text} ${config().border}`}>
      <Show when={props.showDot !== false}>
        <span class={`relative flex h-2 w-2 ${shouldAnimate() ? 'animate-pulse' : ''}`}>
          <Show when={shouldAnimate()}>
            <span class={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping ${config().dot.replace('bg-', 'bg-opacity-')}`} />
          </Show>
          <span class={`relative inline-flex h-2 w-2 rounded-full ${config().dot}`} />
        </span>
      </Show>
      <span class={size() === 'md' ? 'text-sm' : 'text-[0.65rem]'}>{humanize(props.status)}</span>
    </span>
  );
};

export const StatusDot = (props: { status: Status | string; size?: 'sm' | 'md' }) => {
  const config = () => statusConfig[props.status] ?? statusConfig.stopped;
  const shouldAnimate = () => ['deploying', 'restarting', 'starting', 'pending'].includes(props.status);
  const size = () => props.size === 'md' ? 'h-3 w-3' : 'h-2 w-2';

  return (
    <span class={`relative flex ${size()} ${shouldAnimate() ? 'animate-pulse' : ''}`}>
      <Show when={shouldAnimate()}>
        <span class={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping ${config().dot}`} />
      </Show>
      <span class={`relative inline-flex rounded-full ${size()} ${config().dot}`} />
    </span>
  );
};
