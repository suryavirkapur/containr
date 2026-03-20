import { createSignal, type JSX } from 'solid-js';
import { Navigate, useLocation } from '@solidjs/router';
import { useAuth } from '../context/AuthContext';
import { Sidebar } from './Sidebar';
import { LoadingBlock } from './Plain';

export const Shell = (props: { children?: JSX.Element }) => {
  const auth = useAuth();
  const location = useLocation();
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);

  if (!auth.ready()) {
    return (
      <main class='min-h-screen bg-background text-foreground flex items-center justify-center p-4'>
        <LoadingBlock message='Loading control panel...' />
      </main>
    );
  }

  if (!auth.isAuthenticated()) {
    return <Navigate href='/login' />;
  }

  return (
    <div class='min-h-screen bg-background text-foreground'>
      <Sidebar
        collapsed={sidebarCollapsed()}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed())}
      />
      <main class={`transition-all duration-200 ${sidebarCollapsed() ? 'ml-16' : 'ml-64'}`}>
        <div class="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
          {props.children}
        </div>
      </main>
    </div>
  );
};

export const PublicShell = (props: { title: string; subtitle?: string; children?: JSX.Element }) => (
  <main class='min-h-screen bg-background text-foreground flex flex-col max-w-3xl mx-auto p-4 sm:p-6 my-12'>
    <header class='mb-8 text-center'>
      <div class='text-sm font-semibold tracking-wider text-muted-foreground uppercase mb-2'>containr access</div>
      <h1 class="text-4xl font-bold tracking-tight mb-2">{props.title}</h1>
      {props.subtitle && <p class='text-lg text-muted-foreground'>{props.subtitle}</p>}
    </header>
    <div class="bg-card text-card-foreground border shadow-sm rounded-xl p-6 sm:p-8">
      {props.children}
    </div>
  </main>
);
