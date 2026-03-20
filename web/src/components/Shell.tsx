import { type JSX } from 'solid-js';
import { Navigate, useLocation } from '@solidjs/router';
import { useAuth } from '../context/AuthContext';
import { Sidebar } from './Sidebar';
import { LoadingBlock } from './Plain';

export const Shell = (props: { children?: JSX.Element }) => {
  const auth = useAuth();
  const location = useLocation();

  if (!auth.ready()) {
    return (
      <main class="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
        <LoadingBlock message="Loading..." />
      </main>
    );
  }

  if (!auth.isAuthenticated()) {
    return <Navigate href="/login" />;
  }

  return (
    <div class="min-h-screen bg-background text-foreground">
      <Sidebar />
      <main class="ml-52">
        <div class="max-w-6xl mx-auto px-6 py-8">{props.children}</div>
      </main>
    </div>
  );
};

export const PublicShell = (props: {
  title: string;
  subtitle?: string;
  children?: JSX.Element;
}) => (
  <main class="min-h-screen bg-background text-foreground flex flex-col max-w-sm mx-auto p-6 justify-center">
    <header class="mb-8">
      <p class="text-xs text-muted-foreground uppercase tracking-widest mb-4">
        containr
      </p>
      <h1 class="text-2xl font-semibold tracking-tight mb-1">{props.title}</h1>
      {props.subtitle && (
        <p class="text-sm text-muted-foreground">{props.subtitle}</p>
      )}
    </header>
    <div class="border border-border bg-card p-6">{props.children}</div>
  </main>
);
