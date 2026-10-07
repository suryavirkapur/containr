import { adminEmail, adminPassword, env, volume, web } from "../helpers";
import type { Template } from "../types";

// developer tools apps
export const apps: Template[] = [
	{
		id: "gitea",
		name: "Gitea",
		description: "Lightweight self-hosted Git service with issues, pull requests and CI.",
		category: "Developer tools",
		color: "#609926",
		website: "https://about.gitea.com",
		version: "28",
		web: true,
		services: (ctx) => [
			web(ctx, `gitea/gitea:${ctx.vars.version}`, 3000, {
				env_vars: env({
					USER_UID: "1000",
					USER_GID: "1000",
					GITEA__server__ROOT_URL: ctx.url ? `${ctx.url}/` : undefined,
					GITEA__server__DOMAIN: ctx.domain || undefined,
				}),
				mounts: [volume(`${ctx.app}-data`, "/data")],
			}),
		],
		instructions: () => "The first account you register becomes the administrator.",
	},
	{
		id: "forgejo",
		name: "Forgejo",
		description: "Community-driven Git forge, a soft fork of Gitea.",
		category: "Developer tools",
		color: "#fb923c",
		website: "https://forgejo.org",
		version: "16",
		web: true,
		services: (ctx) => [
			web(ctx, `codeberg.org/forgejo/forgejo:${ctx.vars.version}`, 3000, {
				env_vars: env({
					USER_UID: "1000",
					USER_GID: "1000",
					FORGEJO__server__ROOT_URL: ctx.url ? `${ctx.url}/` : undefined,
				}),
				mounts: [volume(`${ctx.app}-data`, "/data")],
			}),
		],
	},
	{
		id: "docker-registry",
		name: "Docker Registry",
		description: "Private container registry. Pair it with HTTP basic auth to push images.",
		category: "Developer tools",
		color: "#2496ed",
		website: "https://distribution.github.io/distribution/",
		version: "3",
		web: true,
		services: (ctx) => [
			web(ctx, `registry:${ctx.vars.version}`, 5000, {
				mounts: [volume(`${ctx.app}-data`, "/var/lib/registry")],
			}),
		],
		instructions: (ctx) =>
			`Enable HTTP basic auth under Networking, then: docker login ${ctx.domain || "<domain>"}`,
	},
	{
		id: "code-server",
		name: "code-server",
		description: "VS Code in the browser, running on your server.",
		category: "Developer tools",
		color: "#007acc",
		website: "https://coder.com/docs/code-server",
		version: "latest",
		web: true,
		variables: [adminPassword("Password")],
		services: (ctx) => [
			web(ctx, `lscr.io/linuxserver/code-server:${ctx.vars.version}`, 8443, {
				env_vars: env(
					{ PASSWORD: ctx.vars.admin_password, PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
					["PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-config`, "/config")],
			}),
		],
	},
	{
		id: "pgadmin",
		name: "pgAdmin",
		description: "The most popular administration and development platform for PostgreSQL.",
		category: "Developer tools",
		color: "#336791",
		website: "https://www.pgadmin.org",
		version: "latest",
		web: true,
		variables: [adminEmail, adminPassword()],
		services: (ctx) => [
			web(ctx, `dpage/pgadmin4:${ctx.vars.version}`, 80, {
				env_vars: env(
					{
						PGADMIN_DEFAULT_EMAIL: ctx.vars.admin_email,
						PGADMIN_DEFAULT_PASSWORD: ctx.vars.admin_password,
					},
					["PGADMIN_DEFAULT_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-data`, "/var/lib/pgadmin")],
			}),
		],
	},
	{
		id: "adminer",
		name: "Adminer",
		description: "Database management in a single PHP file: MySQL, PostgreSQL, SQLite and more.",
		category: "Developer tools",
		color: "#34567c",
		website: "https://www.adminer.org",
		version: "latest",
		web: true,
		services: (ctx) => [web(ctx, `adminer:${ctx.vars.version}`, 8080)],
		instructions: () => "Put Adminer in the same project as the database it should reach.",
	},
	{
		id: "phpmyadmin",
		name: "phpMyAdmin",
		description: "Web interface for MySQL and MariaDB administration.",
		category: "Developer tools",
		color: "#6c78af",
		website: "https://www.phpmyadmin.net",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `phpmyadmin:${ctx.vars.version}`, 80, { env_vars: env({ PMA_ARBITRARY: "1" }) }),
		],
	},
	{
		id: "it-tools",
		name: "IT Tools",
		description: "Handy online tools for developers: encoders, generators, converters and more.",
		category: "Developer tools",
		color: "#18a058",
		website: "https://it-tools.tech",
		version: "latest",
		web: true,
		services: (ctx) => [web(ctx, `corentinth/it-tools:${ctx.vars.version}`, 80)],
	},
];
