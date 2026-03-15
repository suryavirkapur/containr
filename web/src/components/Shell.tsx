import { A, Navigate, useLocation } from '@solidjs/router';
import { type JSX, Show } from 'solid-js';
import { useAuth } from '../context/AuthContext';
import { Panel } from './Plain';

const links = [
  { href: '/services', label: 'Services' },
  { href: '/containers', label: 'Containers' },
  { href: '/storage', label: 'Storage' },
  { href: '/settings', label: 'Settings' },
];

export const Shell = (props: { children?: JSX.Element }) => {
  const auth = useAuth();
  const location = useLocation();

  if (!auth.ready()) {
    return (
      <main class='min-h-screen bg-background text-foreground flex items-center justify-center p-4'>
        <Panel><p class="text-muted-foreground">Loading control panel...</p></Panel>
      </main>
    );
  }

  if (!auth.isAuthenticated()) {
    return <Navigate href='/login' />;
  }

  return (
    <div class="min-h-screen flex flex-col max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
      <header class="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4 mb-8 border-b border-border pb-6">
        <div class="max-w-xl">
          <div class="text-xs font-bold tracking-widest uppercase text-primary/70 mb-2">containr control panel</div>
          <h1 class="text-3xl font-bold tracking-tight mb-1">containr</h1>
          <p class="text-muted-foreground">Services define the platform. Groups only define the network boundary.</p>
        </div>
        <div class="flex flex-col sm:text-right gap-1 text-sm bg-card border shadow-sm p-4 rounded-xl">
          <div><span class="font-medium">{auth.user()?.email}</span></div>
          <div class="text-muted-foreground mb-2">{auth.user()?.is_admin ? 'bootstrap admin' : 'standard user'}</div>
          <button 
            type='button' 
            onClick={auth.logout}
            class="text-xs font-semibold bg-secondary text-secondary-foreground hover:bg-secondary/80 py-1.5 px-3 rounded-md transition-colors"
          >
            Log Out
          </button>
        </div>
      </header>

      <nav class="flex items-center gap-2 overflow-x-auto pb-4 mb-8 scrollbar-hide text-sm font-medium">
        {links.map((link) => (
          <A 
            href={link.href} 
            class={`px-4 py-2 rounded-full transition-colors whitespace-nowrap ${
              location.pathname.startsWith(link.href) 
                ? 'bg-primary text-primary-foreground pointer-events-none' 
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
          >
            {link.label}
          </A>
        ))}
        <span class="flex-1" />
        <A 
          href='/services/new' 
          class="px-4 py-2 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 shadow transition-colors whitespace-nowrap"
        >
          New Service
        </A>
      </nav>

      <main class="flex-1">
        {props.children}
      </main>
    </div>
  );
};

export const PublicShell = (props: { title: string; subtitle?: string; children?: JSX.Element }) => (
  <main class='min-h-screen bg-background text-foreground flex flex-col max-w-3xl mx-auto p-4 sm:p-6 my-12'>
    <header class='mb-8 text-center'>
      <div class='text-sm font-semibold tracking-wider text-muted-foreground uppercase mb-2'>containr access</div>
      <h1 class="text-4xl font-bold tracking-tight mb-2">{props.title}</h1>
      <Show when={props.subtitle}><p class='text-lg text-muted-foreground'>{props.subtitle}</p></Show>
    </header>
    <div class="bg-card text-card-foreground border shadow-sm rounded-xl p-6 sm:p-8">
      {props.children}
    </div>
  </main>
);
