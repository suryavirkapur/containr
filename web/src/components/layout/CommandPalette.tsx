import { useNavigate } from "@solidjs/router";
import ArrowRight from "lucide-solid/icons/arrow-right";
import Search from "lucide-solid/icons/search";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	onCleanup,
	Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { useAppStore } from "../../context/AppStore";
import { cx, StatusDot } from "../ui";

export type PaletteCommand = {
	id: string;
	label: string;
	group: string;
	icon?: JSX.Element;
	keywords?: string;
	hint?: string;
	status?: string;
	run: () => void;
};

const [open, setOpen] = createSignal(false);
export const openCommandPalette = () => setOpen(true);

const score = (command: PaletteCommand, query: string) => {
	if (!query) return 1;
	const haystack = `${command.label} ${command.keywords ?? ""} ${command.group}`.toLowerCase();
	const needle = query.toLowerCase();
	if (command.label.toLowerCase().startsWith(needle)) return 3;
	if (haystack.includes(needle)) return 2;
	// subsequence match ("nsvc" → "new service")
	let index = 0;
	for (const char of haystack) {
		if (char === needle[index]) index += 1;
		if (index === needle.length) return 1;
	}
	return 0;
};

export const CommandPalette: Component<{ commands: () => PaletteCommand[] }> = (props) => {
	const store = useAppStore();
	const navigate = useNavigate();
	const [query, setQuery] = createSignal("");
	const [active, setActive] = createSignal(0);
	let input: HTMLInputElement | undefined;
	let list: HTMLDivElement | undefined;

	const onGlobalKey = (event: KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			setOpen(!open());
		}
	};
	window.addEventListener("keydown", onGlobalKey);
	onCleanup(() => window.removeEventListener("keydown", onGlobalKey));

	const all = createMemo<PaletteCommand[]>(() => [
		...props.commands(),
		...store.state.services.map((service) => ({
			id: `service:${service.id}`,
			label: service.name,
			group: "Services",
			keywords: `${service.project_name ?? ""} ${service.image ?? ""} ${service.domains.join(" ")}`,
			hint: service.project_name ?? undefined,
			status: service.status,
			run: () => navigate(`/services/${service.id}`),
		})),
	]);

	const results = createMemo(() =>
		all()
			.map((command) => ({ command, score: score(command, query().trim()) }))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 40)
			.map((item) => item.command),
	);

	const grouped = createMemo(() => {
		const groups: Array<{
			name: string;
			items: Array<{ command: PaletteCommand; index: number }>;
		}> = [];
		results().forEach((command, index) => {
			let group = groups.find((item) => item.name === command.group);
			if (!group) {
				group = { name: command.group, items: [] };
				groups.push(group);
			}
			group.items.push({ command, index });
		});
		return groups;
	});

	createEffect(() => {
		if (open()) {
			setQuery("");
			setActive(0);
			queueMicrotask(() => input?.focus());
		}
	});

	createEffect(() => {
		query();
		setActive(0);
	});

	const run = (command?: PaletteCommand) => {
		if (!command) return;
		setOpen(false);
		command.run();
	};

	const onKey = (event: KeyboardEvent) => {
		const count = results().length;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActive((active() + 1) % Math.max(1, count));
			list?.querySelector(`[data-index="${active()}"]`)?.scrollIntoView({ block: "nearest" });
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActive((active() - 1 + count) % Math.max(1, count));
			list?.querySelector(`[data-index="${active()}"]`)?.scrollIntoView({ block: "nearest" });
		} else if (event.key === "Enter") {
			event.preventDefault();
			run(results()[active()]);
		} else if (event.key === "Escape") {
			setOpen(false);
		}
	};

	return (
		<Show when={open()}>
			<Portal>
				<div class="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[14vh]">
					<div
						role="presentation"
						class="animate-fade-in fixed inset-0 bg-black/50 backdrop-blur-[2px]"
						onClick={() => setOpen(false)}
					/>
					<div class="animate-pop-in relative w-full max-w-[600px] overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
						<div class="flex items-center gap-3 border-b border-border px-4">
							<Search width={16} height={16} class="text-fg-subtle" />
							<input
								ref={input}
								class="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-faint"
								placeholder="Search services, pages and actions…"
								value={query()}
								onInput={(event) => setQuery(event.currentTarget.value)}
								onKeyDown={onKey}
							/>
							<span class="kbd">esc</span>
						</div>
						<div ref={list} class="max-h-[380px] overflow-y-auto p-1.5">
							<Show
								when={results().length > 0}
								fallback={
									<div class="px-3 py-10 text-center text-[13px] text-fg-subtle">No results</div>
								}
							>
								<For each={grouped()}>
									{(group) => (
										<div class="mb-1">
											<div class="px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-fg-faint">
												{group.name}
											</div>
											<For each={group.items}>
												{(item) => (
													<button
														type="button"
														data-index={item.index}
														onMouseMove={() => setActive(item.index)}
														onClick={() => run(item.command)}
														class={cx(
															"flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-[13px] [&>svg]:h-4 [&>svg]:w-4",
															active() === item.index
																? "bg-surface-hover text-fg"
																: "text-fg-muted",
														)}
													>
														<Show when={item.command.status} fallback={item.command.icon}>
															<span class="flex w-4 justify-center">
																<StatusDot status={item.command.status} />
															</span>
														</Show>
														<span class="flex-1 truncate">{item.command.label}</span>
														<Show when={item.command.hint}>
															<span class="text-[12px] text-fg-faint">{item.command.hint}</span>
														</Show>
														<Show when={active() === item.index}>
															<ArrowRight width={14} height={14} class="text-fg-subtle" />
														</Show>
													</button>
												)}
											</For>
										</div>
									)}
								</For>
							</Show>
						</div>
						<div class="flex items-center gap-4 border-t border-border bg-surface-2 px-4 py-2 text-[11.5px] text-fg-faint">
							<span class="flex items-center gap-1.5">
								<span class="kbd">↑</span>
								<span class="kbd">↓</span> navigate
							</span>
							<span class="flex items-center gap-1.5">
								<span class="kbd">↵</span> open
							</span>
						</div>
					</div>
				</div>
			</Portal>
		</Show>
	);
};
