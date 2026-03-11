import { Component, JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

type BadgeVariant = "default" | "outline" | "secondary" | "success" | "warning" | "error";

interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
	variant?: BadgeVariant;
}

/// reusable badge component
export const Badge: Component<BadgeProps> = (props) => {
	const [local, others] = splitProps(props, ["variant", "class", "children"]);

	const variants: Record<BadgeVariant, string> = {
		default: "border-[var(--border)] bg-[var(--muted)] text-[var(--foreground)]",
		outline: "border-[var(--border-strong)] bg-transparent text-[var(--muted-foreground)]",
		secondary: "border-[var(--border)] bg-[var(--surface-muted)] text-[var(--foreground)]",
		success: "border-emerald-900 bg-emerald-950/70 text-emerald-200",
		warning: "border-amber-900 bg-amber-950/70 text-amber-200",
		error: "border-red-900 bg-red-950/70 text-red-200",
	};

	return (
		<span
			class={cn(
				"inline-flex items-center border rounded-[var(--radius)] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em]",
				"transition-colors",
				variants[local.variant || "default"],
				local.class,
			)}
			{...others}
		>
			{local.children}
		</span>
	);
};
