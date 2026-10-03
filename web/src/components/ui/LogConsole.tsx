import ArrowDownToLine from "lucide-solid/icons/arrow-down-to-line";
import Download from "lucide-solid/icons/download";
import Eraser from "lucide-solid/icons/eraser";
import Pause from "lucide-solid/icons/pause";
import Play from "lucide-solid/icons/play";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Search from "lucide-solid/icons/search";
import WrapText from "lucide-solid/icons/text-wrap";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	on,
	Show,
} from "solid-js";
import type { LogStream } from "../../lib/logs";
import { cx } from "./index";

const levelClass = (line: string) => {
	const lower = line.toLowerCase();
	if (/\b(error|err|fatal|panic|exception|failed)\b/.test(lower)) return "text-[#fca5a5]";
	if (/\b(warn|warning)\b/.test(lower)) return "text-[#fcd34d]";
	if (/^(step|#\d+|-->|=>)/i.test(line.trim())) return "text-[#a5b4fc]";
	return "";
};

const highlight = (line: string, needle: string): JSX.Element => {
	if (!needle) return line;
	const lower = line.toLowerCase();
	const parts: JSX.Element[] = [];
	let index = 0;
	let found = lower.indexOf(needle, index);
	while (found !== -1) {
		parts.push(line.slice(index, found));
		parts.push(
			<mark class="rounded-sm bg-[#fde047]/30 text-inherit">
				{line.slice(found, found + needle.length)}
			</mark>,
		);
		index = found + needle.length;
		found = lower.indexOf(needle, index);
	}
	parts.push(line.slice(index));
	return parts;
};

export const LogConsole: Component<{
	stream: LogStream;
	title?: JSX.Element;
	height?: string;
	filename?: string;
	emptyText?: string;
	live?: boolean;
	class?: string;
}> = (props) => {
	const [query, setQuery] = createSignal("");
	const [wrap, setWrap] = createSignal(true);
	const [follow, setFollow] = createSignal(true);
	let scroller: HTMLDivElement | undefined;

	const needle = () => query().trim().toLowerCase();
	const visible = createMemo(() => {
		const lines = props.stream.lines();
		return needle() ? lines.filter((line) => line.toLowerCase().includes(needle())) : lines;
	});

	createEffect(
		on(visible, () => {
			if (follow() && scroller) {
				queueMicrotask(() => {
					if (scroller) scroller.scrollTop = scroller.scrollHeight;
				});
			}
		}),
	);

	const onScroll = () => {
		if (!scroller) return;
		const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
		setFollow(atBottom);
	};

	const download = () => {
		const blob = new Blob([props.stream.lines().join("\n")], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = props.filename ?? "logs.txt";
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};

	const toolButton =
		"inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 [&>svg]:h-3.5 [&>svg]:w-3.5";

	return (
		<div class={cx("log-view flex flex-col overflow-hidden", props.class)}>
			<div class="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
				<Show when={props.live !== false}>
					<span class="flex items-center gap-2 text-[11.5px] text-zinc-400">
						<span
							class={cx("dot", props.stream.connected() && !props.stream.paused() && "dot-pulse")}
							style={{
								background: props.stream.connected()
									? props.stream.paused()
										? "#f59e0b"
										: "#22c55e"
									: "#52525b",
								color: "#22c55e",
							}}
						/>
						{props.stream.paused()
							? "Paused"
							: props.stream.connected()
								? "Live"
								: props.stream.loading()
									? "Loading"
									: "Offline"}
					</span>
				</Show>
				<Show when={props.title}>
					<span class="truncate text-[12px] text-zinc-300">{props.title}</span>
				</Show>
				<div class="relative ml-auto w-full max-w-[220px]">
					<Search
						width={13}
						height={13}
						class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-zinc-500"
					/>
					<input
						class="h-7 w-full rounded-md border border-white/10 bg-white/[0.04] pr-2 pl-7 font-sans text-[12px] text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-white/25"
						placeholder="Filter"
						value={query()}
						onInput={(event) => setQuery(event.currentTarget.value)}
					/>
				</div>
				<Show when={props.live !== false}>
					<button
						type="button"
						class={toolButton}
						title={props.stream.paused() ? "Resume" : "Pause"}
						onClick={() => props.stream.setPaused(!props.stream.paused())}
					>
						<Show when={props.stream.paused()} fallback={<Pause />}>
							<Play />
						</Show>
					</button>
				</Show>
				<button
					type="button"
					class={cx(toolButton, wrap() && "text-zinc-100")}
					title="Wrap lines"
					onClick={() => setWrap(!wrap())}
				>
					<WrapText />
				</button>
				<button
					type="button"
					class={toolButton}
					title="Reload"
					onClick={() => props.stream.reconnect()}
				>
					<RefreshCw />
				</button>
				<button type="button" class={toolButton} title="Clear" onClick={() => props.stream.clear()}>
					<Eraser />
				</button>
				<button type="button" class={toolButton} title="Download" onClick={download}>
					<Download />
				</button>
			</div>
			<div
				ref={scroller}
				onScroll={onScroll}
				class="relative shrink-0 overflow-auto px-3 py-2"
				style={{ height: props.height ?? "520px" }}
			>
				<Show
					when={visible().length > 0}
					fallback={
						<div class="py-10 text-center font-sans text-[12.5px] text-zinc-500">
							{needle()
								? "No lines match the filter."
								: props.stream.loading()
									? "Loading logs…"
									: (props.emptyText ?? "No output yet.")}
						</div>
					}
				>
					<For each={visible()}>
						{(line) => (
							<div
								class={cx(
									"rounded-sm px-1 hover:bg-white/[0.04]",
									wrap() ? "break-all whitespace-pre-wrap" : "whitespace-pre",
									levelClass(line),
								)}
							>
								{highlight(line, needle())}
							</div>
						)}
					</For>
				</Show>
			</div>
			<Show when={!follow() && visible().length > 0}>
				<div class="pointer-events-none relative">
					<button
						type="button"
						class="pointer-events-auto absolute right-4 bottom-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-zinc-800 px-3 py-1.5 font-sans text-[12px] text-zinc-100 shadow-lg hover:bg-zinc-700"
						onClick={() => {
							setFollow(true);
							if (scroller) scroller.scrollTop = scroller.scrollHeight;
						}}
					>
						<ArrowDownToLine width={13} height={13} />
						Jump to latest
					</button>
				</div>
			</Show>
			<Show when={props.stream.error()}>
				<div class="border-t border-white/[0.07] px-3 py-1.5 font-sans text-[12px] text-amber-300">
					{props.stream.error()}
				</div>
			</Show>
		</div>
	);
};
