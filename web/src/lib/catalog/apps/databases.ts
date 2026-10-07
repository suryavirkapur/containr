import { adminPassword, dbPassword, env, internal, volume, web } from "../helpers";
import type { Template } from "../types";

// databases apps
export const apps: Template[] = [
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
];
