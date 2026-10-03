export const formatBytes = (bytes?: number | null, digits = 1): string => {
	if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let index = 0;
	let value = bytes;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value.toFixed(index === 0 || value >= 100 ? 0 : digits)} ${units[index]}`;
};

export const formatPercent = (value?: number | null, digits = 1): string => {
	if (value === undefined || value === null || !Number.isFinite(value)) return "–";
	return `${value.toFixed(digits)}%`;
};

export const formatNumber = (value?: number | null): string =>
	value === undefined || value === null ? "–" : new Intl.NumberFormat().format(value);

export const formatUptime = (seconds?: number | null): string => {
	if (!seconds || seconds < 0) return "–";
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	if (mins > 0) return `${mins}m`;
	return `${Math.floor(seconds)}s`;
};

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export const timeAgo = (value?: string | null): string => {
	if (!value) return "–";
	const date = new Date(value);
	const ms = date.getTime();
	if (Number.isNaN(ms)) return value;
	const diff = (ms - Date.now()) / 1000;
	const abs = Math.abs(diff);
	if (abs < 45) return "just now";
	if (abs < 3600) return relative.format(Math.round(diff / 60), "minute");
	if (abs < 86400) return relative.format(Math.round(diff / 3600), "hour");
	if (abs < 86400 * 30) return relative.format(Math.round(diff / 86400), "day");
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export const formatDateTime = (value?: string | null): string => {
	if (!value) return "–";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
};

export const formatDuration = (start?: string | null, end?: string | null): string => {
	if (!start) return "–";
	const from = new Date(start).getTime();
	const to = end ? new Date(end).getTime() : Date.now();
	if (Number.isNaN(from) || Number.isNaN(to)) return "–";
	const secs = Math.max(0, Math.round((to - from) / 1000));
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ${secs % 60}s`;
	return `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

export const shortId = (value?: string | null, length = 7): string =>
	value ? value.replace(/^sha256:/, "").slice(0, length) : "–";

export const pluralize = (count: number, singular: string, plural = `${singular}s`) =>
	`${count} ${count === 1 ? singular : plural}`;

export const slugify = (value: string): string =>
	value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 63);

export const randomSecret = (length = 24): string => {
	const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
};

export const copyToClipboard = async (value: string): Promise<boolean> => {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		return false;
	}
};
