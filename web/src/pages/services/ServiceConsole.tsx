import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import Plug from "lucide-solid/icons/plug";
import Unplug from "lucide-solid/icons/unplug";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { errorMessage } from "../../api/http";
import { execSocketUrl, issueExecToken } from "../../api/platform";
import { Button, EmptyState, Select, StatusDot } from "../../components/ui";
import { useService } from "./context";

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/ash"];

const ServiceConsole = () => {
	const ctx = useService();
	const [container, setContainer] = createSignal("");
	const [shell, setShell] = createSignal("/bin/sh");
	const [state, setState] = createSignal<"idle" | "connecting" | "open" | "closed">("idle");
	let host: HTMLDivElement | undefined;
	let terminal: Terminal | undefined;
	let fit: FitAddon | undefined;
	let socket: WebSocket | null = null;
	const encoder = new TextEncoder();

	createEffect(() => {
		const ids = ctx.service()?.container_ids ?? [];
		if (!ids.includes(container())) setContainer(ids[0] ?? "");
	});

	const disconnect = () => {
		const current = socket;
		socket = null;
		current?.close();
	};

	const connect = async () => {
		if (!terminal || !container()) return;
		disconnect();
		terminal.reset();
		setState("connecting");
		terminal.writeln(`\x1b[2mConnecting to ${container()} with ${shell()}…\x1b[0m`);
		try {
			const { token } = await issueExecToken(container());
			fit?.fit();
			const ws = new WebSocket(
				execSocketUrl(container(), token, shell(), terminal.cols, terminal.rows),
			);
			ws.binaryType = "arraybuffer";
			socket = ws;
			ws.onopen = () => {
				if (socket !== ws) return;
				setState("open");
				terminal?.focus();
			};
			ws.onmessage = (event) => {
				if (socket !== ws || !terminal) return;
				if (typeof event.data === "string") terminal.writeln(`\r\n\x1b[33m${event.data}\x1b[0m`);
				else terminal.write(new Uint8Array(event.data as ArrayBuffer));
			};
			ws.onclose = () => {
				if (socket !== ws) return;
				socket = null;
				setState("closed");
				terminal?.writeln("\r\n\x1b[2mSession closed. Press Connect to start a new one.\x1b[0m");
			};
		} catch (error) {
			setState("closed");
			terminal.writeln(`\x1b[31m${errorMessage(error, "Could not open a session")}\x1b[0m`);
		}
	};

	onMount(() => {
		if (!host) return;
		terminal = new Terminal({
			cursorBlink: true,
			fontFamily: '"Geist Mono", ui-monospace, Menlo, monospace',
			fontSize: 13,
			lineHeight: 1.25,
			theme: {
				background: "#0b0b0e",
				foreground: "#e4e4e7",
				cursor: "#a5b4fc",
				selectionBackground: "#3f3f46",
			},
			scrollback: 5000,
		});
		fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host);
		fit.fit();
		terminal.onData((data) => {
			if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
		});
		terminal.onResize(({ cols, rows }) => {
			if (socket?.readyState === WebSocket.OPEN)
				socket.send(JSON.stringify({ type: "resize", cols, rows }));
		});
		const observer = new ResizeObserver(() => fit?.fit());
		observer.observe(host);
		terminal.writeln(
			"\x1b[2mOpen a shell inside a running container. Commands run as the container's user.\x1b[0m",
		);
		onCleanup(() => {
			observer.disconnect();
			disconnect();
			terminal?.dispose();
		});
	});

	const hasContainers = () => (ctx.service()?.container_ids.length ?? 0) > 0;

	return (
		<div class="space-y-3">
			<Show when={!hasContainers()}>
				<EmptyState
					icon={<Plug />}
					title="No running container"
					description="Start or deploy the service to open a shell."
				/>
			</Show>
			<div class="flex flex-wrap items-center gap-2" classList={{ hidden: !hasContainers() }}>
				<Show when={(ctx.service()?.container_ids.length ?? 0) > 1}>
					<Select
						class="w-auto max-w-[260px]"
						value={container()}
						onChange={(event) => setContainer(event.currentTarget.value)}
					>
						<For each={ctx.service()?.container_ids}>
							{(id) => <option value={id}>{id}</option>}
						</For>
					</Select>
				</Show>
				<Select
					class="w-auto font-mono text-[12.5px]"
					value={shell()}
					onChange={(event) => setShell(event.currentTarget.value)}
				>
					<For each={SHELLS}>{(item) => <option value={item}>{item}</option>}</For>
				</Select>
				<Show
					when={state() === "open"}
					fallback={
						<Button
							variant="primary"
							loading={state() === "connecting"}
							onClick={() => void connect()}
						>
							<Plug />
							Connect
						</Button>
					}
				>
					<Button variant="secondary" onClick={disconnect}>
						<Unplug />
						Disconnect
					</Button>
				</Show>
				<span class="ml-auto flex items-center gap-2 text-[12.5px] text-fg-subtle">
					<StatusDot
						tone={state() === "open" ? "success" : state() === "connecting" ? "info" : "neutral"}
					/>
					{state() === "open"
						? "Connected"
						: state() === "connecting"
							? "Connecting"
							: "Not connected"}
				</span>
			</div>
			<div
				class="log-view h-[calc(100vh-330px)] min-h-[360px] p-3"
				classList={{ hidden: !hasContainers() }}
			>
				<div ref={host} class="h-full w-full" />
			</div>
		</div>
	);
};

export default ServiceConsole;
