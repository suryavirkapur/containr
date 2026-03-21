import { A, useLocation } from '@solidjs/router';
import { For, Show } from 'solid-js';
import { useAuth } from '../context/AuthContext';

type NavItem = {
  title: string;
  href: string;
};

const navItems: NavItem[] = [
  { title: 'Services', href: '/services' },
  { title: 'Storage', href: '/storage' },
  { title: 'Settings', href: '/settings' },
];

export const Sidebar = () => {
  const auth = useAuth();
  const location = useLocation();

  const isActive = (href: string) => {
    if (href === '/services') {
      return location.pathname === '/services' ||
        location.pathname.startsWith('/services/');
    }
    return location.pathname.startsWith(href);
  };

  return (
    <aside class="fixed left-0 top-0 z-40 hidden h-screen w-[220px] flex-col border-r border-border bg-[var(--sidebar-bg)] lg:flex">
      {/* Brand */}
      <div class="flex items-center gap-2 px-4 py-5 border-b border-border">
        <div>
          <div class="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            containr
          </div>
          <div class="text-sm font-semibold tracking-tight">
            Control Panel
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav class="flex-1 overflow-y-auto py-3">
        <div class="px-2">
          <For each={navItems}>
            {(item) => (
              <A
                href={item.href}
                class={`cr-nav-item ${isActive(item.href) ? 'active' : ''}`}
              >
                {item.title}
              </A>
            )}
          </For>
        </div>
      </nav>

      {/* Footer */}
      <div class="border-t border-border p-3 flex flex-col gap-2">
        <A href="/services/new" class="cr-btn cr-btn-primary w-full text-center">
          + New Service
        </A>
        <Show when={auth.user()}>
          <div class="px-2 pt-1">
            <p class="text-xs text-muted-foreground truncate">
              {auth.user()?.email}
            </p>
          </div>
        </Show>
        <button
          type="button"
          onClick={auth.logout}
          class="cr-nav-item w-full text-left"
        >
          Log out
        </button>
      </div>
    </aside>
  );
};
