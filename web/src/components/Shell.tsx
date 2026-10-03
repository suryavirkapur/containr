import { Navigate } from '@solidjs/router';
import { ErrorBoundary, type JSX, Match, Switch } from 'solid-js';
import { useAuth } from '../context/AuthContext';
import { describeError } from '../utils/format';
import { LoadingBlock, Notice } from './Plain';
import { Sidebar } from './Sidebar';

export const Shell = (props: { children?: JSX.Element }) => {
  const auth = useAuth();

  // solid component bodies run once: auth checks must be reactive so the
  // shell updates after refreshUser() resolves or the user logs out.
  return (
    <Switch>
      <Match when={!auth.ready()}>
        <main class="min-h-screen bg-background text-foreground flex items-center justify-center">
          <LoadingBlock message="Loading..." />
        </main>
      </Match>
      <Match when={!auth.isAuthenticated()}>
        <Navigate href="/login" />
      </Match>
      <Match when={true}>
        <div class="min-h-screen bg-background text-foreground flex">
          <Sidebar />
          <main class="flex-1 min-w-0 lg:ml-[220px]">
            <div class="mx-auto max-w-[1280px] p-6 lg:p-8">
              <ErrorBoundary
                fallback={(error, reset) => (
                  <div class="flex flex-col items-start gap-3">
                    <Notice tone="error">{describeError(error)}</Notice>
                    <button type="button" class="cr-btn cr-btn-secondary" onClick={reset}>
                      Retry
                    </button>
                  </div>
                )}
              >
                {props.children}
              </ErrorBoundary>
            </div>
          </main>
        </div>
      </Match>
    </Switch>
  );
};

export const PublicShell = (props: {
  title: string;
  subtitle?: string;
  children?: JSX.Element;
}) => (
  <main class="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
    <div class="w-full max-w-sm">
      <div class="mb-8">
        <div class="text-xs font-medium uppercase tracking-widest text-muted-foreground mb-2">
          containr
        </div>
        <h1 class="text-2xl font-semibold tracking-tight">{props.title}</h1>
        {props.subtitle && (
          <p class="text-sm text-muted-foreground mt-1">{props.subtitle}</p>
        )}
      </div>
      <div class="border border-border bg-card p-6">
        {props.children}
      </div>
    </div>
  </main>
);
