import { Component, JSX, Show, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

interface PageHeaderProps extends JSX.HTMLAttributes<HTMLDivElement> {
    title: string;
    description?: string;
    eyebrow?: string;
    actions?: JSX.Element;
}

export const PageHeader: Component<PageHeaderProps> = (props) => {
    const [local, others] = splitProps(props, [
        "title",
        "description",
        "eyebrow",
        "actions",
        "class",
    ]);

    return (
        <div
            class={cn(
                "flex flex-col gap-6 border-b border-[var(--border)] pb-6 md:flex-row md:items-end md:justify-between",
                local.class,
            )}
            {...others}
        >
            <div class="space-y-3">
                <Show when={local.eyebrow}>
                    <p class="text-[11px] font-semibold uppercase tracking-[0.3em] text-[var(--muted-foreground)]">
                        {local.eyebrow}
                    </p>
                </Show>
                <div class="space-y-2">
                    <h1 class="font-serif text-3xl text-[var(--foreground)]">
                        {local.title}
                    </h1>
                    <Show when={local.description}>
                        <p class="max-w-2xl text-sm leading-6 text-[var(--muted-foreground)]">
                            {local.description}
                        </p>
                    </Show>
                </div>
            </div>
            <Show when={local.actions}>
                <div class="flex flex-wrap items-center gap-3">{local.actions}</div>
            </Show>
        </div>
    );
};
