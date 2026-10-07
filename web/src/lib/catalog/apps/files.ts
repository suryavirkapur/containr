import {
	adminPassword,
	db,
	dbPassword,
	env,
	mariadb,
	postgres,
	redis,
	volume,
	web,
} from "../helpers";
import type { Template } from "../types";

// files & productivity apps
export const apps: Template[] = [
	{
		id: "nextcloud",
		name: "Nextcloud",
		description: "Files, calendar, contacts and collaboration, all on your own server.",
		category: "Files & Productivity",
		color: "#0082c9",
		website: "https://nextcloud.com",
		version: "35-apache",
		web: true,
		needsDomain: true,
		variables: [
			{ id: "admin_user", label: "Admin username", default: "admin" },
			adminPassword(),
			dbPassword,
		],
		services: (ctx) => [
			web(ctx, `nextcloud:${ctx.vars.version}`, 80, {
				env_vars: env(
					{
						MYSQL_HOST: db(ctx),
						MYSQL_DATABASE: "nextcloud",
						MYSQL_USER: "nextcloud",
						MYSQL_PASSWORD: ctx.vars.db_password,
						NEXTCLOUD_ADMIN_USER: ctx.vars.admin_user,
						NEXTCLOUD_ADMIN_PASSWORD: ctx.vars.admin_password,
						NEXTCLOUD_TRUSTED_DOMAINS: ctx.domain || undefined,
						OVERWRITEPROTOCOL: ctx.domain ? "https" : undefined,
						TRUSTED_PROXIES: "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16",
					},
					["MYSQL_PASSWORD", "NEXTCLOUD_ADMIN_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-html`, "/var/www/html")],
				depends_on: [db(ctx)],
			}),
			mariadb(ctx, "nextcloud", "nextcloud"),
		],
	},
	{
		id: "vaultwarden",
		name: "Vaultwarden",
		description: "Lightweight Bitwarden-compatible password manager server.",
		category: "Files & Productivity",
		color: "#175ddc",
		website: "https://github.com/dani-garcia/vaultwarden",
		version: "latest",
		web: true,
		needsDomain: true,
		variables: [
			{ id: "admin_token", label: "Admin panel token", generate: "secret", secret: true },
		],
		services: (ctx) => [
			web(ctx, `vaultwarden/server:${ctx.vars.version}`, 80, {
				env_vars: env(
					{
						DOMAIN: ctx.url || undefined,
						ADMIN_TOKEN: ctx.vars.admin_token,
						SIGNUPS_ALLOWED: "true",
					},
					["ADMIN_TOKEN"],
				),
				mounts: [volume(`${ctx.app}-data`, "/data")],
			}),
		],
		instructions: (ctx) =>
			`Bitwarden clients require HTTPS. Manage the server at ${ctx.url || "<url>"}/admin.`,
	},
	{
		id: "paperless-ngx",
		name: "Paperless-ngx",
		description: "Scan, index and archive all your physical documents with OCR.",
		category: "Files & Productivity",
		color: "#17541f",
		website: "https://docs.paperless-ngx.com",
		version: "latest",
		web: true,
		variables: [
			{ id: "admin_user", label: "Admin username", default: "admin" },
			adminPassword(),
			dbPassword,
			{ id: "secret", label: "Secret key", generate: "secret", secret: true },
		],
		services: (ctx) => [
			web(ctx, `ghcr.io/paperless-ngx/paperless-ngx:${ctx.vars.version}`, 8000, {
				env_vars: env(
					{
						PAPERLESS_REDIS: `redis://${ctx.app}-redis:6379`,
						PAPERLESS_DBHOST: db(ctx),
						PAPERLESS_DBUSER: "paperless",
						PAPERLESS_DBPASS: ctx.vars.db_password,
						PAPERLESS_DBNAME: "paperless",
						PAPERLESS_SECRET_KEY: ctx.vars.secret,
						PAPERLESS_URL: ctx.url || undefined,
						PAPERLESS_ADMIN_USER: ctx.vars.admin_user,
						PAPERLESS_ADMIN_PASSWORD: ctx.vars.admin_password,
					},
					["PAPERLESS_DBPASS", "PAPERLESS_SECRET_KEY", "PAPERLESS_ADMIN_PASSWORD"],
				),
				mounts: [
					volume(`${ctx.app}-data`, "/usr/src/paperless/data"),
					volume(`${ctx.app}-media`, "/usr/src/paperless/media"),
				],
				depends_on: [db(ctx), `${ctx.app}-redis`],
			}),
			postgres(ctx, "paperless", "paperless"),
			redis(ctx),
		],
	},
	{
		id: "filebrowser",
		name: "File Browser",
		description: "Web file manager: upload, edit, share and organise files.",
		category: "Files & Productivity",
		color: "#40c4ff",
		website: "https://filebrowser.org",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `filebrowser/filebrowser:${ctx.vars.version}`, 80, {
				mounts: [volume(`${ctx.app}-files`, "/srv"), volume(`${ctx.app}-db`, "/database")],
			}),
		],
		instructions: () => "The initial admin password is printed in the service logs on first start.",
	},
	{
		id: "stirling-pdf",
		name: "Stirling PDF",
		description: "Merge, split, convert, sign and OCR PDFs locally in your browser.",
		category: "Files & Productivity",
		color: "#c02e24",
		website: "https://www.stirlingpdf.com",
		version: "latest",
		web: true,
		services: (ctx) => [web(ctx, `stirlingtools/stirling-pdf:${ctx.vars.version}`, 8080)],
	},
	{
		id: "excalidraw",
		name: "Excalidraw",
		description: "Virtual whiteboard for sketching hand-drawn-style diagrams.",
		category: "Files & Productivity",
		color: "#6965db",
		website: "https://excalidraw.com",
		version: "latest",
		web: true,
		services: (ctx) => [web(ctx, `excalidraw/excalidraw:${ctx.vars.version}`, 80)],
	},
	{
		id: "memos",
		name: "Memos",
		description: "Privacy-first, lightweight note-taking service.",
		category: "Files & Productivity",
		color: "#0f766e",
		website: "https://www.usememos.com",
		version: "stable",
		web: true,
		services: (ctx) => [
			web(ctx, `neosmemo/memos:${ctx.vars.version}`, 5230, {
				mounts: [volume(`${ctx.app}-data`, "/var/opt/memos")],
			}),
		],
	},
	{
		id: "linkding",
		name: "linkding",
		description: "Minimal, fast bookmark manager.",
		category: "Files & Productivity",
		color: "#5856e0",
		website: "https://linkding.link",
		version: "latest",
		web: true,
		variables: [{ id: "admin_user", label: "Admin username", default: "admin" }, adminPassword()],
		services: (ctx) => [
			web(ctx, `sissbruecker/linkding:${ctx.vars.version}`, 9090, {
				env_vars: env(
					{
						LD_SUPERUSER_NAME: ctx.vars.admin_user,
						LD_SUPERUSER_PASSWORD: ctx.vars.admin_password,
					},
					["LD_SUPERUSER_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-data`, "/etc/linkding/data")],
			}),
		],
	},
	{
		id: "mealie",
		name: "Mealie",
		description: "Recipe manager and meal planner with a clean UI.",
		category: "Files & Productivity",
		color: "#e58325",
		website: "https://mealie.io",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `ghcr.io/mealie-recipes/mealie:${ctx.vars.version}`, 9000, {
				env_vars: env({ BASE_URL: ctx.url || undefined, ALLOW_SIGNUP: "false" }),
				mounts: [volume(`${ctx.app}-data`, "/app/data")],
			}),
		],
	},
];
