import { For } from 'solid-js';
import { A, useLocation } from '@solidjs/router';
import { type JSX, Show } from 'solid-js';

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

type Props = {
  items: BreadcrumbItem[];
};

export const Breadcrumbs = (props: Props) => {
  return (
    <nav aria-label="Breadcrumb" class="flex items-center gap-2 text-sm mb-6">
      <ol class="flex items-center gap-2">
        <For each={props.items}>
          {(item, index) => (
            <>
              <Show when={index() > 0}>
                <span class="text-muted-foreground/50 mx-1">/</span>
              </Show>
              <li>
                <Show
                  when={item.href && index() < props.items.length - 1}
                  fallback={
                    <span class={index() === props.items.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                      {item.label}
                    </span>
                  }
                >
                  <A href={item.href!} class="text-muted-foreground hover:text-foreground transition-colors">
                    {item.label}
                  </A>
                </Show>
              </li>
            </>
          )}
        </For>
      </ol>
    </nav>
  );
};
