import { Component, JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

type AlertVariant = "default" | "destructive" | "success";

interface AlertProps extends JSX.HTMLAttributes<HTMLDivElement> {
    variant?: AlertVariant;
    title?: string;
}

export const Alert: Component<AlertProps> = (props) => {
    const [local, others] = splitProps(props, [
        "variant",
        "title",
        "class",
        "children",
    ]);

    const variantClass: Record<AlertVariant, string> = {
        default:
            "border-[var(--border)] bg-[var(--muted)] text-[var(--foreground)]",
        destructive:
            "border-red-900 bg-red-950/60 text-red-100",
        success:
            "border-emerald-900 bg-emerald-950/60 text-emerald-100",
    };

    return (
        <div
            class={cn(
                "border px-4 py-3",
                variantClass[local.variant || "default"],
                local.class,
            )}
            {...others}
        >
            {local.title ? (
                <div class="mb-1 text-xs font-semibold uppercase tracking-[0.2em]">
                    {local.title}
                </div>
            ) : null}
            <div class="text-sm">{local.children}</div>
        </div>
    );
};
