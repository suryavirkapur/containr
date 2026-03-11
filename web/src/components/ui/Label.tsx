import { type Component, type JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

interface LabelProps extends JSX.LabelHTMLAttributes<HTMLLabelElement> {}

export const Label: Component<LabelProps> = (props) => {
	const [local, others] = splitProps(props, ["class", "children"]);

	return (
		<label
			class={cn(
				"text-[11px] font-medium uppercase tracking-[0.22em]",
				"text-[var(--muted-foreground)]",
				local.class,
			)}
			{...others}
		>
			{local.children}
		</label>
	);
};
