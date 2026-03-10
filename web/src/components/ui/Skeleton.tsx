import { Component, JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

interface SkeletonProps extends JSX.HTMLAttributes<HTMLDivElement> {}

export const Skeleton: Component<SkeletonProps> = (props) => {
    const [local, others] = splitProps(props, ["class"]);

    return (
        <div
            class={cn(
                "animate-pulse bg-[linear-gradient(90deg,var(--muted),var(--surface-muted),var(--muted))]",
                local.class,
            )}
            {...others}
        />
    );
};
