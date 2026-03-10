import { A } from "@solidjs/router";
import { Component, JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

export const Sidebar: Component<JSX.HTMLAttributes<HTMLElement>> = (props) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<aside
			class={cn(
				"flex h-full w-[19rem] shrink-0 flex-col border-r",
				"border-[var(--border)] bg-[rgba(10,12,18,0.92)]",
				"text-[var(--foreground)] backdrop-blur",
				local.class,
			)}
			{...others}
		>
			{local.children}
		</aside>
	);
};

export const SidebarInset: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div
			class={cn("flex min-h-screen min-w-0 flex-1 flex-col", local.class)}
			{...others}
		>
			{local.children}
		</div>
	);
};

export const SidebarHeader: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div
			class={cn("border-b border-[var(--border)] p-5", local.class)}
			{...others}
		>
			{local.children}
		</div>
	);
};

export const SidebarContent: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div class={cn("flex-1 overflow-y-auto p-5", local.class)} {...others}>
			{local.children}
		</div>
	);
};

export const SidebarFooter: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div
			class={cn("border-t border-[var(--border)] p-5", local.class)}
			{...others}
		>
			{local.children}
		</div>
	);
};

export const SidebarGroup: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div class={cn("mb-8 last:mb-0", local.class)} {...others}>
			{local.children}
		</div>
	);
};

export const SidebarGroupLabel: Component<
	JSX.HTMLAttributes<HTMLParagraphElement>
> = (props) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<p
			class={cn(
				"mb-3 text-[11px] font-semibold uppercase",
				"tracking-[0.26em] text-[var(--muted-foreground)]",
				local.class,
			)}
			{...others}
		>
			{local.children}
		</p>
	);
};

export const SidebarMenu: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div class={cn("space-y-2", local.class)} {...others}>
			{local.children}
		</div>
	);
};

export const SidebarMenuItem: Component<JSX.HTMLAttributes<HTMLDivElement>> = (
	props,
) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div class={cn("block", local.class)} {...others}>
			{local.children}
		</div>
	);
};

interface SidebarMenuLinkProps
	extends JSX.AnchorHTMLAttributes<HTMLAnchorElement> {
	active?: boolean;
}

export const SidebarMenuLink: Component<SidebarMenuLinkProps> = (props) => {
	const [local, others] = splitProps(props, [
		"active",
		"class",
		"children",
		"href",
	]);

	return (
		<A
			href={local.href || "/"}
			class={cn(
				"flex items-center gap-3 border rounded-[var(--radius)] px-3 py-3",
				"text-sm transition-colors",
				local.active
					? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--foreground)]"
					: "border-[var(--border)] text-[var(--muted-foreground)]",
				!local.active &&
					"hover:border-[var(--border-strong)] hover:text-[var(--foreground)]",
				local.class,
			)}
			{...others}
		>
			{local.children}
		</A>
	);
};
