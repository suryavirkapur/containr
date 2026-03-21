import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { getServiceLogs } from "../api/services";

const ESC_CODE = 27;
const ESC = String.fromCharCode(ESC_CODE);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g");

const stripAnsi = (text: string): string => {
	return text.replace(ANSI_PATTERN, "");
};

const filterLogLine = (line: string): boolean => {
	const clean = line.trim();
	if (clean.startsWith("[connected to")) return false;
	if (clean.startsWith("[error reading logs")) return false;
	return true;
};

export const useLogStream = (
	serviceId: () => string,
	autoConnect = true,
	onLog?: (line: string) => void,
) => {
	const [logs, setLogs] = createSignal<string[]>([]);
	const [isStreaming, setIsStreaming] = createSignal(false);
	const [isLoadingHistory, setIsLoadingHistory] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [autoScroll, setAutoScroll] = createSignal(true);
	let ws: WebSocket | null = null;
	let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	let manuallyDisconnected = false;

	const buildWsUrl = () => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = window.location.host;
		const token = localStorage.getItem("containr_token");
		const params = new URLSearchParams({ tail: "0" });
		if (token) {
			params.set("token", token);
		}
		const query = `?${params.toString()}`;
		return `${protocol}//${host}/api/services/${serviceId()}/logs/ws${query}`;
	};

	const loadHistory = async () => {
		if (!serviceId()) return;
		setIsLoadingHistory(true);
		try {
			const history = await getServiceLogs(serviceId(), 300);
			const lines = (history ?? "")
				.split("\n")
				.map(stripAnsi)
				.map((line) => line.trimEnd())
				.filter(Boolean);
			setLogs(lines);
			setError(null);
		} catch {
			setError("Failed to load recent logs");
		} finally {
			setIsLoadingHistory(false);
		}
	};

	const connect = () => {
		if (!serviceId()) return;
		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
			reconnectTimeout = null;
		}
		manuallyDisconnected = false;
		setIsStreaming(true);
		setError(null);

		try {
			ws?.close();
			ws = new WebSocket(buildWsUrl());

			ws.onopen = () => {
				setIsStreaming(true);
				setError(null);
			};

			ws.onmessage = (event: MessageEvent<string>) => {
				const lines: string[] = event.data
					.split("\n")
					.filter(Boolean)
					.map(stripAnsi)
					.filter(filterLogLine);
				setLogs((prev) => [...prev, ...lines]);
				lines.forEach((line: string) => {
					onLog?.(line);
				});
			};

			ws.onerror = () => {
				setError("WebSocket connection failed");
				setIsStreaming(false);
			};

			ws.onclose = () => {
				setIsStreaming(false);
				ws = null;
				if (!manuallyDisconnected && autoConnect && serviceId()) {
					setError("Disconnected from log stream");
					reconnectTimeout = setTimeout(() => {
						reconnectTimeout = null;
						connect();
					}, 2000);
				}
			};
		} catch {
			setError("Failed to connect to log stream");
			setIsStreaming(false);
		}
	};

	const disconnect = (manual = true) => {
		manuallyDisconnected = manual;
		ws?.close();
		ws = null;
		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
			reconnectTimeout = null;
		}
		setIsStreaming(false);
	};

	const clearLogs = () => setLogs([]);

	createEffect(() => {
		if (autoConnect && serviceId()) {
			disconnect(false);
			void loadHistory();
			connect();
		}
	});

	onCleanup(() => {
		disconnect();
	});

	return {
		logs,
		isStreaming,
		isLoadingHistory,
		error,
		autoScroll,
		setAutoScroll,
		connect,
		disconnect,
		clearLogs,
	};
};

type LogViewerProps = {
	serviceId: string;
	class?: string;
};

export const LogViewer = (props: LogViewerProps) => {
	const { logs, isStreaming, isLoadingHistory, error, autoScroll, setAutoScroll, clearLogs } =
		useLogStream(() => props.serviceId);
	let logsEndRef: HTMLDivElement | undefined;

	createEffect(() => {
		if (autoScroll() && logsEndRef) {
			logsEndRef.scrollIntoView({ behavior: "smooth" });
		}
	});

	return (
		<div class={`flex flex-col ${props.class ?? ""}`}>
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2">
						<span class={`relative flex h-2 w-2 ${isStreaming() ? "animate-pulse" : ""}`}>
							<Show when={isStreaming()}>
								<span class="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />
							</Show>
							<span
								class={`relative inline-flex h-2 w-2 rounded-full ${isStreaming() ? "bg-green-500" : "bg-muted-foreground"}`}
							/>
						</span>
						<span class="text-sm text-muted-foreground">
							{isStreaming() ? "Streaming" : "Disconnected"}
						</span>
					</div>
					<Show when={isLoadingHistory()}>
						<span class="text-xs text-muted-foreground">(loading recent logs)</span>
					</Show>
					<Show when={error()}>
						<span class="text-xs text-yellow-600">({error()})</span>
					</Show>
				</div>
				<div class="flex items-center gap-2">
					<label class="flex items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							checked={autoScroll()}
							onChange={(e) => setAutoScroll(e.currentTarget.checked)}
							class="rounded border-input"
						/>
						Auto-scroll
					</label>
					<button
						type="button"
						onClick={clearLogs}
						class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-7 px-2"
					>
						Clear
					</button>
				</div>
			</div>
			<pre class="bg-zinc-900 text-zinc-100 border border-border rounded-lg p-4 overflow-auto text-xs font-mono min-h-[16rem] max-h-[32rem]">
				<Show when={logs().length === 0}>
					<span class="text-zinc-500">
						{isLoadingHistory() ? "Loading logs..." : "Waiting for logs..."}
					</span>
				</Show>
				{logs().map((line) => (
					<div class="whitespace-pre-wrap">{line}</div>
				))}
				<div ref={logsEndRef} />
			</pre>
		</div>
	);
};
