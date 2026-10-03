import { A, useSearchParams } from "@solidjs/router";
import Search from "lucide-solid/icons/search";
import { createMemo, For, Show } from "solid-js";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import { cx, EmptyState, Input, PageHeader } from "../../components/ui";
import { CATEGORIES, TEMPLATES } from "../../lib/catalog";
import { AppLogo } from "./AppLogo";

const AppCatalog = () => {
	useBreadcrumbs(() => [{ label: "One-Click Apps" }]);
	const [params, setParams] = useSearchParams();
	const query = () => (typeof params.q === "string" ? params.q : "");
	const category = () => (typeof params.category === "string" ? params.category : "");

	const filtered = createMemo(() => {
		const needle = query().trim().toLowerCase();
		return TEMPLATES.filter((template) => {
			if (category() && template.category !== category()) return false;
			if (!needle) return true;
			return `${template.name} ${template.description} ${template.category} ${(template.tags ?? []).join(" ")}`
				.toLowerCase()
				.includes(needle);
		});
	});

	const counts = createMemo(() => {
		const map = new Map<string, number>();
		for (const template of TEMPLATES)
			map.set(template.category, (map.get(template.category) ?? 0) + 1);
		return map;
	});

	return (
		<div class="animate-fade-in">
			<PageHeader
				title="One-Click Apps"
				description={`${TEMPLATES.length} preconfigured apps. Each one deploys as a project with its database, volumes and secrets already wired up.`}
			/>
			<div class="grid gap-8 lg:grid-cols-[200px_1fr]">
				<aside class="space-y-4">
					<div class="relative">
						<Search
							width={14}
							height={14}
							class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint"
						/>
						<Input
							class="pl-8"
							placeholder="Search apps"
							value={query()}
							onInput={(event) =>
								setParams({ q: event.currentTarget.value || undefined }, { replace: true })
							}
						/>
					</div>
					<nav class="flex gap-1 overflow-x-auto lg:flex-col">
						<button
							type="button"
							onClick={() => setParams({ category: undefined })}
							class={cx("nav-item shrink-0 justify-between", !category() && "active")}
						>
							All apps
							<span class="text-[12px] text-fg-faint">{TEMPLATES.length}</span>
						</button>
						<For each={CATEGORIES.filter((item) => counts().has(item))}>
							{(item) => (
								<button
									type="button"
									onClick={() => setParams({ category: item })}
									class={cx("nav-item shrink-0 justify-between", category() === item && "active")}
								>
									{item}
									<span class="text-[12px] text-fg-faint">{counts().get(item)}</span>
								</button>
							)}
						</For>
					</nav>
				</aside>
				<div>
					<Show
						when={filtered().length > 0}
						fallback={
							<EmptyState
								icon={<Search />}
								title="No apps found"
								description="Try another search, or deploy any image directly."
							/>
						}
					>
						<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
							<For each={filtered()}>
								{(template) => (
									<A href={`/apps/${template.id}`} class="card card-interactive flex flex-col p-4">
										<div class="flex items-center gap-3">
											<AppLogo template={template} />
											<div class="min-w-0">
												<div class="truncate text-[14px] font-semibold">{template.name}</div>
												<div class="text-[12px] text-fg-subtle">{template.category}</div>
											</div>
										</div>
										<p class="mt-3 line-clamp-2 text-[13px] text-fg-muted">
											{template.description}
										</p>
									</A>
								)}
							</For>
						</div>
					</Show>
				</div>
			</div>
		</div>
	);
};

export default AppCatalog;
