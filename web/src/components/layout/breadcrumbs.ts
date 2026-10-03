import { createEffect, createSignal, onCleanup } from "solid-js";

export type Crumb = { label: string; href?: string };

const [crumbs, setCrumbs] = createSignal<Crumb[]>([]);

export { crumbs };

/** sets the top bar breadcrumbs for the lifetime of the calling component */
export const useBreadcrumbs = (build: () => Crumb[]) => {
	// tracked, so names fill in once resources load
	createEffect(() => setCrumbs(build()));
	onCleanup(() => setCrumbs([]));
};
