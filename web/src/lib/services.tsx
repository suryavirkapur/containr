import Box from "lucide-solid/icons/box";
import Clock from "lucide-solid/icons/clock";
import Cog from "lucide-solid/icons/cog";
import Database from "lucide-solid/icons/database";
import Globe from "lucide-solid/icons/globe";
import Layers from "lucide-solid/icons/layers";
import Lock from "lucide-solid/icons/lock";
import MessagesSquare from "lucide-solid/icons/messages-square";
import Zap from "lucide-solid/icons/zap";
import type { JSX } from "solid-js";
import type { Service } from "../api/services";

export const TYPE_LABELS: Record<string, string> = {
	web_service: "Web service",
	private_service: "Private service",
	background_worker: "Worker",
	cron_job: "Cron job",
	postgres: "PostgreSQL",
	postgresql: "PostgreSQL",
	redis: "Redis",
	mariadb: "MariaDB",
	qdrant: "Qdrant",
	rabbitmq: "RabbitMQ",
};

export const typeLabel = (type?: string | null) =>
	TYPE_LABELS[(type ?? "").toLowerCase()] ?? (type ? type.replace(/_/g, " ") : "Service");

export const isManaged = (service: Pick<Service, "resource_kind">) =>
	service.resource_kind !== "app_service";

export const isAppService = (service: Pick<Service, "resource_kind">) =>
	service.resource_kind === "app_service";

/** colour + glyph used for a service type across the ui */
export const typeVisual = (type?: string | null): { icon: () => JSX.Element; color: string } => {
	switch ((type ?? "").toLowerCase()) {
		case "web_service":
			return { icon: () => <Globe />, color: "#6d6afe" };
		case "private_service":
			return { icon: () => <Lock />, color: "#0ea5e9" };
		case "background_worker":
			return { icon: () => <Cog />, color: "#a855f7" };
		case "cron_job":
			return { icon: () => <Clock />, color: "#f59e0b" };
		case "postgres":
		case "postgresql":
			return { icon: () => <Database />, color: "#3b82f6" };
		case "mariadb":
			return { icon: () => <Database />, color: "#14b8a6" };
		case "redis":
			return { icon: () => <Zap />, color: "#ef4444" };
		case "qdrant":
			return { icon: () => <Layers />, color: "#ec4899" };
		case "rabbitmq":
			return { icon: () => <MessagesSquare />, color: "#f97316" };
		default:
			return { icon: () => <Box />, color: "#71717a" };
	}
};

export const ServiceIcon = (props: { type?: string | null; size?: "sm" | "md" | "lg" }) => {
	const visual = () => typeVisual(props.type);
	const box = () =>
		props.size === "lg"
			? "h-10 w-10 [&>svg]:h-5 [&>svg]:w-5"
			: props.size === "sm"
				? "h-6 w-6 [&>svg]:h-3.5 [&>svg]:w-3.5"
				: "h-8 w-8 [&>svg]:h-4 [&>svg]:w-4";
	return (
		<span
			class={`inline-flex shrink-0 items-center justify-center rounded-md ${box()}`}
			style={{
				color: visual().color,
				background: `color-mix(in srgb, ${visual().color} 14%, transparent)`,
				"box-shadow": `inset 0 0 0 1px color-mix(in srgb, ${visual().color} 22%, transparent)`,
			}}
		>
			{visual().icon()}
		</span>
	);
};

/** best public url for a service, preferring custom domains */
export const primaryUrl = (service: Service): string | null => {
	const domain = service.domains[0];
	if (domain) {
		const httpOnly = service.http_only_domains.includes(domain);
		return `${httpOnly ? "http" : "https"}://${domain}`;
	}
	return service.default_urls[0] ?? null;
};

/**
 * host:port addresses the server publishes for this service outside http,
 * e.g. a database reachable from the internet on 203.0.113.4:5050
 */
export const publicPorts = (service: Service): string[] => {
	const host = service.public_ip || window.location.hostname;
	const ports = service.port_mappings.map(
		(mapping) => `${host}:${mapping.host_port}${mapping.protocol === "udp" ? "/udp" : ""}`,
	);
	for (const port of [service.external_port, service.proxy_external_port])
		if (port) ports.push(`${host}:${port}`);
	return [...new Set(ports)];
};

export const displayHost = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export const instancesLabel = (service: Service) =>
	`${service.running_instances}/${service.desired_instances}`;
