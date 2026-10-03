import type { JSX, ParentComponent } from "solid-js";
import { Show } from "solid-js";
import { LogoMark } from "./Logo";

export const AuthLayout: ParentComponent<{
	title: string;
	subtitle?: JSX.Element;
	footer?: JSX.Element;
}> = (props) => (
	<main class="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
		<div class="grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)] opacity-70" />
		<div
			class="pointer-events-none absolute top-[-20%] left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full opacity-30 blur-3xl"
			style={{ background: "radial-gradient(closest-side, var(--accent), transparent)" }}
		/>
		<div class="animate-slide-in relative w-full max-w-[380px]">
			<div class="mb-8 flex flex-col items-center text-center">
				<LogoMark size={40} />
				<h1 class="mt-5 text-[22px] font-semibold tracking-[-0.02em]">{props.title}</h1>
				<Show when={props.subtitle}>
					<p class="mt-1.5 text-[13.5px] text-fg-subtle">{props.subtitle}</p>
				</Show>
			</div>
			<div class="card p-6 shadow-lg">{props.children}</div>
			<Show when={props.footer}>
				<div class="mt-6 text-center text-[13px] text-fg-subtle">{props.footer}</div>
			</Show>
		</div>
	</main>
);
