import { A } from "@solidjs/router";
import Check from "lucide-solid/icons/check";
import CircleAlert from "lucide-solid/icons/circle-alert";
import CircleCheck from "lucide-solid/icons/circle-check";
import Copy from "lucide-solid/icons/copy";
import Eye from "lucide-solid/icons/eye";
import EyeOff from "lucide-solid/icons/eye-off";
import Info from "lucide-solid/icons/info";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import {
	type Component,
	createSignal,
	For,
	type JSX,
	Match,
	type ParentComponent,
	Show,
	Switch as SolidSwitch,
	splitProps,
} from "solid-js";
import { copyToClipboard } from "../../lib/format";
import { isInProgress, statusLabel, type Tone, toneColor, toneFor } from "../../lib/status";

export const cx = (...classes: Array<string | false | null | undefined>) =>
	classes.filter(Boolean).join(" ");

// ---- spinner --------------------------------------------------------------

export const Spinner: Component<{ size?: number; class?: string }> = (props) => (
	<LoaderCircle
		class={cx("animate-spin text-fg-subtle", props.class)}
		width={props.size ?? 16}
		height={props.size ?? 16}
	/>
);

// ---- button ---------------------------------------------------------------

type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger" | "danger-outline";

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: ButtonVariant;
	size?: "sm" | "md" | "lg";
	icon?: boolean;
	loading?: boolean;
};

export const Button: ParentComponent<ButtonProps> = (props) => {
	const [local, rest] = splitProps(props, [
		"variant",
		"size",
		"icon",
		"loading",
		"class",
		"children",
		"disabled",
		"type",
	]);
	return (
		<button
			type={local.type ?? "button"}
			class={cx(
				"btn",
				`btn-${local.variant ?? "secondary"}`,
				local.size === "sm" && "btn-sm",
				local.size === "lg" && "btn-lg",
				local.icon && "btn-icon",
				local.class,
			)}
			disabled={local.disabled || local.loading}
			{...rest}
		>
			<Show when={local.loading}>
				<LoaderCircle class="animate-spin" />
			</Show>
			{local.children}
		</button>
	);
};

export const LinkButton: ParentComponent<{
	href: string;
	variant?: ButtonVariant;
	size?: "sm" | "md" | "lg";
	class?: string;
	external?: boolean;
}> = (props) => {
	const classes = () =>
		cx(
			"btn",
			`btn-${props.variant ?? "secondary"}`,
			props.size === "sm" && "btn-sm",
			props.size === "lg" && "btn-lg",
			props.class,
		);
	return (
		<Show
			when={!props.external}
			fallback={
				<a href={props.href} target="_blank" rel="noreferrer" class={classes()}>
					{props.children}
				</a>
			}
		>
			<A href={props.href} class={classes()}>
				{props.children}
			</A>
		</Show>
	);
};

// ---- form controls --------------------------------------------------------

export const Field: ParentComponent<{
	label?: JSX.Element;
	hint?: JSX.Element;
	error?: string | null;
	class?: string;
	for?: string;
	optional?: boolean;
}> = (props) => (
	<div class={props.class}>
		<Show when={props.label}>
			<label class="label" for={props.for}>
				{props.label}
				<Show when={props.optional}>
					<span class="ml-1.5 font-normal text-fg-faint">optional</span>
				</Show>
			</label>
		</Show>
		{props.children}
		<Show when={props.error}>
			<p class="mt-1.5 text-xs text-danger">{props.error}</p>
		</Show>
		<Show when={!props.error && props.hint}>
			<p class="hint">{props.hint}</p>
		</Show>
	</div>
);

export const Input: Component<JSX.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }> = (
	props,
) => {
	const [local, rest] = splitProps(props, ["class", "mono"]);
	return (
		<input class={cx("input", local.mono && "font-mono text-[12.5px]", local.class)} {...rest} />
	);
};

export const PasswordInput: Component<JSX.InputHTMLAttributes<HTMLInputElement>> = (props) => {
	const [visible, setVisible] = createSignal(false);
	const [local, rest] = splitProps(props, ["class"]);
	return (
		<div class="relative">
			<input
				class={cx("input pr-9 font-mono text-[12.5px]", local.class)}
				type={visible() ? "text" : "password"}
				{...rest}
			/>
			<button
				type="button"
				class="absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg"
				onClick={() => setVisible(!visible())}
				aria-label={visible() ? "Hide value" : "Show value"}
				tabIndex={-1}
			>
				<Show when={visible()} fallback={<Eye width={14} height={14} />}>
					<EyeOff width={14} height={14} />
				</Show>
			</button>
		</div>
	);
};

export const Textarea: Component<
	JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }
> = (props) => {
	const [local, rest] = splitProps(props, ["class", "mono"]);
	return (
		<textarea
			class={cx("textarea", local.mono && "font-mono text-[12.5px]", local.class)}
			{...rest}
		/>
	);
};

export const Select: ParentComponent<JSX.SelectHTMLAttributes<HTMLSelectElement>> = (props) => {
	const [local, rest] = splitProps(props, ["class", "children"]);
	return (
		<select class={cx("select", local.class)} {...rest}>
			{local.children}
		</select>
	);
};

export const Switch: Component<{
	checked: boolean;
	onChange: (value: boolean) => void;
	disabled?: boolean;
	label?: string;
	id?: string;
}> = (props) => (
	<button
		type="button"
		role="switch"
		id={props.id}
		aria-checked={props.checked}
		aria-label={props.label}
		disabled={props.disabled}
		onClick={() => props.onChange(!props.checked)}
		class={cx(
			"relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
			props.checked ? "border-accent bg-accent" : "border-border-strong bg-surface-2",
		)}
	>
		<span
			class={cx(
				"inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
				props.checked ? "translate-x-[18px]" : "translate-x-[2px]",
			)}
		/>
	</button>
);

/** a row with a title/description on the left and a control on the right */
export const SettingRow: ParentComponent<{
	title: JSX.Element;
	description?: JSX.Element;
	class?: string;
}> = (props) => (
	<div class={cx("flex items-start justify-between gap-6 py-4", props.class)}>
		<div class="min-w-0">
			<div class="text-[13px] font-medium">{props.title}</div>
			<Show when={props.description}>
				<div class="mt-0.5 text-[13px] text-fg-subtle">{props.description}</div>
			</Show>
		</div>
		<div class="shrink-0">{props.children}</div>
	</div>
);

// ---- surfaces -------------------------------------------------------------

export const Card: ParentComponent<{
	title?: JSX.Element;
	description?: JSX.Element;
	actions?: JSX.Element;
	footer?: JSX.Element;
	class?: string;
	bodyClass?: string;
	flush?: boolean;
	id?: string;
}> = (props) => (
	<section class={cx("card", props.class)} id={props.id}>
		<Show when={props.title || props.actions}>
			<header class="card-header">
				<div class="min-w-0">
					<Show when={props.title}>
						<h2 class="card-title">{props.title}</h2>
					</Show>
					<Show when={props.description}>
						<p class="card-description">{props.description}</p>
					</Show>
				</div>
				<Show when={props.actions}>
					<div class="flex shrink-0 items-center gap-2">{props.actions}</div>
				</Show>
			</header>
		</Show>
		<div class={cx(!props.flush && "card-body", props.bodyClass)}>{props.children}</div>
		<Show when={props.footer}>
			<footer class="card-footer">{props.footer}</footer>
		</Show>
	</section>
);

export const PageHeader: ParentComponent<{
	title: JSX.Element;
	description?: JSX.Element;
	actions?: JSX.Element;
	eyebrow?: JSX.Element;
}> = (props) => (
	<div class="mb-6 flex flex-wrap items-end justify-between gap-4">
		<div class="min-w-0">
			<Show when={props.eyebrow}>
				<div class="mb-1.5 text-[12px] font-medium text-fg-subtle">{props.eyebrow}</div>
			</Show>
			<h1 class="text-[22px] font-semibold tracking-[-0.02em]">{props.title}</h1>
			<Show when={props.description}>
				<p class="mt-1 max-w-2xl text-[13.5px] text-fg-subtle">{props.description}</p>
			</Show>
		</div>
		<Show when={props.actions}>
			<div class="flex flex-wrap items-center gap-2">{props.actions}</div>
		</Show>
	</div>
);

export const EmptyState: ParentComponent<{
	icon?: JSX.Element;
	title: JSX.Element;
	description?: JSX.Element;
	class?: string;
}> = (props) => (
	<div
		class={cx(
			"flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-14 text-center",
			props.class,
		)}
	>
		<Show when={props.icon}>
			<div class="mb-4 flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface text-fg-subtle shadow-sm [&>svg]:h-5 [&>svg]:w-5">
				{props.icon}
			</div>
		</Show>
		<h3 class="text-[15px] font-semibold">{props.title}</h3>
		<Show when={props.description}>
			<p class="mt-1 max-w-sm text-[13px] text-fg-subtle">{props.description}</p>
		</Show>
		<Show when={props.children}>
			<div class="mt-5 flex flex-wrap items-center justify-center gap-2">{props.children}</div>
		</Show>
	</div>
);

export const Notice: ParentComponent<{
	tone?: "info" | "success" | "warning" | "danger" | "neutral";
	title?: JSX.Element;
	class?: string;
}> = (props) => (
	<div
		class={cx(
			"notice",
			props.tone && props.tone !== "neutral" && `notice-${props.tone}`,
			props.class,
		)}
	>
		<SolidSwitch fallback={<Info />}>
			<Match when={props.tone === "danger"}>
				<CircleAlert />
			</Match>
			<Match when={props.tone === "warning"}>
				<TriangleAlert />
			</Match>
			<Match when={props.tone === "success"}>
				<CircleCheck />
			</Match>
		</SolidSwitch>
		<div class="min-w-0 flex-1">
			<Show when={props.title}>
				<div class="font-medium">{props.title}</div>
			</Show>
			<div class={cx(props.title ? "mt-0.5 opacity-90" : undefined)}>{props.children}</div>
		</div>
	</div>
);

export const Skeleton: Component<{ class?: string }> = (props) => (
	<div class={cx("skeleton", props.class ?? "h-4 w-full")} />
);

// ---- status ---------------------------------------------------------------

export const StatusDot: Component<{ status?: string | null; tone?: Tone; class?: string }> = (
	props,
) => {
	const tone = () => props.tone ?? toneFor(props.status);
	return (
		<span
			class={cx("dot", isInProgress(props.status) && "dot-pulse", props.class)}
			style={{ background: toneColor[tone()], color: toneColor[tone()] }}
		/>
	);
};

export const Badge: ParentComponent<{ tone?: Tone; class?: string; title?: string }> = (props) => (
	<span
		title={props.title}
		class={cx(
			"badge",
			props.tone && props.tone !== "neutral" && `badge-${props.tone}`,
			props.class,
		)}
	>
		{props.children}
	</span>
);

export const StatusBadge: Component<{ status?: string | null; label?: string }> = (props) => (
	<Badge tone={toneFor(props.status)}>
		<StatusDot status={props.status} class="h-1.5! w-1.5!" />
		{props.label ?? statusLabel(props.status)}
	</Badge>
);

// ---- copy -----------------------------------------------------------------

export const CopyButton: Component<{ value: string; class?: string; label?: string }> = (props) => {
	const [copied, setCopied] = createSignal(false);
	const copy = async (event: MouseEvent) => {
		event.stopPropagation();
		event.preventDefault();
		if (await copyToClipboard(props.value)) {
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		}
	};
	return (
		<button
			type="button"
			onClick={copy}
			title={props.label ?? "Copy"}
			aria-label={props.label ?? "Copy"}
			class={cx(
				"inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg",
				props.class,
			)}
		>
			<Show when={copied()} fallback={<Copy width={13} height={13} />}>
				<Check width={13} height={13} class="text-success" />
			</Show>
		</button>
	);
};

/** read-only value with a copy button, optionally masked */
export const CopyField: Component<{ value: string; secret?: boolean; class?: string }> = (
	props,
) => {
	const [revealed, setRevealed] = createSignal(!props.secret);
	return (
		<div
			class={cx(
				"flex h-[34px] min-w-0 items-center gap-1 rounded-md border border-border bg-surface-2 pr-1 pl-2.5",
				props.class,
			)}
		>
			<code class="min-w-0 flex-1 truncate text-[12.5px] text-fg-muted">
				{revealed() ? props.value : "•".repeat(Math.min(28, Math.max(8, props.value.length)))}
			</code>
			<Show when={props.secret}>
				<button
					type="button"
					class="inline-flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg"
					onClick={() => setRevealed(!revealed())}
					aria-label={revealed() ? "Hide" : "Reveal"}
				>
					<Show when={revealed()} fallback={<Eye width={13} height={13} />}>
						<EyeOff width={13} height={13} />
					</Show>
				</button>
			</Show>
			<CopyButton value={props.value} />
		</div>
	);
};

// ---- key/value list -------------------------------------------------------

export const DescriptionList: Component<{
	items: Array<{ label: JSX.Element; value: JSX.Element; mono?: boolean }>;
	class?: string;
}> = (props) => (
	<dl class={cx("divide-y divide-border", props.class)}>
		<For each={props.items}>
			{(item) => (
				<div class="grid grid-cols-[minmax(120px,180px)_1fr] items-center gap-4 py-2.5 text-[13px]">
					<dt class="text-fg-subtle">{item.label}</dt>
					<dd class={cx("min-w-0 truncate", item.mono && "font-mono text-[12.5px]")}>
						{item.value}
					</dd>
				</div>
			)}
		</For>
	</dl>
);

// ---- segmented control ----------------------------------------------------

export const Segmented = <T extends string>(props: {
	value: T;
	options: Array<{ value: T; label: JSX.Element }>;
	onChange: (value: T) => void;
	class?: string;
}) => (
	<div class={cx("segmented", props.class)}>
		<For each={props.options}>
			{(option) => (
				<button
					type="button"
					class={cx(props.value === option.value && "active")}
					onClick={() => props.onChange(option.value)}
				>
					{option.label}
				</button>
			)}
		</For>
	</div>
);

// ---- meter ----------------------------------------------------------------

export const Meter: Component<{ value: number; class?: string; tone?: Tone }> = (props) => {
	const pct = () => Math.max(0, Math.min(100, Number.isFinite(props.value) ? props.value : 0));
	const tone = (): Tone =>
		props.tone ?? (pct() >= 90 ? "danger" : pct() >= 75 ? "warning" : "accent");
	return (
		<div class={cx("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", props.class)}>
			<div
				class="h-full rounded-full transition-[width] duration-500"
				style={{ width: `${pct()}%`, background: toneColor[tone()] }}
			/>
		</div>
	);
};

// ---- save bar -------------------------------------------------------------

/** floating bar shown while a form has unsaved changes */
export const SaveBar: Component<{
	dirty: boolean;
	saving?: boolean;
	onSave: () => void;
	onReset: () => void;
	label?: string;
}> = (props) => (
	<Show when={props.dirty}>
		<div class="animate-slide-in sticky bottom-4 z-20 mt-6 flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3 shadow-lg">
			<span class="flex items-center gap-2 text-[13px] text-fg-muted">
				<span class="dot" style={{ background: "var(--warning)" }} />
				{props.label ?? "You have unsaved changes"}
			</span>
			<div class="flex gap-2">
				<Button variant="ghost" onClick={() => props.onReset()} disabled={props.saving}>
					Discard
				</Button>
				<Button variant="primary" onClick={() => props.onSave()} loading={props.saving}>
					Save changes
				</Button>
			</div>
		</div>
	</Show>
);
