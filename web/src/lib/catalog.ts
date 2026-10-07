import type { EnvVarInput, ServiceInput } from "../api/platform";
import { randomSecret } from "./format";

// one-click app catalog. each template expands user answers into a stack of
// image-based services that share a project network and reach each other by
// service name.

export type TemplateVariable = {
	id: string;
	label: string;
	description?: string;
	default?: string | ((ctx: TemplateContext) => string);
	/** generated when the form opens; still editable */
	generate?: "password" | "secret" | "hex64" | "laravel-key";
	secret?: boolean;
	required?: boolean;
	placeholder?: string;
};

export type TemplateContext = {
	/** project/app name chosen by the user (lowercase, dns-safe) */
	app: string;
	/** public domain for the main service, may be empty */
	domain: string;
	/** https://domain or empty */
	url: string;
	vars: Record<string, string>;
};

export type Template = {
	id: string;
	name: string;
	description: string;
	category: Category;
	color: string;
	website: string;
	/** default docker image tag users can override */
	version?: string;
	variables?: TemplateVariable[];
	services: (ctx: TemplateContext) => ServiceInput[];
	/** shown after deploy */
	instructions?: (ctx: TemplateContext) => string;
	/** main service needs a public domain */
	web?: boolean;
	/** app only works behind its own domain, so the domain field is required */
	needsDomain?: boolean;
	tags?: string[];
};

export type Category =
	| "CMS & Blogs"
	| "Analytics"
	| "Automation"
	| "Monitoring"
	| "Developer tools"
	| "Databases"
	| "Files & Productivity"
	| "Media"
	| "AI"
	| "Business"
	| "Other";

export const CATEGORIES: Category[] = [
	"CMS & Blogs",
	"Analytics",
	"Automation",
	"Monitoring",
	"Developer tools",
	"Databases",
	"Files & Productivity",
	"Business",
	"Media",
	"AI",
	"Other",
];

const env = (
	values: Record<string, string | undefined>,
	secretKeys: string[] = [],
): EnvVarInput[] =>
	Object.entries(values)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => ({ key, value: value ?? "", secret: secretKeys.includes(key) }));

const web = (
	ctx: TemplateContext,
	image: string,
	port: number,
	extra: Partial<ServiceInput> = {},
): ServiceInput => ({
	name: ctx.app,
	image,
	service_type: "web_service",
	port,
	expose_http: true,
	domains: ctx.domain ? [ctx.domain] : [],
	restart_policy: "always",
	...extra,
});

const internal = (
	name: string,
	image: string,
	port: number,
	extra: Partial<ServiceInput> = {},
): ServiceInput => ({
	name,
	image,
	service_type: "private_service",
	port,
	expose_http: false,
	restart_policy: "always",
	...extra,
});

const volume = (name: string, target: string) => ({ name, target });

const dbPassword: TemplateVariable = {
	id: "db_password",
	label: "Database password",
	generate: "password",
	secret: true,
};

const adminPassword = (label = "Admin password"): TemplateVariable => ({
	id: "admin_password",
	label,
	generate: "password",
	secret: true,
});

const adminEmail: TemplateVariable = {
	id: "admin_email",
	label: "Admin email",
	placeholder: "you@example.com",
	required: true,
};

const mariadb = (ctx: TemplateContext, database: string, user: string, version = "11") =>
	internal(`${ctx.app}-db`, `mariadb:${version}`, 3306, {
		env_vars: env(
			{
				MARIADB_DATABASE: database,
				MARIADB_USER: user,
				MARIADB_PASSWORD: ctx.vars.db_password,
				MARIADB_ROOT_PASSWORD: ctx.vars.db_root_password || ctx.vars.db_password,
			},
			["MARIADB_PASSWORD", "MARIADB_ROOT_PASSWORD"],
		),
		mounts: [volume(`${ctx.app}-db-data`, "/var/lib/mysql")],
	});

const mysql = (ctx: TemplateContext, database: string, user: string, version = "8.4") =>
	internal(`${ctx.app}-db`, `mysql:${version}`, 3306, {
		env_vars: env(
			{
				MYSQL_DATABASE: database,
				MYSQL_USER: user,
				MYSQL_PASSWORD: ctx.vars.db_password,
				MYSQL_ROOT_PASSWORD: ctx.vars.db_password,
			},
			["MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD"],
		),
		mounts: [volume(`${ctx.app}-db-data`, "/var/lib/mysql")],
	});

const postgres = (ctx: TemplateContext, database: string, user: string, version = "16-alpine") =>
	internal(`${ctx.app}-db`, `postgres:${version}`, 5432, {
		env_vars: env(
			{ POSTGRES_DB: database, POSTGRES_USER: user, POSTGRES_PASSWORD: ctx.vars.db_password },
			["POSTGRES_PASSWORD"],
		),
		mounts: [volume(`${ctx.app}-db-data`, "/var/lib/postgresql/data")],
	});

const redis = (ctx: TemplateContext) =>
	internal(`${ctx.app}-redis`, "redis:7-alpine", 6379, {
		mounts: [volume(`${ctx.app}-redis-data`, "/data")],
	});

const db = (ctx: TemplateContext) => `${ctx.app}-db`;

export const TEMPLATES: Template[] = [
	// ---- cms & blogs ----------------------------------------------------
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

	// ---- analytics -------------------------------------------------------
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

	// ---- automation ------------------------------------------------------
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

	// ---- monitoring ------------------------------------------------------
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

	// ---- developer tools -------------------------------------------------
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

	// ---- databases -------------------------------------------------------
	{
		id: "mongodb",
		name: "MongoDB",
		description: "Document database for modern applications.",
		category: "Databases",
		color: "#47a248",
		website: "https://www.mongodb.com",
		version: "7",
		variables: [
			{ id: "root_user", label: "Root username", default: "admin" },
			{ ...dbPassword, label: "Root password" },
		],
		services: (ctx) => [
			internal(ctx.app, `mongo:${ctx.vars.version}`, 27017, {
				env_vars: env(
					{
						MONGO_INITDB_ROOT_USERNAME: ctx.vars.root_user,
						MONGO_INITDB_ROOT_PASSWORD: ctx.vars.db_password,
					},
					["MONGO_INITDB_ROOT_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-data`, "/data/db")],
			}),
		],
		instructions: (ctx) =>
			`Connect from the same project with mongodb://${ctx.vars.root_user}:<password>@${ctx.app}:27017`,
	},
	{
		id: "mysql",
		name: "MySQL",
		description: "The classic open source relational database.",
		category: "Databases",
		color: "#4479a1",
		website: "https://www.mysql.com",
		version: "8.4",
		variables: [
			{ id: "database", label: "Database name", default: "app" },
			{ ...dbPassword, label: "Root password" },
		],
		services: (ctx) => [
			internal(ctx.app, `mysql:${ctx.vars.version}`, 3306, {
				env_vars: env(
					{ MYSQL_ROOT_PASSWORD: ctx.vars.db_password, MYSQL_DATABASE: ctx.vars.database },
					["MYSQL_ROOT_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-data`, "/var/lib/mysql")],
			}),
		],
	},
	{
		id: "meilisearch",
		name: "Meilisearch",
		description: "Lightning-fast, typo-tolerant search engine with a simple API.",
		category: "Databases",
		color: "#ff5caa",
		website: "https://www.meilisearch.com",
		version: "v1",
		web: true,
		variables: [{ id: "master_key", label: "Master key", generate: "secret", secret: true }],
		services: (ctx) => [
			web(ctx, `getmeili/meilisearch:${ctx.vars.version}`, 7700, {
				env_vars: env({ MEILI_MASTER_KEY: ctx.vars.master_key, MEILI_ENV: "production" }, [
					"MEILI_MASTER_KEY",
				]),
				mounts: [volume(`${ctx.app}-data`, "/meili_data")],
			}),
		],
	},
	{
		id: "rustfs",
		name: "RustFS",
		description: "S3-compatible object storage with a web console, a drop-in MinIO alternative.",
		category: "Databases",
		color: "#e2532d",
		website: "https://rustfs.com",
		version: "latest",
		web: true,
		tags: ["minio", "s3", "object storage"],
		variables: [
			{ id: "root_user", label: "Access key", default: "rustfsadmin" },
			adminPassword("Secret key"),
		],
		services: (ctx) => [
			web(ctx, `rustfs/rustfs:${ctx.vars.version}`, 9001, {
				additional_ports: [9000],
				env_vars: env(
					{
						RUSTFS_ACCESS_KEY: ctx.vars.root_user,
						RUSTFS_SECRET_KEY: ctx.vars.admin_password,
						RUSTFS_ADDRESS: ":9000",
						RUSTFS_CONSOLE_ADDRESS: ":9001",
						RUSTFS_CONSOLE_ENABLE: "true",
					},
					["RUSTFS_SECRET_KEY"],
				),
				mounts: [volume(`${ctx.app}-data`, "/data")],
			}),
		],
		instructions: (ctx) =>
			`Sign in to the console with your access and secret key. The S3 API listens on ${ctx.app}:9000 inside the project network.`,
	},
	{
		id: "couchdb",
		name: "CouchDB",
		description: "Seamless multi-master syncing database with an intuitive HTTP/JSON API.",
		category: "Databases",
		color: "#e42528",
		website: "https://couchdb.apache.org",
		version: "3",
		web: true,
		variables: [{ id: "admin_user", label: "Admin user", default: "admin" }, adminPassword()],
		services: (ctx) => [
			web(ctx, `couchdb:${ctx.vars.version}`, 5984, {
				env_vars: env(
					{ COUCHDB_USER: ctx.vars.admin_user, COUCHDB_PASSWORD: ctx.vars.admin_password },
					["COUCHDB_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-data`, "/opt/couchdb/data")],
			}),
		],
	},
	{
		id: "influxdb",
		name: "InfluxDB",
		description: "Time series database for metrics, events and real-time analytics.",
		category: "Databases",
		color: "#22adf6",
		website: "https://www.influxdata.com",
		version: "2",
		web: true,
		variables: [
			{ id: "admin_user", label: "Admin user", default: "admin" },
			adminPassword(),
			{ id: "org", label: "Organisation", default: "main" },
			{ id: "bucket", label: "Initial bucket", default: "default" },
		],
		services: (ctx) => [
			web(ctx, `influxdb:${ctx.vars.version}`, 8086, {
				env_vars: env(
					{
						DOCKER_INFLUXDB_INIT_MODE: "setup",
						DOCKER_INFLUXDB_INIT_USERNAME: ctx.vars.admin_user,
						DOCKER_INFLUXDB_INIT_PASSWORD: ctx.vars.admin_password,
						DOCKER_INFLUXDB_INIT_ORG: ctx.vars.org,
						DOCKER_INFLUXDB_INIT_BUCKET: ctx.vars.bucket,
					},
					["DOCKER_INFLUXDB_INIT_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-data`, "/var/lib/influxdb2")],
			}),
		],
	},

	// ---- files & productivity --------------------------------------------
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

	// ---- business --------------------------------------------------------
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

	// ---- media -----------------------------------------------------------
	{
		id: "jellyfin",
		name: "Jellyfin",
		description: "Free software media system to stream your movies, shows and music.",
		category: "Media",
		color: "#aa5cc3",
		website: "https://jellyfin.org",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `jellyfin/jellyfin:${ctx.vars.version}`, 8096, {
				mounts: [
					volume(`${ctx.app}-config`, "/config"),
					volume(`${ctx.app}-cache`, "/cache"),
					volume(`${ctx.app}-media`, "/media"),
				],
			}),
		],
	},
	{
		id: "navidrome",
		name: "Navidrome",
		description: "Modern music server and streamer compatible with Subsonic clients.",
		category: "Media",
		color: "#0084ff",
		website: "https://www.navidrome.org",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `deluan/navidrome:${ctx.vars.version}`, 4533, {
				mounts: [volume(`${ctx.app}-data`, "/data"), volume(`${ctx.app}-music`, "/music")],
			}),
		],
	},
	{
		id: "minecraft",
		name: "Minecraft server",
		description: "Java Edition server. Publishes port 25565 directly on the server.",
		category: "Media",
		color: "#62b47a",
		website: "https://github.com/itzg/docker-minecraft-server",
		version: "latest",
		variables: [
			{ id: "mc_version", label: "Minecraft version", default: "LATEST" },
			{ id: "memory", label: "Server memory", default: "2G" },
		],
		services: (ctx) => [
			{
				name: ctx.app,
				image: `itzg/minecraft-server:${ctx.vars.version}`,
				service_type: "background_worker",
				port: 25565,
				expose_http: false,
				restart_policy: "always",
				env_vars: env({ EULA: "TRUE", VERSION: ctx.vars.mc_version, MEMORY: ctx.vars.memory }),
				mounts: [volume(`${ctx.app}-data`, "/data")],
				port_mappings: [{ host_port: 25565, container_port: 25565, protocol: "tcp" }],
			},
		],
		instructions: () => "Players connect to this server's IP on port 25565.",
	},

	// ---- ai --------------------------------------------------------------
	{
		id: "open-webui",
		name: "Open WebUI",
		description: "ChatGPT-style interface for Ollama and OpenAI-compatible APIs.",
		category: "AI",
		color: "#000000",
		website: "https://openwebui.com",
		version: "main",
		web: true,
		variables: [{ id: "secret", label: "Session secret", generate: "secret", secret: true }],
		services: (ctx) => [
			web(ctx, `ghcr.io/open-webui/open-webui:${ctx.vars.version}`, 8080, {
				env_vars: env({ WEBUI_SECRET_KEY: ctx.vars.secret }, ["WEBUI_SECRET_KEY"]),
				mounts: [volume(`${ctx.app}-data`, "/app/backend/data")],
			}),
		],
		instructions: () =>
			"The first account you create becomes the admin. Point it at an Ollama service in the same project.",
	},
	{
		id: "ollama",
		name: "Ollama",
		description: "Run Llama, Mistral, Gemma and other open models locally behind an API.",
		category: "AI",
		color: "#333333",
		website: "https://ollama.com",
		version: "latest",
		services: (ctx) => [
			internal(ctx.app, `ollama/ollama:${ctx.vars.version}`, 11434, {
				mounts: [volume(`${ctx.app}-models`, "/root/.ollama")],
			}),
		],
		instructions: (ctx) =>
			`Reach the API at http://${ctx.app}:11434 from the same project. Pull models from the Console tab: ollama pull llama3.2`,
	},
	{
		id: "flowise",
		name: "Flowise",
		description: "Build LLM apps and agents with a drag-and-drop UI.",
		category: "AI",
		color: "#4f46e5",
		website: "https://flowiseai.com",
		version: "latest",
		web: true,
		variables: [
			{ id: "admin_user", label: "Username", default: "admin" },
			adminPassword("Password"),
		],
		services: (ctx) => [
			web(ctx, `flowiseai/flowise:${ctx.vars.version}`, 3000, {
				env_vars: env(
					{ FLOWISE_USERNAME: ctx.vars.admin_user, FLOWISE_PASSWORD: ctx.vars.admin_password },
					["FLOWISE_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-data`, "/root/.flowise")],
			}),
		],
	},
	{
		id: "searxng",
		name: "SearXNG",
		description: "Privacy-respecting metasearch engine.",
		category: "AI",
		color: "#3050ff",
		website: "https://docs.searxng.org",
		version: "latest",
		web: true,
		variables: [{ id: "secret", label: "Secret key", generate: "secret", secret: true }],
		services: (ctx) => [
			web(ctx, `searxng/searxng:${ctx.vars.version}`, 8080, {
				env_vars: env(
					{
						SEARXNG_BASE_URL: ctx.url ? `${ctx.url}/` : undefined,
						SEARXNG_SECRET: ctx.vars.secret,
					},
					["SEARXNG_SECRET"],
				),
				mounts: [volume(`${ctx.app}-config`, "/etc/searxng")],
			}),
		],
	},

	// ---- other -----------------------------------------------------------
	{
		id: "kanidm",
		name: "Kanidm",
		description: "Identity management server with OAuth2/OIDC single sign-on, passkeys and LDAP.",
		category: "Other",
		color: "#ff7f2a",
		website: "https://kanidm.com",
		version: "1.11.2",
		web: true,
		needsDomain: true,
		tags: ["sso", "oidc", "oauth2", "ldap", "identity", "auth"],
		services: (ctx) => {
			// kanidm only serves https and its image has no shell, so a one-shot
			// worker writes a self-signed certificate into the shared data volume
			// and caddy forwards the proxy's plain http to kanidm's https port.
			const server = `${ctx.app}-server`;
			const certs = `${ctx.app}-certs`;
			const kanidmEnv = env({
				KANIDM_DOMAIN: ctx.domain,
				KANIDM_ORIGIN: ctx.url,
				KANIDM_BINDADDRESS: "0.0.0.0:8443",
				KANIDM_DB_PATH: "/data/kanidm.db",
				KANIDM_TLS_CHAIN: "/data/chain.pem",
				KANIDM_TLS_KEY: "/data/key.pem",
			});
			const data = { ...volume(`${ctx.app}-data`, "/data"), shared: true };
			const image = `kanidm/server:${ctx.vars.version}`;
			return [
				web(ctx, "caddy:2-alpine", 80, {
					command: [
						"caddy",
						"reverse-proxy",
						"--from",
						":80",
						"--to",
						`https://${server}:8443`,
						"--insecure",
					],
					depends_on: [server],
				}),
				internal(server, image, 8443, {
					env_vars: kanidmEnv,
					mounts: [data],
					depends_on: [certs],
				}),
				{
					name: certs,
					image,
					service_type: "background_worker",
					port: 0,
					expose_http: false,
					restart_policy: "on-failure",
					command: ["/sbin/kanidmd", "cert-generate"],
					env_vars: kanidmEnv,
					mounts: [data],
					notes:
						"Creates the self-signed certificate Kanidm serves internally, then exits. It keeps an existing certificate.",
				},
			];
		},
		instructions: (ctx) =>
			`Kanidm can take a few seconds to come up while its certificate is created. Then set the idm_admin password on the server: docker exec -it $(docker ps -qf name=-${ctx.app}-server-0-) kanidmd recover-account idm_admin. Sign in at ${ctx.url || "<url>"} as idm_admin. Keep the domain: changing it later breaks passkeys and OAuth2 clients.`,
	},
	{
		id: "nginx",
		name: "Static site (nginx)",
		description: "Serve static files with nginx. Upload files from the Storage tab.",
		category: "Other",
		color: "#009639",
		website: "https://nginx.org",
		version: "alpine",
		web: true,
		services: (ctx) => [
			web(ctx, `nginx:${ctx.vars.version}`, 80, {
				mounts: [volume(`${ctx.app}-html`, "/usr/share/nginx/html")],
			}),
		],
	},
	{
		id: "whoami",
		name: "whoami",
		description: "Tiny web server that echoes request details. Handy to test domains and HTTPS.",
		category: "Other",
		color: "#24a1c1",
		website: "https://github.com/traefik/whoami",
		version: "latest",
		web: true,
		services: (ctx) => [web(ctx, `traefik/whoami:${ctx.vars.version}`, 80)],
	},
];

/** a fresh random value in the variable's generated format */
export const generateValue = (variable: TemplateVariable): string => {
	if (variable.generate === "hex64") return randomHex(32);
	if (variable.generate === "laravel-key") return `base64:${randomBase64(32)}`;
	if (variable.generate === "password") return randomSecret(20);
	return randomSecret(40);
};

/** fills in generated defaults for a template's variables */
export const initialValues = (
	template: Template,
	ctx: Omit<TemplateContext, "vars">,
): Record<string, string> => {
	const values: Record<string, string> = { version: template.version ?? "latest" };
	for (const variable of template.variables ?? []) {
		if (variable.generate) values[variable.id] = generateValue(variable);
		else if (typeof variable.default === "function")
			values[variable.id] = variable.default({ ...ctx, vars: values });
		else values[variable.id] = variable.default ?? "";
	}
	return values;
};

const randomBytes = (length: number) => {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
};

const randomHex = (length: number) =>
	Array.from(randomBytes(length), (byte) => byte.toString(16).padStart(2, "0")).join("");

const randomBase64 = (length: number) => btoa(String.fromCharCode(...randomBytes(length)));

export const findTemplate = (id: string) => TEMPLATES.find((template) => template.id === id);
