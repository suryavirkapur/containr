import { Component, JSX, splitProps } from "solid-js";

import { cn } from "../../lib/cn";

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg" | "icon";

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	isLoading?: boolean;
}

/// reusable button component
export const Button: Component<ButtonProps> = (props) => {
	const [local, others] = splitProps(props, [
		"variant",
		"size",
		"isLoading",
		"children",
		"class",
		"disabled",
	]);

	const baseClass = cn(
		"inline-flex items-center justify-center gap-2 border rounded-[var(--radius)] text-sm font-medium",
		"transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
		"disabled:cursor-not-allowed disabled:opacity-50",
	);

	const variants: Record<ButtonVariant, string> = {
		primary:
			"border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)] hover:bg-white/85",
		secondary:
			"border-[var(--border)] bg-[var(--muted)] text-[var(--foreground)] hover:bg-[var(--surface-muted)]",
		outline:
			"border-[var(--border-strong)] bg-transparent text-[var(--foreground)] hover:border-[var(--foreground)]",
		ghost:
			"border-transparent bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
		danger: "border-red-900 bg-red-950/80 text-red-100 hover:bg-red-900",
	};

	const sizes: Record<ButtonSize, string> = {
		sm: "h-8 px-3 text-xs",
		md: "h-10 px-4 text-sm",
		lg: "h-12 px-6 text-base",
		icon: "h-10 w-10 px-0",
	};

	return (
		<button
			class={cn(
				baseClass,
				variants[local.variant || "primary"],
				sizes[local.size || "md"],
				local.class,
			)}
			disabled={local.disabled || local.isLoading}
			{...others}
		>
			{local.isLoading ? (
				<>
					<svg
						class="h-4 w-4 animate-spin text-current"
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
					>
						<circle
							class="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							stroke-width="4"
						></circle>
						<path
							class="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
						></path>
					</svg>
					loading
				</>
			) : (
				local.children
			)}
		</button>
	);
};
