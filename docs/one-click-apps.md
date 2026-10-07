# One-click apps

The catalog lives in `web/src/lib/catalog/`. Each app is a `Template`: some metadata, the questions to ask, and a `services(ctx)` function that returns the services to create. The deploy page creates them all in one project, so they share a network and reach each other by service name.

```
web/src/lib/catalog/
  types.ts         Template, TemplateVariable, TemplateContext, categories
  helpers.ts       building blocks (web, internal, postgres, file, caddyRouter, ...)
  apps/<category>.ts   simple apps, grouped by category
  apps/kanidm.ts, apps/ory.ts   hand-written stacks
  index.ts         the TEMPLATES list
  catalog.test.ts  checks every app expands to a valid stack
```

## Adding an app

1. Add a `Template` to the category file in `apps/`, or create a new file for a bigger stack and add it to `TEMPLATES` in `index.ts`.
2. Run `pnpm test` in `web/`. It expands every app and checks service names, dependencies, volumes, config files and that no variable came out `undefined`.
3. Deploy it once from the catalog and open it.

A simple app is a few lines:

```ts
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
```

## The context

`services(ctx)` gets:

- `ctx.app`: the project name the user picked (lowercase, DNS-safe). Name the main service `ctx.app` and the rest `${ctx.app}-<role>`.
- `ctx.domain` and `ctx.url`: the public domain and `https://` URL, or empty. Set `needsDomain: true` if the app can't work without one.
- `ctx.vars`: answers to `variables`, plus `version`. Variables with `generate` get a random value the user can still change; mark secrets with `secret: true`.

## Helpers

| Helper | Use |
| --- | --- |
| `web(ctx, image, port, extra)` | the public service, on `ctx.domain` |
| `internal(name, image, port, extra)` | a private service other services reach by name |
| `oneShot(name, image, extra)` | a job that runs once per deploy and exits (migrations, certificates) |
| `postgres`, `mariadb`, `mysql`, `redis` | a database service named `${ctx.app}-db` (or `-redis`) with a volume |
| `env(values, secretKeys)` | env vars; empty values are dropped, listed keys are stored as secrets |
| `volume(name, target)` | a persistent volume for one service |
| `sharedVolume(name, target)` | a volume every service mounting `name` shares, e.g. a certificate a job writes and a server reads |
| `file(path, content)` | a config file containr writes and mounts read-only, editable later in the Storage tab |
| `shell(script)` | run a shell script instead of the entrypoint, e.g. `migrate && exec serve` (images with `/bin/sh` only) |
| `caddyRouter(ctx, routes, fallback, extra)` | the public entry for a multi-service app: Caddy sends some paths to one service and everything else to another, so they share one domain and its cookies |

`extra` is any `ServiceInput` field: `env_vars`, `mounts`, `files`, `depends_on`, `command`, `additional_ports`, `port_mappings`, `notes`, and so on.

## Hand-written stacks

When an app doesn't fit a single container, write `services(ctx)` by hand. It's ordinary TypeScript, so put shared pieces in functions. Patterns that have worked:

- **Config files over shell tricks.** Mount YAML, JSON or a Caddyfile with `file()` instead of generating it in a `command`. It works with distroless images and users can edit it later. Keep secrets in `env()` with secret keys; most servers accept them as env vars that override the file.
- **Migrations before the server.** `shell("app migrate && exec app serve")` in images that have a shell. Database services start first (`depends_on`), and most servers retry their connection while it comes up.
- **One domain for several services.** Put `caddyRouter` in front and route API paths to the backend (see `apps/ory.ts`). An app with its own HTTPS can sit behind it with `insecureTls: true` (see `apps/kanidm.ts`).
- **Files one service writes and another reads.** Use `sharedVolume` with the same name in both, and a `oneShot` job for the writing.
- **Extra databases.** A file in `/docker-entrypoint-initdb.d/` on the Postgres service creates them on first start.

`depends_on` only orders startup; it doesn't wait for a service to be ready. Services that need another one should retry, or be restarted by their `restart_policy` until it is up.

Write `instructions` for anything the user must do after deploying, like creating the first admin.
