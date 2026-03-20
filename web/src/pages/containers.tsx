import { A } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { EmptyBlock, LoadingBlock, Notice, PageTitle, Panel } from "../components/Plain";
import { useAppStore } from "../context/AppStore";

const Containers = () => {
	const { state, loadContainers } = useAppStore();
	const [query, setQuery] = createSignal("");

	createEffect(() => {
		void loadContainers();
	});

	const pollInterval = setInterval(() => void loadContainers(), 30000);
	onCleanup(() => clearInterval(pollInterval));

	const filtered = createMemo(() => {
		const needle = query().trim().toLowerCase();
		if (!needle) return state.containers;
		return state.containers.filter((container) =>
			[container.id, container.name, container.resource_type, container.resource_id]
				.join(" ")
				.toLowerCase()
				.includes(needle),
		);
	});

	return (
		<div class="flex flex-col gap-6">
			<PageTitle
				title="Containers"
				subtitle="Inspect runtime containers, mounts, logs, files, and shell access."
				actions={
					<button
						type="button"
						onClick={() => void loadContainers()}
						class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
					>
						Refresh
					</button>
				}
			/>

			<Panel title="Filter Containers">
				<label class="flex flex-col gap-2">
					<span class="text-sm font-medium leading-none">Query</span>
					<input
						class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						value={query()}
						onInput={(event) => setQuery(event.currentTarget.value)}
						placeholder="Search by ID, name, or resource..."
					/>
				</label>
			</Panel>

			<Show when={state.containersLoading}>
				<LoadingBlock message="Loading containers..." />
			</Show>

			<Show when={state.containersError}>
				<Notice tone="error">Failed to load containers: {state.containersError}</Notice>
			</Show>

			<Show when={!state.containersLoading && filtered().length === 0}>
				<EmptyBlock title="No containers available">
					Start a service or deployment and its active containers will appear here.
				</EmptyBlock>
			</Show>

			<Show when={!state.containersLoading && filtered().length > 0}>
				<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					<For each={filtered()}>
						{(container) => (
							<article class="rounded-xl border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-4 hover:border-primary/20 transition-colors">
								<div class="flex justify-between items-start gap-3">
									<div class="min-w-0">
										<A
											class="font-semibold tracking-tight hover:underline text-base truncate block"
											href={`/containers/${container.id}`}
										>
											{container.name}
										</A>
										<p class="text-xs text-muted-foreground font-mono truncate mt-1">
											{container.id}
										</p>
									</div>
									<span class="inline-flex items-center rounded bg-secondary px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider whitespace-nowrap">
										{container.resource_type}
									</span>
								</div>
								<div class="flex flex-col gap-1 py-3 border-y border-border">
									<p class="text-[0.7rem] font-semibold uppercase text-muted-foreground tracking-wider">
										Resource ID
									</p>
									<p class="text-xs font-mono truncate">{container.resource_id}</p>
								</div>
								<div class="flex justify-end gap-2">
									<A
										href={`/containers/${container.id}`}
										class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3 w-full"
									>
										Open Container
									</A>
								</div>
							</article>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
};

export default Containers;
