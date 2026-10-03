import CircleAlert from "lucide-solid/icons/circle-alert";
import CircleCheck from "lucide-solid/icons/circle-check";
import Info from "lucide-solid/icons/info";
import X from "lucide-solid/icons/x";
import {
	type Component,
	createEffect,
	createSignal,
	For,
	type JSX,
	onCleanup,
	type ParentComponent,
	Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Portal } from "solid-js/web";
import { errorMessage } from "../../api/http";
import { Button, cx, Input } from "./index";

// ---- modal ----------------------------------------------------------------

export const Modal: ParentComponent<{
	open: boolean;
	onClose: () => void;
	title?: JSX.Element;
	description?: JSX.Element;
	footer?: JSX.Element;
	size?: "sm" | "md" | "lg" | "xl";
	class?: string;
}> = (props) => {
	createEffect(() => {
		if (!props.open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose();
		};
		window.addEventListener("keydown", onKey);
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		onCleanup(() => {
			window.removeEventListener("keydown", onKey);
			document.body.style.overflow = previous;
		});
	});

	const width = () =>
		({ sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" })[props.size ?? "md"];

	return (
		<Show when={props.open}>
			<Portal>
				<div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:pt-[12vh]">
					<div
						role="presentation"
						class="animate-fade-in fixed inset-0 bg-black/50 backdrop-blur-[2px]"
						onClick={() => props.onClose()}
					/>
					<div
						role="dialog"
						aria-modal="true"
						class={cx(
							"animate-pop-in relative w-full rounded-xl border border-border bg-surface shadow-lg",
							width(),
							props.class,
						)}
					>
						<Show when={props.title}>
							<div class="flex items-start justify-between gap-4 px-5 pt-5">
								<div>
									<h2 class="text-[15px] font-semibold tracking-[-0.01em]">{props.title}</h2>
									<Show when={props.description}>
										<p class="mt-1 text-[13px] text-fg-subtle">{props.description}</p>
									</Show>
								</div>
								<button
									type="button"
									onClick={() => props.onClose()}
									class="-mt-1 -mr-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-hover hover:text-fg"
									aria-label="Close"
								>
									<X width={16} height={16} />
								</button>
							</div>
						</Show>
						<div class="px-5 py-4">{props.children}</div>
						<Show when={props.footer}>
							<div class="flex items-center justify-end gap-2 rounded-b-xl border-t border-border bg-surface-2 px-5 py-3">
								{props.footer}
							</div>
						</Show>
					</div>
				</div>
			</Portal>
		</Show>
	);
};

// ---- confirm --------------------------------------------------------------

type ConfirmOptions = {
	title: string;
	description?: JSX.Element;
	confirmLabel?: string;
	danger?: boolean;
	/** require typing this text before confirming */
	typeToConfirm?: string;
};

type ConfirmState = ConfirmOptions & { open: boolean; resolve?: (value: boolean) => void };

const [confirmState, setConfirmState] = createStore<ConfirmState>({ open: false, title: "" });

/** opens a confirmation dialog and resolves with the user's choice */
export const confirm = (options: ConfirmOptions): Promise<boolean> =>
	new Promise((resolve) => {
		confirmState.resolve?.(false);
		setConfirmState({
			open: true,
			description: undefined,
			confirmLabel: undefined,
			danger: undefined,
			typeToConfirm: undefined,
			...options,
			resolve,
		});
	});

export const ConfirmHost: Component = () => {
	const [typed, setTyped] = createSignal("");
	const close = (value: boolean) => {
		confirmState.resolve?.(value);
		setConfirmState({ open: false, resolve: undefined });
		setTyped("");
	};
	const blocked = () =>
		Boolean(confirmState.typeToConfirm) && typed() !== confirmState.typeToConfirm;
	return (
		<Modal
			open={confirmState.open}
			onClose={() => close(false)}
			title={confirmState.title}
			size="sm"
			footer={
				<>
					<Button variant="secondary" onClick={() => close(false)}>
						Cancel
					</Button>
					<Button
						variant={confirmState.danger ? "danger" : "primary"}
						disabled={blocked()}
						onClick={() => close(true)}
					>
						{confirmState.confirmLabel ?? "Confirm"}
					</Button>
				</>
			}
		>
			<div class="space-y-3 text-[13px] text-fg-muted">
				<Show when={confirmState.description}>
					<div>{confirmState.description}</div>
				</Show>
				<Show when={confirmState.typeToConfirm}>
					<div>
						<p class="mb-2">
							Type{" "}
							<code class="rounded bg-surface-2 px-1 py-0.5 text-fg">
								{confirmState.typeToConfirm}
							</code>{" "}
							to confirm.
						</p>
						<Input
							value={typed()}
							onInput={(event) => setTyped(event.currentTarget.value)}
							autocomplete="off"
							autofocus
						/>
					</div>
				</Show>
			</div>
		</Modal>
	);
};

// ---- toasts ---------------------------------------------------------------

type ToastTone = "success" | "error" | "info";
type ToastItem = { id: number; tone: ToastTone; title: string; description?: string };

const [toasts, setToasts] = createStore<ToastItem[]>([]);
let toastId = 0;

const pushToast = (tone: ToastTone, title: string, description?: string) => {
	const id = ++toastId;
	setToasts((items) => [...items.slice(-3), { id, tone, title, description }]);
	setTimeout(() => dismissToast(id), tone === "error" ? 7000 : 4000);
};

const dismissToast = (id: number) => setToasts((items) => items.filter((item) => item.id !== id));

export const toast = {
	success: (title: string, description?: string) => pushToast("success", title, description),
	info: (title: string, description?: string) => pushToast("info", title, description),
	error: (title: string, error?: unknown) =>
		pushToast("error", title, error === undefined ? undefined : errorMessage(error)),
};

export const Toaster: Component = () => (
	<Portal>
		<div class="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
			<For each={toasts}>
				{(item) => (
					<div class="animate-slide-in pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-lg">
						<span
							class={cx(
								"mt-0.5 [&>svg]:h-4 [&>svg]:w-4",
								item.tone === "success" && "text-success",
								item.tone === "error" && "text-danger",
								item.tone === "info" && "text-info",
							)}
						>
							<Show when={item.tone === "success"}>
								<CircleCheck />
							</Show>
							<Show when={item.tone === "error"}>
								<CircleAlert />
							</Show>
							<Show when={item.tone === "info"}>
								<Info />
							</Show>
						</span>
						<div class="min-w-0 flex-1">
							<div class="text-[13px] font-medium">{item.title}</div>
							<Show when={item.description}>
								<div class="mt-0.5 text-[12.5px] break-words text-fg-subtle">
									{item.description}
								</div>
							</Show>
						</div>
						<button
							type="button"
							class="text-fg-faint hover:text-fg"
							onClick={() => dismissToast(item.id)}
							aria-label="Dismiss"
						>
							<X width={14} height={14} />
						</button>
					</div>
				)}
			</For>
		</div>
	</Portal>
);

// ---- dropdown menu --------------------------------------------------------

export type MenuItem =
	| {
			label: JSX.Element;
			icon?: JSX.Element;
			onSelect: () => void;
			danger?: boolean;
			disabled?: boolean;
			hint?: JSX.Element;
	  }
	| { separator: true };

export const DropdownMenu: Component<{
	trigger: (props: {
		onClick: (event: MouseEvent) => void;
		"aria-expanded": boolean;
	}) => JSX.Element;
	items: MenuItem[];
	align?: "start" | "end";
	class?: string;
	placement?: "bottom" | "top";
}> = (props) => {
	const [open, setOpen] = createSignal(false);
	let root: HTMLDivElement | undefined;

	createEffect(() => {
		if (!open()) return;
		const onPointer = (event: MouseEvent) => {
			if (root && !root.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onPointer);
		document.addEventListener("keydown", onKey);
		onCleanup(() => {
			document.removeEventListener("mousedown", onPointer);
			document.removeEventListener("keydown", onKey);
		});
	});

	return (
		<div class={cx("relative inline-block", props.class)} ref={root}>
			{props.trigger({
				onClick: (event) => {
					event.stopPropagation();
					event.preventDefault();
					setOpen(!open());
				},
				"aria-expanded": open(),
			})}
			<Show when={open()}>
				<div
					role="menu"
					class={cx(
						"animate-pop-in absolute z-40 min-w-[200px] rounded-lg border border-border bg-surface p-1 shadow-lg",
						props.align === "start" ? "left-0" : "right-0",
						props.placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
					)}
				>
					<For each={props.items}>
						{(item) =>
							"separator" in item ? (
								<div class="my-1 h-px bg-border" />
							) : (
								<button
									type="button"
									role="menuitem"
									disabled={item.disabled}
									onClick={(event) => {
										event.stopPropagation();
										setOpen(false);
										item.onSelect();
									}}
									class={cx(
										"flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] disabled:opacity-50 [&>svg]:h-4 [&>svg]:w-4",
										item.danger
											? "text-danger hover:bg-danger-soft"
											: "text-fg-muted hover:bg-surface-hover hover:text-fg",
									)}
								>
									{item.icon}
									<span class="flex-1">{item.label}</span>
									<Show when={item.hint}>
										<span class="text-[11.5px] text-fg-faint">{item.hint}</span>
									</Show>
								</button>
							)
						}
					</For>
				</div>
			</Show>
		</div>
	);
};
