import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Component, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import "@xterm/xterm/css/xterm.css";

const shellOptions = [
	{ label: "sh", value: "/bin/sh" },
	{ label: "bash", value: "/bin/bash" },
	{ label: "ash", value: "/bin/ash" },
] as const;

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

const terminalTheme = {
	background: "#000000",
	foreground: "#f5f5f5",
	cursor: "#f5f5f5",
	selectionBackground: "#404040",
};

const ContainerTerminal: Component<{ containerId: string }> = (props) => {
	const [connectionState, setConnectionState] = createSignal<ConnectionState>("disconnected");
	const [shell, setShell] = createSignal("/bin/sh");

	let terminalElement: HTMLDivElement | undefined;
	let terminal: Terminal | undefined;
	let fitAddon: FitAddon | undefined;
	let socket: WebSocket | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let removeDataHandler: (() => void) | undefined;

	const closeSocket = () => {
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		socket.close();
		socket = undefined;
	};

	const sendResize = () => {
		if (!terminal || !fitAddon) return;
		fitAddon.fit();
		if (!socket || socket.readyState !== WebSocket.OPEN) return;

		socket.send(
			JSON.stringify({
				type: "resize",
				cols: terminal.cols,
				rows: terminal.rows,
			}),
		);
	};

	const requestExecToken = async (token: string) => {
		const response = await fetch(`/api/containers/${props.containerId}/exec/token`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		if (!response.ok) {
			throw new Error("failed to create exec token");
		}

		const body = await response.json();
		if (!body?.token || typeof body.token !== "string") {
			throw new Error("invalid exec token response");
		}

		return body.token;
	};

	const connect = async () => {
		if (!terminal) return;

		closeSocket();
		terminal.clear();
		terminal.write("connecting...\r\n");

		const token = localStorage.getItem("containr_token");
		if (!token) {
			setConnectionState("error");
			terminal.write("missing auth token\r\n");
			return;
		}

		let execToken = "";
		try {
			execToken = await requestExecToken(token);
		} catch (error) {
			setConnectionState("error");
			terminal.write(
				`${error instanceof Error ? error.message : "failed to create exec token"}\r\n`,
			);
			return;
		}

		const params = new URLSearchParams({
			token: execToken,
			shell: shell(),
			cols: String(Math.max(terminal.cols || 0, 80)),
			rows: String(Math.max(terminal.rows || 0, 24)),
		});
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const url = `${protocol}//${window.location.host}/api/containers/${props.containerId}/exec/ws?${params.toString()}`;

		setConnectionState("connecting");
		socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";

		socket.onopen = () => {
			setConnectionState("connected");
			if (terminal) {
				terminal.write("[connected]\r\n");
				terminal.focus();
			}
			sendResize();
		};

		socket.onmessage = (event) => {
			if (!terminal) return;

			if (typeof event.data === "string") {
				terminal.write(event.data);
				return;
			}

			if (event.data instanceof ArrayBuffer) {
				terminal.write(new Uint8Array(event.data));
				return;
			}

			if (event.data instanceof Blob) {
				void event.data.arrayBuffer().then((buffer) => {
					terminal?.write(new Uint8Array(buffer));
				});
			}
		};

		socket.onerror = () => {
			setConnectionState("error");
			terminal?.write("\r\n[terminal connection error]\r\n");
		};

		socket.onclose = () => {
			setConnectionState("disconnected");
			terminal?.write("\r\n[disconnected]\r\n");
		};
	};

	onMount(() => {
		terminal = new Terminal({
			cursorBlink: true,
			convertEol: true,
			fontSize: 12,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			scrollback: 5000,
			theme: terminalTheme,
		});
		fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);

		if (terminalElement) {
			terminal.open(terminalElement);
			requestAnimationFrame(() => fitAddon?.fit());
		}

		const dataDisposable = terminal.onData((data) => {
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(new TextEncoder().encode(data));
			}
		});
		removeDataHandler = () => dataDisposable.dispose();

		if (terminalElement && typeof ResizeObserver !== "undefined") {
			resizeObserver = new ResizeObserver(() => {
				sendResize();
			});
			resizeObserver.observe(terminalElement);
		}
	});

	createEffect(() => {
		props.containerId;
		shell();

		if (terminal) {
			void connect();
		}
	});

	onCleanup(() => {
		resizeObserver?.disconnect();
		removeDataHandler?.();
		closeSocket();
		terminal?.dispose();
	});

	return (
		<div class="space-y-3">
			<div class="flex items-center justify-between gap-3">
				<div class="flex items-center gap-3 text-xs text-neutral-500">
					<span>status: {connectionState()}</span>
					<span>click terminal to focus</span>
				</div>
				<div class="flex items-center gap-2">
					<select
						value={shell()}
						onChange={(e) => setShell(e.currentTarget.value)}
						class="px-2 py-1 border border-neutral-300 text-xs text-neutral-700"
					>
						{shellOptions.map((option) => (
							<option value={option.value}>{option.label}</option>
						))}
					</select>
					<button
						onClick={() => {
							void connect();
						}}
						class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
					>
						reconnect
					</button>
					<button
						onClick={() => terminal?.clear()}
						class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
					>
						clear
					</button>
				</div>
			</div>

			<div class="border border-neutral-200 bg-black">
				<div ref={terminalElement} class="h-80 overflow-hidden px-2 py-2" />
			</div>
		</div>
	);
};

export default ContainerTerminal;
