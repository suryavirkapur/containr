import { db, dbPassword, env, mariadb, postgres, volume, web } from "../helpers";
import type { Template } from "../types";

// analytics apps
export const apps: Template[] = [
	{
		id: "umami",
		name: "Umami",
		description: "Simple, fast, privacy-focused alternative to Google Analytics.",
		category: "Analytics",
		color: "#111111",
		website: "https://umami.is",
		version: "postgresql-latest",
		web: true,
		variables: [
			dbPassword,
			{ id: "app_secret", label: "App secret", generate: "secret", secret: true },
		],
		services: (ctx) => [
			web(ctx, `ghcr.io/umami-software/umami:${ctx.vars.version}`, 3000, {
				env_vars: env(
					{
						DATABASE_URL: `postgresql://umami:${ctx.vars.db_password}@${db(ctx)}:5432/umami`,
						DATABASE_TYPE: "postgresql",
						APP_SECRET: ctx.vars.app_secret,
					},
					["DATABASE_URL", "APP_SECRET"],
				),
				depends_on: [db(ctx)],
			}),
			postgres(ctx, "umami", "umami"),
		],
		instructions: () => "Default login is admin / umami. Change it in Settings → Profile.",
	},
	{
		id: "metabase",
		name: "Metabase",
		description: "Business intelligence: ask questions about your data and share dashboards.",
		category: "Analytics",
		color: "#509ee3",
		website: "https://www.metabase.com",
		version: "latest",
		web: true,
		variables: [dbPassword],
		services: (ctx) => [
			web(ctx, `metabase/metabase:${ctx.vars.version}`, 3000, {
				env_vars: env(
					{
						MB_DB_TYPE: "postgres",
						MB_DB_DBNAME: "metabase",
						MB_DB_PORT: "5432",
						MB_DB_USER: "metabase",
						MB_DB_PASS: ctx.vars.db_password,
						MB_DB_HOST: db(ctx),
						MB_SITE_URL: ctx.url || undefined,
					},
					["MB_DB_PASS"],
				),
				depends_on: [db(ctx)],
				memory_limit_mb: 2048,
			}),
			postgres(ctx, "metabase", "metabase"),
		],
	},
	{
		id: "matomo",
		name: "Matomo",
		description: "Full-featured web analytics platform that keeps you in control of your data.",
		category: "Analytics",
		color: "#3152a0",
		website: "https://matomo.org",
		version: "5-apache",
		web: true,
		variables: [dbPassword],
		services: (ctx) => [
			web(ctx, `matomo:${ctx.vars.version}`, 80, {
				env_vars: env(
					{
						MATOMO_DATABASE_HOST: db(ctx),
						MATOMO_DATABASE_USERNAME: "matomo",
						MATOMO_DATABASE_PASSWORD: ctx.vars.db_password,
						MATOMO_DATABASE_DBNAME: "matomo",
					},
					["MATOMO_DATABASE_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-html`, "/var/www/html")],
				depends_on: [db(ctx)],
			}),
			mariadb(ctx, "matomo", "matomo"),
		],
	},
];
