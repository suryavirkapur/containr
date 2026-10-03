export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

const TONES: Record<string, Tone> = {
	running: "success",
	healthy: "success",
	success: "success",
	partial: "warning",
	unstable: "warning",
	pending: "info",
	cloning: "info",
	building: "info",
	pushing: "info",
	starting: "info",
	deploying: "info",
	restarting: "info",
	failed: "danger",
	error: "danger",
	unhealthy: "danger",
	stopped: "neutral",
	exited: "neutral",
	unknown: "neutral",
};

export const toneFor = (status?: string | null): Tone =>
	TONES[(status ?? "").toLowerCase()] ?? "neutral";

export const isInProgress = (status?: string | null): boolean =>
	["pending", "cloning", "building", "pushing", "starting", "deploying", "restarting"].includes(
		(status ?? "").toLowerCase(),
	);

export const statusLabel = (status?: string | null): string => {
	if (!status) return "Unknown";
	const text = status.replace(/_/g, " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
};

export const toneColor: Record<Tone, string> = {
	success: "var(--success)",
	warning: "var(--warning)",
	danger: "var(--danger)",
	info: "var(--info)",
	accent: "var(--accent)",
	neutral: "var(--fg-faint)",
};
