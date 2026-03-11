import { type Component, type JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";
import { Label } from "./Label";

interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
	label?: string;
	error?: string;
	description?: string;
}

/// reusable input component
export const Input: Component<InputProps> = (props) => {
	const [local, others] = splitProps(props, ["label", "error", "description", "class", "id"]);

	const inputId = local.id || `input-${Math.random().toString(36).substring(2, 9)}`;

	return (
		<div class="w-full space-y-2">
			{local.label ? <Label for={inputId}>{local.label}</Label> : null}
			{local.description ? (
				<p class="text-xs text-[var(--muted-foreground)]">{local.description}</p>
			) : null}
			<input
				id={inputId}
				class={cn(
					"flex h-11 w-full border rounded-[var(--radius)] px-3 py-2 text-sm font-medium",
					"bg-[var(--input)] text-[var(--foreground)]",
					"border-[var(--border)] placeholder:text-[var(--muted-foreground)]/70",
					"focus:border-[var(--ring)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]",
					"disabled:cursor-not-allowed disabled:opacity-50",
					local.error ? "border-red-500 focus:border-red-500 focus:ring-red-500" : "",
					local.class,
				)}
				{...others}
			/>
			{local.error ? <p class="text-xs text-red-300">{local.error}</p> : null}
		</div>
	);
};
