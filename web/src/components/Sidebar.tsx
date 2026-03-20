import { createSignal, For, Show, type JSX } from 'solid-js';
import { A, useLocation } from '@solidjs/router';
import { NavMain } from './NavMain';
import { ThemeContext } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

const navPlatform = [
  { title: 'Services', href: '/services', icon: '◇' },
  { title: 'Containers', href: '/containers', icon: '□' },
  { title: 'Storage', href: '/storage', icon: '▣' },
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
    <aside class={`fixed left-0 top-0 h-screen flex flex-col border-r border-border bg-card transition-all duration-200 z-50 ${
      isCollapsed() ? 'w-16' : 'w-64'
    }`}>
      <div class="flex items-center justify-between h-16 px-4 border-b border-border">
        <Show
          when={!isCollapsed()}
          fallback={
            <span class="text-lg font-bold">C</span>
          }
        >
          <div>
            <span class="text-xs font-bold tracking-widest uppercase text-muted-foreground">containr</span>
            <h1 class="text-xl font-bold tracking-tight">containr</h1>
          </div>
        </Show>
        <button
          type="button"
          onClick={props.onToggle}
          class="p-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          title={isCollapsed() ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span class="text-lg">{isCollapsed() ? '→' : '←'}</span>
        </button>
      </div>

      <nav class="flex-1 overflow-y-auto py-4">
        <NavMain items={navPlatform} label="Platform" />
        <NavMain items={navAccess} label="Access" />
      </nav>

      <div class="border-t border-border p-3 space-y-2">
        <Show when={!isCollapsed()}>
          <A
            href="/services/new"
            class="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-medium text-sm transition-colors"
          >
            <span>+</span>
            <span>New Service</span>
          </A>
        </Show>

        <button
          type="button"
          onClick={toggleTheme}
          class={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full ${
            isCollapsed() ? 'justify-center' : ''
          } text-muted-foreground hover:text-foreground hover:bg-secondary/50`}
          title={resolvedTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span>{resolvedTheme() === 'dark' ? '☀' : '☾'}</span>
          <Show when={!isCollapsed()}>
            <span>{resolvedTheme() === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </Show>
        </button>

        <Show when={!isCollapsed()}>
          <div class="pt-2 border-t border-border">
            <div class="px-3 py-2">
              <p class="text-sm font-medium truncate">{auth.user()?.email}</p>
              <p class="text-xs text-muted-foreground">{auth.user()?.is_admin ? 'admin' : 'user'}</p>
            </div>
            <button
              type="button"
              onClick={auth.logout}
              class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            >
              <span>→</span>
              <span>Log Out</span>
            </button>
          </div>
        </Show>
      </div>
    </aside>
  );
};
