import { Component, JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

interface CardProps extends JSX.HTMLAttributes<HTMLDivElement> {
	variant?: "default" | "hover" | "muted";
}

/// reusable card component
export const Card: Component<CardProps> = (props) => {
	const [local, others] = splitProps(props, ["variant", "class", "children"]);

	const variants = {
		default:
			"border border-[var(--border)] rounded-[var(--radius)] bg-[var(--card)] shadow-[0_0_0_1px_rgba(255,255,255,0.02)]",
		hover:
			"border border-[var(--border)] rounded-[var(--radius)] bg-[var(--card)] transition-colors hover:border-[var(--border-strong)] cursor-pointer group",
		muted:
			"border border-[var(--border)] rounded-[var(--radius)] bg-[var(--surface-muted)]",
	};

	return (
		<div
			class={cn(variants[local.variant || "default"], local.class)}
			{...others}
		>
			{local.children}
		</div>
	);
};

export const CardHeader: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div
			class={cn("border-b border-[var(--border)] px-6 py-5", local.class)}
			{...others}
		>
			{local.children}
		</div>
	);
};

export const CardTitle: Component<JSX.HTMLAttributes<HTMLHeadingElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<h3
			class={cn(
				"font-serif text-lg font-medium text-[var(--foreground)]",
				local.class,
			)}
			{...others}
		>
			{local.children}
		</h3>
	);
};

export const CardDescription: Component<
	JSX.HTMLAttributes<HTMLParagraphElement>
> = (props) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<p
			class={cn("mt-1 text-sm text-[var(--muted-foreground)]", local.class)}
			{...others}
		>
			{local.children}
		</p>
	);
};

export const CardContent: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div class={cn("px-6 py-5", local.class)} {...others}>
			{local.children}
		</div>
	);
};

export const CardFooter: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div
			class={cn(
				"flex items-center border-t border-[var(--border)] px-6 py-5",
				local.class,
			)}
			{...others}
		>
			{local.children}
		</div>
	);
};
