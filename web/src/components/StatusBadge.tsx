import { type JSX, Show } from "solid-js";

type Status =
	| "running"
	| "success"
	| "failed"
	| "error"
	| "unstable"
	| "pending"
	| "starting"
	| "stopped"
	| "deploying"
	| "restarting";

type Props = {
	status: Status | string;
	showDot?: boolean;
};

const statusConfig: Record<string, { bg: string; text: string; border: string; dot: string }> = {
	running: {
		bg: "rgba(20,83,45,0.2)",
		text: "#86efac",
		border: "#14532d",
		dot: "#22c55e",
	},
	success: {
		bg: "rgba(20,83,45,0.2)",
		text: "#86efac",
		border: "#14532d",
		dot: "#22c55e",
	},
	failed: {
		bg: "rgba(127,29,29,0.2)",
		text: "#fca5a5",
		border: "#7f1d1d",
		dot: "#ef4444",
	},
	error: {
		bg: "rgba(127,29,29,0.2)",
		text: "#fca5a5",
		border: "#7f1d1d",
		dot: "#ef4444",
	},
	unstable: {
		bg: "rgba(120,53,15,0.28)",
		text: "#fdba74",
		border: "#9a3412",
		dot: "#f97316",
	},
	pending: {
		bg: "rgba(92,59,0,0.3)",
		text: "#fde68a",
		border: "#78350f",
		dot: "#f59e0b",
	},
	starting: {
		bg: "rgba(92,59,0,0.3)",
		text: "#fde68a",
		border: "#78350f",
		dot: "#f59e0b",
	},
	deploying: {
		bg: "rgba(30,58,138,0.3)",
		text: "#93c5fd",
		border: "#1e3a8a",
		dot: "#3b82f6",
	},
	restarting: {
		bg: "rgba(30,58,138,0.3)",
		text: "#93c5fd",
		border: "#1e3a8a",
		dot: "#3b82f6",
	},
	stopped: {
		bg: "rgba(38,38,38,0.5)",
		text: "#737373",
		border: "#262626",
		dot: "#525252",
	},
};

const defaultConfig = statusConfig.stopped;

const humanize = (s: string) => s.replace(/_/g, " ");

export const StatusBadge = (props: Props) => {
	const config = () => statusConfig[props.status] ?? defaultConfig;
	const shouldAnimate = () =>
		["deploying", "restarting", "starting", "pending", "unstable"].includes(props.status);

	return (
		<span
			class="cr-badge"
			style={{
				"background-color": config().bg,
				color: config().text,
				"border-color": config().border,
			}}
		>
			<Show when={props.showDot !== false}>
				<span class={`relative flex h-1.5 w-1.5 ${shouldAnimate() ? "animate-pulse" : ""}`}>
					<span
						class="relative inline-flex h-1.5 w-1.5"
						style={{ "background-color": config().dot }}
					/>
				</span>
			</Show>
			{humanize(props.status)}
		</span>
	);
};

export const StatusDot = (props: { status: Status | string }) => {
	const config = () => statusConfig[props.status] ?? defaultConfig;
	const shouldAnimate = () =>
		["deploying", "restarting", "starting", "pending", "unstable"].includes(props.status);

	return (
		<span class={`relative flex h-2 w-2 ${shouldAnimate() ? "animate-pulse" : ""}`}>
			<span class="relative inline-flex h-2 w-2" style={{ "background-color": config().dot }} />
		</span>
	);
};
