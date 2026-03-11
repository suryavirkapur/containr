import { type Component, createContext, type JSX, Show, splitProps, useContext } from "solid-js";

import { cn } from "../../lib/cn";

interface TabsContextValue {
	value: () => string;
	setValue: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue>();

interface TabsProps extends JSX.HTMLAttributes<HTMLDivElement> {
	value: string;
	onValueChange: (value: string) => void;
}

export const Tabs: Component<TabsProps> = (props) => {
	const [local, others] = splitProps(props, ["value", "onValueChange", "class", "children"]);

	return (
		<TabsContext.Provider
			value={{
				value: () => local.value,
				setValue: local.onValueChange,
			}}
		>
			<div class={cn("space-y-4", local.class)} {...others}>
				{local.children}
			</div>
		</TabsContext.Provider>
	);
};

export const TabsList: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<div
			class={cn(
				"inline-flex flex-wrap items-center gap-1 border rounded-[var(--radius)] p-1",
				"border-[var(--border)] bg-[var(--muted)]",
				local.class,
			)}
			{...others}
		>
			{local.children}
		</div>
	);
};

interface TabsTriggerProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
	value: string;
}

export const TabsTrigger: Component<TabsTriggerProps> = (props) => {
	const context = useContext(TabsContext);
	if (!context) {
		throw new Error("tabs trigger must be used inside tabs");
	}

	const [local, others] = splitProps(props, ["value", "class", "children"]);

	const selected = () => context.value() === local.value;

	return (
		<button
			type="button"
			class={cn(
				"inline-flex items-center gap-2 border rounded-[var(--radius)] px-3 py-2 text-xs font-medium uppercase tracking-[0.18em]",
				"transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
				selected()
					? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
					: "border-transparent text-[var(--muted-foreground)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]",
				local.class,
			)}
			onClick={() => context.setValue(local.value)}
			{...others}
		>
			{local.children}
		</button>
	);
};

interface TabsContentProps extends JSX.HTMLAttributes<HTMLDivElement> {
	value: string;
}

export const TabsContent: Component<TabsContentProps> = (props) => {
	const context = useContext(TabsContext);
	if (!context) {
		throw new Error("tabs content must be used inside tabs");
	}

	const [local, others] = splitProps(props, ["value", "class", "children"]);

	return (
		<Show when={context.value() === local.value}>
			<div class={cn("space-y-4", local.class)} {...others}>
				{local.children}
			</div>
		</Show>
	);
};
