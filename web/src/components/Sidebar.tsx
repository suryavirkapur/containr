import { Show } from 'solid-js';
import { A, useLocation } from '@solidjs/router';
import { ThemeContext } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

const navItems = [
  { title: 'Services', href: '/services' },
  { title: 'Containers', href: '/containers' },
  { title: 'Storage', href: '/storage' },
  { title: 'Settings', href: '/settings' },
];

export const Sidebar = () => {
  const auth = useAuth();
  const { resolvedTheme, toggleTheme } = ThemeContext;
  const location = useLocation();

  const isActive = (href: string) =>
    location.pathname === href ||
    (href !== '/' && location.pathname.startsWith(href));

  return (
    <aside class="fixed left-0 top-0 h-screen w-52 flex flex-col border-r border-border bg-card z-50">
      {/* Logo */}
      <div class="h-14 flex items-center px-5 border-b border-border">
        <A href="/services" class="text-sm font-semibold tracking-tight">
          containr
        </A>
      </div>

      {/* Nav */}
      <nav class="flex-1 overflow-y-auto py-3">
        {navItems.map((item) => (
          <A
            href={item.href}
            class={`flex items-center px-5 py-2 text-sm transition-colors ${
              isActive(item.href)
                ? 'text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {item.title}
          </A>
        ))}
      </nav>

      {/* Bottom */}
      <div class="border-t border-border px-5 py-4 flex flex-col gap-3">
        <A
          href="/services/new"
          class="flex items-center justify-center w-full px-3 py-1.5 text-xs font-medium border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
        >
          + New Service
        </A>
        <div class="flex items-center justify-between">
          <Show when={auth.user()}>
            <p class="text-xs text-muted-foreground truncate flex-1">
              {auth.user()?.email}
            </p>
          </Show>
          <div class="flex items-center gap-2 ml-2 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              class="text-xs text-muted-foreground hover:text-foreground transition-colors"
              title={
                resolvedTheme() === 'dark'
                  ? 'Switch to light'
                  : 'Switch to dark'
              }
            >
              {resolvedTheme() === 'dark' ? '☀' : '☾'}
            </button>
            <button
              type="button"
              onClick={auth.logout}
              class="text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="Log out"
            >
              →
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};
