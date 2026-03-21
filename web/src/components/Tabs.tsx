import { type JSX, For } from 'solid-js';

export type TabDef = {
  id: string;
  label: string;
  badge?: string | number;
};

type Props = {
  tabs: TabDef[];
  activeTab: string;
  onTabChange: (id: string) => void;
  children?: JSX.Element;
};

export const Tabs = (props: Props) => (
  <div>
    <div class="cr-tabs mb-0">
      <For each={props.tabs}>
        {(tab) => (
          <button
            type="button"
            class={`cr-tab ${props.activeTab === tab.id ? 'active' : ''}`}
            onClick={() => props.onTabChange(tab.id)}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span class="ml-1.5 text-xs text-muted-foreground">
                {tab.badge}
              </span>
            )}
          </button>
        )}
      </For>
    </div>
    <div class="mt-6">{props.children}</div>
  </div>
);
