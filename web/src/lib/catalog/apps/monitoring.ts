import { adminPassword, env, volume, web } from "../helpers";
import type { Template } from "../types";

// monitoring apps
export const apps: Template[] = [
	{
		id: "uptime-kuma",
		name: "Uptime Kuma",
		description: "Beautiful self-hosted uptime monitoring with status pages and alerts.",
		category: "Monitoring",
		color: "#5cdd8b",
		website: "https://uptime.kuma.pet",
		version: "2",
		web: true,
		services: (ctx) => [
			web(ctx, `louislam/uptime-kuma:${ctx.vars.version}`, 3001, {
				mounts: [volume(`${ctx.app}-data`, "/app/data")],
			}),
		],
	},
	{
		id: "grafana",
		name: "Grafana",
		description: "Dashboards and visualisations for metrics, logs and traces.",
		category: "Monitoring",
		color: "#f46800",
		website: "https://grafana.com",
		version: "latest",
		web: true,
		variables: [adminPassword()],
		services: (ctx) => [
			web(ctx, `grafana/grafana-oss:${ctx.vars.version}`, 3000, {
				env_vars: env(
					{
						GF_SECURITY_ADMIN_PASSWORD: ctx.vars.admin_password,
						GF_SERVER_ROOT_URL: ctx.url || undefined,
					},
					["GF_SECURITY_ADMIN_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-data`, "/var/lib/grafana")],
			}),
		],
		instructions: () => "Sign in as admin with the password you set.",
	},
	{
		id: "prometheus",
		name: "Prometheus",
		description: "Metrics collection and alerting toolkit with a powerful query language.",
		category: "Monitoring",
		color: "#e6522c",
		website: "https://prometheus.io",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `prom/prometheus:${ctx.vars.version}`, 9090, {
				mounts: [volume(`${ctx.app}-data`, "/prometheus")],
			}),
		],
		instructions: () =>
			"Prometheus has no login. Turn on HTTP basic auth under Networking before exposing it.",
	},
	{
		id: "gatus",
		name: "Gatus",
		description: "Developer-oriented health dashboard and status page driven by YAML.",
		category: "Monitoring",
		color: "#3b82f6",
		website: "https://gatus.io",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `twinproduction/gatus:${ctx.vars.version}`, 8080, {
				mounts: [volume(`${ctx.app}-config`, "/config")],
			}),
		],
	},
];
