import type { ConfigFileInput, EnvVarInput, MountInput, ServiceInput } from "../../api/platform";
import type { TemplateContext, TemplateVariable } from "./types";

// building blocks for one-click apps. simple apps combine these; apps with
// unusual needs (sidecars, init jobs, config files) can write their
// services by hand with the same ServiceInput shape.

export const env = (
	values: Record<string, string | undefined>,
	secretKeys: string[] = [],
): EnvVarInput[] =>
	Object.entries(values)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => ({ key, value: value ?? "", secret: secretKeys.includes(key) }));

export const web = (
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

export const internal = (
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

export const volume = (name: string, target: string) => ({ name, target });

export const dbPassword: TemplateVariable = {
	id: "db_password",
	label: "Database password",
	generate: "password",
	secret: true,
};

export const adminPassword = (label = "Admin password"): TemplateVariable => ({
	id: "admin_password",
	label,
	generate: "password",
	secret: true,
});

export const adminEmail: TemplateVariable = {
	id: "admin_email",
	label: "Admin email",
	placeholder: "you@example.com",
	required: true,
};

export const mariadb = (ctx: TemplateContext, database: string, user: string, version = "11") =>
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

export const mysql = (ctx: TemplateContext, database: string, user: string, version = "8.4") =>
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

export const postgres = (
	ctx: TemplateContext,
	database: string,
	user: string,
	version = "16-alpine",
) =>
	internal(`${ctx.app}-db`, `postgres:${version}`, 5432, {
		env_vars: env(
			{ POSTGRES_DB: database, POSTGRES_USER: user, POSTGRES_PASSWORD: ctx.vars.db_password },
			["POSTGRES_PASSWORD"],
		),
		mounts: [volume(`${ctx.app}-db-data`, "/var/lib/postgresql/data")],
	});

export const redis = (ctx: TemplateContext) =>
	internal(`${ctx.app}-redis`, "redis:7-alpine", 6379, {
		mounts: [volume(`${ctx.app}-redis-data`, "/data")],
	});

export const db = (ctx: TemplateContext) => `${ctx.app}-db`;

/** a volume shared by every service in the project that mounts `name` */
export const sharedVolume = (name: string, target: string): MountInput => ({
	name,
	target,
	shared: true,
});

/** a config file containr writes and mounts read-only at `path` */
export const file = (path: string, content: string): ConfigFileInput => ({ path, content });

/**
 * runs `script` with /bin/sh instead of the image's entrypoint, e.g. to run
 * migrations before the server. only for images that ship a shell.
 */
export const shell = (script: string): Pick<ServiceInput, "entrypoint" | "command"> => ({
	entrypoint: ["/bin/sh", "-c"],
	command: [script],
});

/** a job that runs once per deploy and exits (migrations, certificates) */
export const oneShot = (
	name: string,
	image: string,
	extra: Partial<ServiceInput> = {},
): ServiceInput => ({
	name,
	image,
	service_type: "background_worker",
	port: 0,
	expose_http: false,
	restart_policy: "on-failure",
	...extra,
});

export type CaddyUpstream = {
	/** e.g. http://app-api:8080 */
	upstream: string;
	/** proxy to an https upstream with a self-signed certificate */
	insecureTls?: boolean;
};

export type CaddyRoute = CaddyUpstream & {
	/** caddy path matchers: /exact, /prefix/* */
	paths: string[];
};

const caddyProxy = (target: CaddyUpstream, indent: string) =>
	target.insecureTls
		? `${indent}reverse_proxy ${target.upstream} {\n${indent}\ttransport http {\n${indent}\t\ttls_insecure_skip_verify\n${indent}\t}\n${indent}}`
		: `${indent}reverse_proxy ${target.upstream}`;

/** a caddyfile serving plain http on :80 that routes paths to upstreams */
export const caddyfile = (routes: CaddyRoute[], fallback: CaddyUpstream): string => {
	const handlers = routes.map(
		(route, index) =>
			`\t@route${index} path ${route.paths.join(" ")}\n\thandle @route${index} {\n${caddyProxy(route, "\t\t")}\n\t}`,
	);
	handlers.push(`\thandle {\n${caddyProxy(fallback, "\t\t")}\n\t}`);
	return [
		"{",
		"\tadmin off",
		"\tauto_https off",
		"\t# keep the client ip and scheme from containr's proxy",
		"\tservers {",
		"\t\ttrusted_proxies static private_ranges",
		"\t}",
		"}",
		"",
		":80 {",
		handlers.join("\n"),
		"}",
		"",
	].join("\n");
};

/**
 * the stack's public entry: caddy sends some paths to one service and the
 * rest to another, so a multi-service app shares one domain (and cookies).
 * containr's proxy terminates https in front of it.
 */
export const caddyRouter = (
	ctx: TemplateContext,
	routes: CaddyRoute[],
	fallback: CaddyUpstream,
	extra: Partial<ServiceInput> = {},
): ServiceInput =>
	web(ctx, "caddy:2-alpine", 80, {
		files: [file("/etc/caddy/Caddyfile", caddyfile(routes, fallback))],
		...extra,
	});
