import type { JSX } from 'solid-js';
import { Navigate } from '@solidjs/router';
import { useAuth } from '../context/AuthContext';
import { Sidebar } from './Sidebar';
import { LoadingBlock } from './Plain';

export const Shell = (props: { children?: JSX.Element }) => {
  const auth = useAuth();

  if (!auth.ready()) {
    return (
      <main class="min-h-screen bg-background text-foreground flex items-center justify-center">
        <LoadingBlock message="Loading..." />
      </main>
    );
  }

  if (!auth.isAuthenticated()) {
    return <Navigate href="/login" />;
  }

  return (
    <div class="min-h-screen bg-background text-foreground flex">
      <Sidebar />
      <main class="flex-1 min-w-0 lg:ml-[220px]">
        <div class="mx-auto max-w-[1280px] p-6 lg:p-8">
          {props.children}
        </div>
      </main>
    </div>
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
