import { createSignal, For, Show, type JSX } from 'solid-js';
import { A, useLocation } from '@solidjs/router';

type NavItem = {
  title: string;
  href?: string;
  icon?: JSX.Element;
  items?: { title: string; href: string }[];
};

type Props = {
  items: NavItem[];
  label?: string;
};

export const NavMain = (props: Props) => {
  const location = useLocation();

  const isActive = (href: string) => {
    if (href === '/') return location.pathname === '/';
    return location.pathname.startsWith(href);
  };

  const isSubActive = (href: string) => location.pathname === href;

  return (
    <div class="px-3 py-2">
      <Show when={props.label}>
        <p class="px-3 mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{props.label}</p>
      </Show>
      <For each={props.items}>
        {(item) => (
          <Show
            when={item.items && item.items.length > 0}
            fallback={
              <A
                href={item.href ?? '#'}
                class={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  item.href && isActive(item.href)
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                }`}
              >
                <Show when={item.icon}>
                  <span class="h-4 w-4">{item.icon}</span>
                </Show>
                <span>{item.title}</span>
              </A>
            }
          >
            <details class="group" open={item.href ? isActive(item.href!) : false}>
              <summary class={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors list-none ${
                item.href && isActive(item.href!)
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
              }`}>
                <Show when={item.icon}>
                  <span class="h-4 w-4">{item.icon}</span>
                </Show>
                <span class="flex-1">{item.title}</span>
                <span class="text-xs transition-transform group-open:rotate-180">v</span>
              </summary>
              <div class="ml-4 mt-1 flex flex-col gap-1">
                <For each={item.items}>
                  {(subItem) => (
                    <A
                      href={subItem.href}
                      class={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                        isSubActive(subItem.href)
                          ? 'bg-secondary text-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                      }`}
                    >
                      {subItem.title}
                    </A>
                  )}
                </For>
              </div>
            </details>
          </Show>
        )}
      </For>
    </div>
  );
};
