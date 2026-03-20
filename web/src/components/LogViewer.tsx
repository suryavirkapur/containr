import { createEffect, createSignal, onCleanup, Show } from "solid-js";

export const useLogStream = (
	serviceId: () => string,
	autoConnect = true,
	onLog?: (line: string) => void,
) => {
	const [logs, setLogs] = createSignal<string[]>([]);
	const [isStreaming, setIsStreaming] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [autoScroll, setAutoScroll] = createSignal(true);
	let ws: WebSocket | null = null;
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	const buildWsUrl = () => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = window.location.host;
		return `${protocol}//${host}/api/services/${serviceId()}/logs/ws`;
	};

	const connect = () => {
		if (!serviceId()) return;
		setIsStreaming(true);
		setError(null);

		try {
			ws = new WebSocket(buildWsUrl());

			ws.onopen = () => {
				setIsStreaming(true);
				setError(null);
			};

			ws.onmessage = (event: MessageEvent<string>) => {
				const lines: string[] = event.data.split("\n").filter(Boolean);
				setLogs((prev) => [...prev, ...lines]);
				lines.forEach((line: string) => {
					onLog?.(line);
				});
			};

			ws.onerror = () => {
				setError("WebSocket connection failed, falling back to polling");
				setIsStreaming(false);
				startPolling();
			};

			ws.onclose = () => {
				setIsStreaming(false);
				ws = null;
			};
		} catch {
			setError("Failed to connect, using polling");
			startPolling();
		}
	};

	const startPolling = () => {
		if (pollInterval) return;
		pollInterval = setInterval(async () => {
			try {
				const token = localStorage.getItem("containr_token");
				const response = await fetch(`/api/services/${serviceId()}/logs?tail=50`, {
					headers: token ? { Authorization: `Bearer ${token}` } : undefined,
				});
				if (response.ok) {
					const data: { logs?: string } = await response.json();
					const newLogs: string[] = (data.logs || "").split("\n").filter(Boolean);
					if (newLogs.length > 0) {
						setLogs((prev) => {
							const seen = new Set(prev);
							const appended = newLogs.filter((line: string) => !seen.has(line));
							if (appended.length === 0) return prev;
							return [...prev, ...appended];
						});
					}
				}
			} catch {
				// Silently fail polling
			}
		}, 3000);
	};

	const disconnect = () => {
		ws?.close();
		ws = null;
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
		setIsStreaming(false);
	};

	const clearLogs = () => setLogs([]);

	createEffect(() => {
		if (autoConnect && serviceId()) {
			connect();
		}
	});

	onCleanup(() => {
		disconnect();
	});

	return {
		logs,
		isStreaming,
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
	const { logs, isStreaming, error, autoScroll, setAutoScroll, clearLogs } = useLogStream(
		() => props.serviceId,
	);
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
							{isStreaming() ? "Streaming" : "Polling"}
						</span>
					</div>
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
					<span class="text-zinc-500">Waiting for logs...</span>
				</Show>
				{logs().map((line) => (
					<div class="whitespace-pre-wrap">{line}</div>
				))}
				<div ref={logsEndRef} />
			</pre>
		</div>
	);
};
