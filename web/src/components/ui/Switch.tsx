import { Component, JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

interface SwitchProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
	checked: boolean;
	onChange: (checked: boolean) => void;
}

export const Switch: Component<SwitchProps> = (props) => {
	const [local, others] = splitProps(props, ["checked", "onChange", "class", "disabled"]);

	return (
		<button
			type="button"
			role="switch"
			aria-checked={local.checked}
			disabled={local.disabled}
			class={cn(
				"relative inline-flex h-6 w-11 items-center border transition-colors",
				"border-[var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
				local.checked ? "bg-[var(--foreground)]" : "bg-[var(--muted)]",
				local.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
				local.class,
			)}
			onClick={() => local.onChange(!local.checked)}
			{...others}
		>
			<span
				class={cn(
					"block h-4 w-4 bg-[var(--background)] transition-transform",
					local.checked ? "translate-x-6" : "translate-x-1",
				)}
			/>
		</button>
	);
};
