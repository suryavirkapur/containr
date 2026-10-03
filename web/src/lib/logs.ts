import { createEffect, createSignal, onCleanup } from "solid-js";
import { getServiceLogs } from "../api/services";

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");
const MAX_LINES = 5000;
const MAX_RECONNECTS = 6;

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

const wsUrl = (path: string, params: Record<string, string> = {}) => {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const query = new URLSearchParams(params);
	const token = localStorage.getItem("containr_token");
	if (token) query.set("token", token);
	return `${protocol}//${window.location.host}${path}?${query.toString()}`;
};

const cap = (lines: string[]) =>
	lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;

export type LogStream = {
	lines: () => string[];
	connected: () => boolean;
	loading: () => boolean;
	error: () => string | null;
	paused: () => boolean;
	setPaused: (value: boolean) => void;
	clear: () => void;
	reconnect: () => void;
};

/** runtime container logs: loads recent history then follows the websocket */
export const useServiceLogStream = (
	serviceId: () => string | null,
	enabled: () => boolean,
): LogStream => {
	const [lines, setLines] = createSignal<string[]>([]);
	const [connected, setConnected] = createSignal(false);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [paused, setPaused] = createSignal(false);
	let socket: WebSocket | null = null;
	let retry: ReturnType<typeof setTimeout> | null = null;
	let attempts = 0;
	let buffer: string[] = [];

	const close = () => {
		if (retry) clearTimeout(retry);
		retry = null;
		const current = socket;
		socket = null;
		current?.close();
		setConnected(false);
	};

	const append = (incoming: string[]) => {
		if (paused()) {
			buffer.push(...incoming);
			return;
		}
		setLines((previous) => cap([...previous, ...incoming]));
	};

	const open = (id: string) => {
		close();
		const ws = new WebSocket(
			wsUrl(`/api/services/${encodeURIComponent(id)}/logs/ws`, { tail: "0" }),
		);
		socket = ws;
		ws.onopen = () => {
			if (socket !== ws) return;
			attempts = 0;
			setConnected(true);
			setError(null);
		};
		ws.onmessage = (event: MessageEvent<string>) => {
			if (socket !== ws) return;
			const incoming = String(event.data)
				.split("\n")
				.map((line) => stripAnsi(line).trimEnd())
				.filter(
					(line) =>
						line && !line.startsWith("[connected to") && !line.startsWith("[error reading logs"),
				);
			if (incoming.length) append(incoming);
		};
		ws.onclose = () => {
			if (socket !== ws) return;
			socket = null;
			setConnected(false);
			if (!enabled() || attempts >= MAX_RECONNECTS) {
				if (attempts >= MAX_RECONNECTS) setError("Lost connection to the log stream");
				return;
			}
			attempts += 1;
			retry = setTimeout(() => open(id), Math.min(10000, 1000 * 2 ** attempts));
		};
	};

	const start = async (id: string) => {
		setLoading(true);
		setError(null);
		try {
			const history = await getServiceLogs(id, 500);
			setLines(
				cap(
					(history ?? "")
						.split("\n")
						.map((line) => stripAnsi(line).trimEnd())
						.filter(Boolean),
				),
			);
		} catch {
			setError("Could not load recent logs");
		} finally {
			setLoading(false);
		}
		open(id);
	};

	createEffect(() => {
		const id = serviceId();
		if (!id || !enabled()) {
			close();
			return;
		}
		attempts = 0;
		void start(id);
	});

	createEffect(() => {
		if (!paused() && buffer.length) {
			const flushed = buffer;
			buffer = [];
			setLines((previous) => cap([...previous, ...flushed]));
		}
	});

	onCleanup(close);

	return {
		lines,
		connected,
		loading,
		error,
		paused,
		setPaused,
		clear: () => setLines([]),
		reconnect: () => {
			const id = serviceId();
			attempts = 0;
			if (id) void start(id);
		},
	};
};

/** build/deploy logs for one deployment (the socket replays history first) */
export const useDeploymentLogStream = (
	serviceId: () => string | null,
	deploymentId: () => string | null,
): LogStream => {
	const [lines, setLines] = createSignal<string[]>([]);
	const [connected, setConnected] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [paused, setPaused] = createSignal(false);
	let socket: WebSocket | null = null;

	const close = () => {
		const current = socket;
		socket = null;
		current?.close();
		setConnected(false);
	};

	const open = () => {
		const id = serviceId();
		const deployment = deploymentId();
		close();
		setLines([]);
		setError(null);
		if (!id || !deployment) return;
		const ws = new WebSocket(
			wsUrl(
				`/api/services/${encodeURIComponent(id)}/deployments/${encodeURIComponent(deployment)}/logs/ws`,
			),
		);
		socket = ws;
		ws.onopen = () => {
			if (socket === ws) setConnected(true);
		};
		ws.onmessage = (event: MessageEvent<string>) => {
			if (socket !== ws || paused()) return;
			const incoming = String(event.data)
				.split("\n")
				.map((line) => stripAnsi(line).trimEnd())
				.filter(Boolean);
			if (incoming.length) setLines((previous) => cap([...previous, ...incoming]));
		};
		ws.onerror = () => {
			if (socket === ws) setError("Could not stream build logs");
		};
		ws.onclose = () => {
			if (socket !== ws) return;
			socket = null;
			setConnected(false);
		};
	};

	createEffect(open);
	onCleanup(close);

	return {
		lines,
		connected,
		loading: () => false,
		error,
		paused,
		setPaused,
		clear: () => setLines([]),
		reconnect: open,
	};
};
