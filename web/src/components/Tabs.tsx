import { type JSX, Show } from 'solid-js';

export type TabDef = {
  id: string;
  label: string;
  badge?: number | string;
};

type Props = {
  tabs: TabDef[];
  activeTab: string;
  onTabChange: (id: string) => void;
  children?: JSX.Element;
};

export const Tabs = (props: Props) => {
  return (
    <div class="flex flex-col">
      <div class="border-b border-border">
        <div class="flex gap-1 -mb-px overflow-x-auto" role="tablist">
          {props.tabs.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={props.activeTab === tab.id}
              onClick={() => props.onTabChange(tab.id)}
              class={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                props.activeTab === tab.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              {tab.label}
              <Show when={tab.badge !== undefined}>
                <span class={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 text-xs font-semibold rounded-full ${
                  props.activeTab === tab.id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground'
                }`}>
                  {tab.badge}
                </span>
              </Show>
            </button>
          ))}
        </div>
      </div>
      <Show when={props.children}>
        <div class="pt-6">
          {props.children}
        </div>
      </Show>
    </div>
  );
};
