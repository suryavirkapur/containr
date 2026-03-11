import { createSignal, type JSX, onCleanup, type ParentComponent, Show } from "solid-js";

interface DropdownMenuProps {
	trigger: JSX.Element;
	children: JSX.Element;
	align?: "start" | "end";
}

export const DropdownMenu: ParentComponent<DropdownMenuProps> = (props) => {
	const [isOpen, setIsOpen] = createSignal(false);
	let menuRef: HTMLDivElement | undefined;

	const toggle = () => setIsOpen(!isOpen());
	const close = () => setIsOpen(false);

	const handleClickOutside = (e: MouseEvent) => {
		if (menuRef && !menuRef.contains(e.target as Node)) {
			close();
		}
	};

	const handleEscape = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			close();
		}
	};

	if (typeof window !== "undefined") {
		window.addEventListener("click", handleClickOutside);
		window.addEventListener("keydown", handleEscape);
		onCleanup(() => {
			window.removeEventListener("click", handleClickOutside);
			window.removeEventListener("keydown", handleEscape);
		});
	}

	return (
		<div class="relative inline-block text-left" ref={menuRef}>
			<div onClick={toggle} class="cursor-pointer">
				{props.trigger}
			</div>

			<Show when={isOpen()}>
				<div
					class={`absolute z-50 mt-2 w-56 origin-top-right rounded-md border border-[var(--border)] bg-[var(--card)] shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none ${
						props.align === "start" ? "left-0" : "right-0"
					}`}
					role="menu"
					aria-orientation="vertical"
					onClick={close} // Close on any item click
				>
					<div class="py-1" role="none">
						{props.children}
					</div>
				</div>
			</Show>
		</div>
	);
};

export const DropdownMenuItem: ParentComponent<{
	onClick?: () => void;
	class?: string;
}> = (props) => {
	return (
		<button
			type="button"
			onClick={props.onClick}
			class={`block w-full px-4 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] ${
				props.class || ""
			}`}
			role="menuitem"
		>
			{props.children}
		</button>
	);
};

export const DropdownMenuLabel: ParentComponent<{ class?: string }> = (props) => {
	return (
		<div
			class={`px-4 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted-foreground)] ${
				props.class || ""
			}`}
		>
			{props.children}
		</div>
	);
};

export const DropdownMenuSeparator: ParentComponent = () => {
	return <div class="my-1 h-px bg-[var(--border)]" />;
};
