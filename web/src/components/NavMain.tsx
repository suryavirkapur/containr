import { For, Show, type JSX } from 'solid-js';
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
  collapsed?: boolean;
};

export const NavMain = (props: Props) => {
  const location = useLocation();
  const isCollapsed = () => props.collapsed ?? false;

  const isActive = (href: string) => {
    if (href === '/') return location.pathname === '/';
    return location.pathname.startsWith(href);
  };

  const isSubActive = (href: string) => location.pathname === href;

  return (
    <div class={`${isCollapsed() ? 'px-2' : 'px-3'} py-2`}>
      <Show when={props.label && !isCollapsed()}>
        <p class='px-3 pb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground'>
          {props.label}
        </p>
      </Show>
      <For each={props.items}>
        {(item) => (
          <Show
            when={item.items && item.items.length > 0}
            fallback={
              <A
                href={item.href ?? '#'}
                class={`flex items-center ${isCollapsed() ? 'justify-center' : 'gap-3'} rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  item.href && isActive(item.href)
                    ? 'bg-[var(--sidebar-active)] text-[var(--sidebar-active-fg)]'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
                title={isCollapsed() ? item.title : undefined}
              >
                <Show when={item.icon}>
                  <span class='flex h-4 w-4 items-center justify-center'>{item.icon}</span>
                </Show>
                <Show when={!isCollapsed()}>
                  <span>{item.title}</span>
                </Show>
              </A>
            }
          >
            <details class="group" open={item.href ? isActive(item.href!) : false}>
              <summary class={`flex items-center ${isCollapsed() ? 'justify-center' : 'gap-3'} list-none cursor-pointer rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                item.href && isActive(item.href!)
                  ? 'bg-[var(--sidebar-active)] text-[var(--sidebar-active-fg)]'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}>
                <Show when={item.icon}>
                  <span class='flex h-4 w-4 items-center justify-center'>{item.icon}</span>
                </Show>
                <Show when={!isCollapsed()}>
                  <span class="flex-1">{item.title}</span>
                  <span class='text-xs transition-transform group-open:rotate-180'>v</span>
                </Show>
              </summary>
              <Show when={!isCollapsed()}>
                <div class='ml-4 mt-1 flex flex-col gap-1'>
                  <For each={item.items}>
                    {(subItem) => (
                      <A
                        href={subItem.href}
                        class={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                          isSubActive(subItem.href)
                            ? 'bg-secondary text-foreground'
                            : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                        }`}
                      >
                        {subItem.title}
                      </A>
                    )}
                  </For>
                </div>
              </Show>
            </details>
          </Show>
        )}
      </For>
    </div>
  );
};
