import { Component, JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

interface SeparatorProps extends JSX.HTMLAttributes<HTMLDivElement> {
	orientation?: "horizontal" | "vertical";
}

export const Separator: Component<SeparatorProps> = (props) => {
	const [local, others] = splitProps(props, ["orientation", "class"]);

	return (
		<div
			class={cn(
				"shrink-0 bg-[var(--border)]",
				local.orientation === "vertical" ? "h-full w-px" : "h-px w-full",
				local.class,
			)}
			{...others}
		/>
	);
};
