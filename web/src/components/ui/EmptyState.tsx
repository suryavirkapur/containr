import { Component, JSX, Show, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

interface EmptyStateProps extends JSX.HTMLAttributes<HTMLDivElement> {
    title: string;
    description: string;
    action?: JSX.Element;
    icon?: JSX.Element;
}

export const EmptyState: Component<EmptyStateProps> = (props) => {
    const [local, others] = splitProps(props, [
        "title",
        "description",
        "action",
        "icon",
        "class",
    ]);

    return (
        <div
            class={cn(
                "border border-dashed border-[var(--border-strong)] bg-[var(--card)] px-6 py-14 text-center",
                local.class,
            )}
            {...others}
        >
            <Show when={local.icon}>
                <div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted-foreground)]">
                    {local.icon}
                </div>
            </Show>
            <h3 class="font-serif text-2xl text-[var(--foreground)]">
                {local.title}
            </h3>
            <p class="mx-auto mt-3 max-w-md text-sm leading-6 text-[var(--muted-foreground)]">
                {local.description}
            </p>
            <Show when={local.action}>
                <div class="mt-6 flex justify-center">{local.action}</div>
            </Show>
        </div>
    );
};
