import { A } from '@solidjs/router';
import { Show } from 'solid-js';
import { NavMain } from './NavMain';
import { ThemeContext } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

const navPlatform = [
  { title: 'Services', href: '/services', icon: '◫' },
  { title: 'Storage', href: '/storage', icon: '◪' },
];

const navAccess = [
  { title: 'Settings', href: '/settings', icon: '⚙' },
];

const navActions = [
  { title: 'New Service', href: '/services/new', icon: '+' },
];

type Props = {
  collapsed?: boolean;
  onToggle?: () => void;
};

export const Sidebar = (props: Props) => {
  const auth = useAuth();
  const { resolvedTheme, toggleTheme } = ThemeContext;
  const isCollapsed = () => props.collapsed ?? false;

  return (
    <aside class={`fixed left-0 top-16 z-40 hidden h-[calc(100vh-4rem)] flex-col border-r border-border bg-[var(--sidebar-bg)] transition-all duration-200 lg:flex ${
      isCollapsed() ? 'w-20' : 'w-[200px]'
    }`}>
      <div class='flex items-center justify-between border-b border-border px-4 py-4'>
        <Show
          when={!isCollapsed()}
          fallback={
            <span class='text-lg font-semibold'>C</span>
          }
        >
          <div>
            <span class='text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground'>Platform</span>
            <h1 class='text-lg font-semibold tracking-tight'>containr</h1>
          </div>
        </Show>
        <button
          type="button"
          onClick={props.onToggle}
          class='rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'
          title={isCollapsed() ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span class='text-lg'>{isCollapsed() ? '→' : '←'}</span>
        </button>
      </div>

      <nav class='flex-1 overflow-y-auto py-4'>
        <NavMain items={navPlatform} label='Platform' collapsed={isCollapsed()} />
        <NavMain items={navAccess} label='System' collapsed={isCollapsed()} />
      </nav>

      <div class='space-y-2 border-t border-border p-3'>
        <Show
          when={!isCollapsed()}
          fallback={
            <A
              href="/services/new"
              class='cr-btn cr-btn-primary w-full'
              title="New Service"
            >
              +
            </A>
          }
        >
          <A
            href="/services/new"
            class='cr-btn cr-btn-primary w-full'
          >
            + New Service
          </A>
        </Show>

        <button
          type="button"
          onClick={toggleTheme}
          class={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            isCollapsed() ? 'justify-center' : ''
          } text-muted-foreground hover:bg-secondary hover:text-foreground`}
          title={resolvedTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span>{resolvedTheme() === 'dark' ? '☀' : '☾'}</span>
          <Show when={!isCollapsed()}>
            <span>{resolvedTheme() === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </Show>
        </button>

        <Show when={!isCollapsed()}>
          <div class='border-t border-border pt-2'>
            <div class='px-3 py-2'>
              <p class='truncate text-sm font-medium'>{auth.user()?.email}</p>
              <p class='text-xs text-muted-foreground'>{auth.user()?.is_admin ? 'admin' : 'user'}</p>
            </div>
            <button
              type="button"
              onClick={auth.logout}
              class='flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'
            >
              <span>→</span>
              <span>Log Out</span>
            </button>
          </div>
        </Show>
        <Show when={isCollapsed()}>
          <button
            type="button"
            onClick={auth.logout}
            class='flex w-full items-center justify-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'
            title="Log Out"
          >
            <span>→</span>
          </button>
        </Show>
      </div>
    </aside>
  );
};
