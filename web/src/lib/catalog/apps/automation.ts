import { adminPassword, db, dbPassword, env, postgres, volume, web } from "../helpers";
import type { Template } from "../types";

// automation apps
export const apps: Template[] = [
	{
		id: "n8n",
		name: "n8n",
		description: "Workflow automation with 400+ integrations and a visual editor.",
		category: "Automation",
		color: "#ea4b71",
		website: "https://n8n.io",
		version: "latest",
		web: true,
		variables: [
			{ id: "encryption_key", label: "Encryption key", generate: "secret", secret: true },
			{ id: "timezone", label: "Timezone", default: "UTC" },
		],
		services: (ctx) => [
			web(ctx, `docker.n8n.io/n8nio/n8n:${ctx.vars.version}`, 5678, {
				env_vars: env(
					{
						N8N_ENCRYPTION_KEY: ctx.vars.encryption_key,
						N8N_HOST: ctx.domain || undefined,
						N8N_PROTOCOL: ctx.domain ? "https" : undefined,
						// the generated plain-http url can't carry a secure cookie
						N8N_SECURE_COOKIE: ctx.domain ? undefined : "false",
						WEBHOOK_URL: ctx.url ? `${ctx.url}/` : undefined,
						GENERIC_TIMEZONE: ctx.vars.timezone,
						TZ: ctx.vars.timezone,
					},
					["N8N_ENCRYPTION_KEY"],
				),
				mounts: [volume(`${ctx.app}-data`, "/home/node/.n8n")],
			}),
		],
	},
	{
		id: "node-red",
		name: "Node-RED",
		description: "Low-code, flow-based programming for event-driven applications and IoT.",
		category: "Automation",
		color: "#8f0000",
		website: "https://nodered.org",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `nodered/node-red:${ctx.vars.version}`, 1880, {
				mounts: [volume(`${ctx.app}-data`, "/data")],
			}),
		],
		instructions: () =>
			"Node-RED has no login by default. Turn on HTTP basic auth under Networking.",
	},
	{
		id: "listmonk",
		name: "listmonk",
		description: "High-performance newsletter and mailing list manager.",
		category: "Automation",
		color: "#0055d4",
		website: "https://listmonk.app",
		version: "latest",
		web: true,
		variables: [
			{ id: "admin_user", label: "Admin username", default: "admin" },
			adminPassword(),
			dbPassword,
		],
		services: (ctx) => [
			web(ctx, `listmonk/listmonk:${ctx.vars.version}`, 9000, {
				command: [
					"sh",
					"-c",
					"./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''",
				],
				env_vars: env(
					{
						LISTMONK_app__address: "0.0.0.0:9000",
						LISTMONK_db__host: db(ctx),
						LISTMONK_db__port: "5432",
						LISTMONK_db__user: "listmonk",
						LISTMONK_db__password: ctx.vars.db_password,
						LISTMONK_db__database: "listmonk",
						LISTMONK_db__ssl_mode: "disable",
						LISTMONK_ADMIN_USER: ctx.vars.admin_user,
						LISTMONK_ADMIN_PASSWORD: ctx.vars.admin_password,
					},
					["LISTMONK_db__password", "LISTMONK_ADMIN_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-uploads`, "/listmonk/uploads")],
				depends_on: [db(ctx)],
			}),
			postgres(ctx, "listmonk", "listmonk"),
		],
	},
];
