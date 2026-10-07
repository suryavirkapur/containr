import { adminEmail, adminPassword, db, dbPassword, env, mysql, volume, web } from "../helpers";
import type { Template } from "../types";

// business apps
export const apps: Template[] = [
	{
		id: "nocodb",
		name: "NocoDB",
		description: "Turn any database into a smart spreadsheet. An open source Airtable alternative.",
		category: "Business",
		color: "#3366ff",
		website: "https://nocodb.com",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `nocodb/nocodb:${ctx.vars.version}`, 8080, {
				env_vars: env({ NC_PUBLIC_URL: ctx.url || undefined }),
				mounts: [volume(`${ctx.app}-data`, "/usr/app/data")],
			}),
		],
	},
	{
		id: "baserow",
		name: "Baserow",
		description: "No-code database and app builder.",
		category: "Business",
		color: "#5190ef",
		website: "https://baserow.io",
		version: "latest",
		web: true,
		needsDomain: true,
		services: (ctx) => [
			web(ctx, `baserow/baserow:${ctx.vars.version}`, 80, {
				env_vars: env({ BASEROW_PUBLIC_URL: ctx.url || "http://localhost" }),
				mounts: [volume(`${ctx.app}-data`, "/baserow/data")],
				memory_limit_mb: 2048,
			}),
		],
	},
	{
		id: "actual",
		name: "Actual Budget",
		description: "Local-first personal finance and envelope budgeting.",
		category: "Business",
		color: "#8719e0",
		website: "https://actualbudget.org",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `actualbudget/actual-server:${ctx.vars.version}`, 5006, {
				mounts: [volume(`${ctx.app}-data`, "/data")],
			}),
		],
	},
	{
		id: "invoice-ninja",
		name: "Invoice Ninja",
		description: "Invoicing, quotes, expenses and time tracking for freelancers and businesses.",
		category: "Business",
		color: "#000000",
		website: "https://invoiceninja.com",
		version: "5",
		web: true,
		variables: [
			adminEmail,
			adminPassword(),
			dbPassword,
			{ id: "app_key", label: "App key", generate: "laravel-key", secret: true },
		],
		services: (ctx) => [
			web(ctx, `invoiceninja/invoiceninja-debian:${ctx.vars.version}`, 80, {
				env_vars: env(
					{
						APP_URL: ctx.url || undefined,
						APP_KEY: ctx.vars.app_key,
						DB_HOST: db(ctx),
						DB_DATABASE: "ninja",
						DB_USERNAME: "ninja",
						DB_PASSWORD: ctx.vars.db_password,
						IN_USER_EMAIL: ctx.vars.admin_email,
						IN_PASSWORD: ctx.vars.admin_password,
						REQUIRE_HTTPS: ctx.domain ? "true" : "false",
						TRUSTED_PROXIES: "*",
					},
					["APP_KEY", "DB_PASSWORD", "IN_PASSWORD"],
				),
				mounts: [
					volume(`${ctx.app}-storage`, "/var/www/html/storage"),
					volume(`${ctx.app}-public`, "/var/www/html/public"),
				],
				depends_on: [db(ctx)],
			}),
			mysql(ctx, "ninja", "ninja"),
		],
	},
];
