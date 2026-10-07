import {
	adminEmail,
	adminPassword,
	db,
	dbPassword,
	env,
	mariadb,
	mysql,
	postgres,
	volume,
	web,
} from "../helpers";
import type { Template } from "../types";

// cms & blogs apps
export const apps: Template[] = [
	{
		id: "wordpress",
		name: "WordPress",
		description: "The world's most popular CMS for blogs and websites, with a MariaDB database.",
		category: "CMS & Blogs",
		color: "#21759b",
		website: "https://wordpress.org",
		version: "6-apache",
		web: true,
		variables: [dbPassword],
		services: (ctx) => [
			web(ctx, `wordpress:${ctx.vars.version}`, 80, {
				env_vars: env(
					{
						WORDPRESS_DB_HOST: db(ctx),
						WORDPRESS_DB_USER: "wordpress",
						WORDPRESS_DB_PASSWORD: ctx.vars.db_password,
						WORDPRESS_DB_NAME: "wordpress",
					},
					["WORDPRESS_DB_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-html`, "/var/www/html")],
				depends_on: [db(ctx)],
			}),
			mariadb(ctx, "wordpress", "wordpress"),
		],
		instructions: (ctx) =>
			`Open ${ctx.url || "the service URL"} to finish the WordPress installer.`,
	},
	{
		id: "ghost",
		name: "Ghost",
		description: "Modern publishing platform for blogs, newsletters and paid memberships.",
		category: "CMS & Blogs",
		color: "#15171a",
		website: "https://ghost.org",
		version: "6-alpine",
		web: true,
		needsDomain: true,
		variables: [dbPassword],
		services: (ctx) => [
			web(ctx, `ghost:${ctx.vars.version}`, 2368, {
				env_vars: env(
					{
						url: ctx.url || "http://localhost:2368",
						database__client: "mysql",
						database__connection__host: db(ctx),
						database__connection__user: "ghost",
						database__connection__password: ctx.vars.db_password,
						database__connection__database: "ghost",
					},
					["database__connection__password"],
				),
				mounts: [volume(`${ctx.app}-content`, "/var/lib/ghost/content")],
				depends_on: [db(ctx)],
			}),
			mysql(ctx, "ghost", "ghost"),
		],
		instructions: (ctx) => `Create your admin account at ${ctx.url || "<url>"}/ghost.`,
	},
	{
		id: "directus",
		name: "Directus",
		description: "Instant REST and GraphQL API plus a no-code admin app on top of PostgreSQL.",
		category: "CMS & Blogs",
		color: "#6644ff",
		website: "https://directus.io",
		version: "11",
		web: true,
		variables: [
			adminEmail,
			adminPassword(),
			dbPassword,
			{ id: "secret", label: "Secret key", generate: "secret", secret: true },
		],
		services: (ctx) => [
			web(ctx, `directus/directus:${ctx.vars.version}`, 8055, {
				env_vars: env(
					{
						SECRET: ctx.vars.secret,
						ADMIN_EMAIL: ctx.vars.admin_email,
						ADMIN_PASSWORD: ctx.vars.admin_password,
						DB_CLIENT: "pg",
						DB_HOST: db(ctx),
						DB_PORT: "5432",
						DB_DATABASE: "directus",
						DB_USER: "directus",
						DB_PASSWORD: ctx.vars.db_password,
						PUBLIC_URL: ctx.url || undefined,
					},
					["SECRET", "ADMIN_PASSWORD", "DB_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-uploads`, "/directus/uploads")],
				depends_on: [db(ctx)],
			}),
			postgres(ctx, "directus", "directus"),
		],
	},
	{
		id: "wikijs",
		name: "Wiki.js",
		description: "Powerful and extensible open source wiki with a Markdown editor.",
		category: "CMS & Blogs",
		color: "#1976d2",
		website: "https://js.wiki",
		version: "2",
		web: true,
		variables: [dbPassword],
		services: (ctx) => [
			web(ctx, `ghcr.io/requarks/wiki:${ctx.vars.version}`, 3000, {
				env_vars: env(
					{
						DB_TYPE: "postgres",
						DB_HOST: db(ctx),
						DB_PORT: "5432",
						DB_USER: "wiki",
						DB_PASS: ctx.vars.db_password,
						DB_NAME: "wiki",
					},
					["DB_PASS"],
				),
				depends_on: [db(ctx)],
			}),
			postgres(ctx, "wiki", "wiki"),
		],
	},
	{
		id: "bookstack",
		name: "BookStack",
		description: "Simple, self-hosted platform for organising and storing documentation.",
		category: "CMS & Blogs",
		color: "#0288d1",
		website: "https://www.bookstackapp.com",
		version: "latest",
		web: true,
		variables: [
			dbPassword,
			{ id: "app_key", label: "App key", generate: "laravel-key", secret: true },
		],
		services: (ctx) => [
			web(ctx, `lscr.io/linuxserver/bookstack:${ctx.vars.version}`, 80, {
				env_vars: env(
					{
						APP_URL: ctx.url || undefined,
						APP_KEY: ctx.vars.app_key,
						DB_HOST: db(ctx),
						DB_PORT: "3306",
						DB_USERNAME: "bookstack",
						DB_PASSWORD: ctx.vars.db_password,
						DB_DATABASE: "bookstack",
						PUID: "1000",
						PGID: "1000",
					},
					["APP_KEY", "DB_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-config`, "/config")],
				depends_on: [db(ctx)],
			}),
			mariadb(ctx, "bookstack", "bookstack"),
		],
		instructions: () =>
			"Sign in with admin@admin.com / password, then change the credentials right away.",
	},
];
